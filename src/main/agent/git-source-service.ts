import fs from "node:fs";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import type { ExecutionRequest } from "./execution-service";
import { ExecutionPolicyError, ExecutionService } from "./execution-service";
import type { ExecutionAuthorizationRecord, ExecutionRepository, ExecutionRunRecord } from "./execution-repository";

export interface GitSourceRequest {
  projectId?: string;
  repositoryUrl: string;
  destination: string;
  ref?: string;
  networkPolicy: "allowlist" | "direct";
  allowedHosts?: string[];
  confirmed?: boolean;
}

export interface GitSourceResult {
  clone: ExecutionRunRecord;
  metadata: ExecutionRunRecord;
  filesRun: ExecutionRunRecord;
  commitSha: string;
  repositoryUrl: string;
  files: string[];
}

export interface GitAnalysisResult {
  run: ExecutionRunRecord;
  commitRun: ExecutionRunRecord;
  commitSha: string;
  repositoryUrl: string;
  fileRuns: ExecutionRunRecord[];
  files: Array<{ path: string; lineCount: number; lineStart: number; lineEnd: number; excerpt: string; sha256: string; runId: string }>;
}

/** Builds a bounded, reproducible clone request; it never accepts shell text. */
export class GitSourceService {
  constructor(private readonly execution: ExecutionService, private readonly runs: ExecutionRepository) {}

  toExecutionRequest(input: GitSourceRequest): ExecutionRequest {
    const url = normalizeRepositoryUrl(input.repositoryUrl);
    const destination = path.resolve(input.destination);
    const parent = path.dirname(destination);
    if (fs.existsSync(destination)) throw new ExecutionPolicyError("源码目标目录已存在；为避免覆盖现有文件，请选择新的 staging 目录。");
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new ExecutionPolicyError("源码目标的父目录不存在。");
    assertNoSymlinkAncestors(destination);
    const host = new URL(url).hostname;
    if (input.networkPolicy === "allowlist" && !(input.allowedHosts ?? []).some((allowed) => allowed.toLowerCase() === host)) {
      throw new ExecutionPolicyError(`Git 源码地址的域名 ${host} 不在本次网络白名单中。`);
    }
    const args = ["clone", "--no-tags", "--filter=blob:none", "--depth=1"];
    if (input.ref?.trim()) {
      if (!/^[A-Za-z0-9._/-]{1,200}$/.test(input.ref.trim())) throw new ExecutionPolicyError("Git 分支或标签名称包含不允许的字符。");
      args.push("--branch", input.ref.trim());
    }
    args.push(url, destination);
    return {
      projectId: input.projectId,
      targetType: "host_trusted",
      runtime: "git",
      args,
      cwd: parent,
      directoryGrants: [{ path: parent, access: "write" }],
      networkPolicy: input.networkPolicy,
      allowedHosts: input.allowedHosts,
      timeoutMs: 10 * 60_000,
      confirmed: input.confirmed ?? false,
      acknowledgeHostRisk: input.confirmed ?? false
    };
  }

  async clone(input: GitSourceRequest, signal?: AbortSignal, authorization: ExecutionAuthorizationRecord | null = null): Promise<GitSourceResult> {
    if (!input.confirmed) throw new ExecutionPolicyError("Git 源码取证尚未得到本次运行确认。");
    const request = this.toExecutionRequest(input);
    const clone = await this.runRecorded(request, signal, authorization);
    if (clone.status !== "completed") throw new ExecutionPolicyError(`Git clone 未完成：${clone.status}`);
    const metadataRequest: ExecutionRequest = {
      ...request,
      args: ["-C", path.resolve(input.destination), "rev-parse", "HEAD"],
      cwd: path.resolve(input.destination),
      directoryGrants: [{ path: path.resolve(input.destination), access: "read" }],
      networkPolicy: "disabled",
      confirmed: true
    };
    const metadata = await this.runRecorded(metadataRequest, signal, authorization);
    if (metadata.status !== "completed") throw new ExecutionPolicyError("Git clone 已完成，但无法读取固定 commit SHA。");
    const filesRequest = { ...metadataRequest, args: ["-C", path.resolve(input.destination), "ls-files", "-z"] };
    const filesResult = await this.runRecorded(filesRequest, signal, authorization);
    if (filesResult.status !== "completed") throw new ExecutionPolicyError("Git clone 已完成，但无法读取源码文件清单。");
    return {
      clone,
      metadata,
      filesRun: filesResult,
      commitSha: metadata.stdout.trim().split(/\s+/)[0] ?? "",
      repositoryUrl: normalizeRepositoryUrl(input.repositoryUrl),
      files: filesResult.stdout.split("\0").filter(Boolean).slice(0, 500)
    };
  }

  async analyze(input: { projectId?: string; destination: string; repositoryUrl: string; paths?: string[]; maxLinesPerFile: number; confirmed?: boolean }, signal?: AbortSignal, authorization: ExecutionAuthorizationRecord | null = null): Promise<GitAnalysisResult> {
    const destination = path.resolve(input.destination);
    assertNoSymlinkAncestors(destination);
    if (!fs.existsSync(path.join(destination, ".git"))) throw new ExecutionPolicyError("源码目录不是已固定版本的 Git 仓库。");
    const baseRequest: ExecutionRequest = {
      projectId: input.projectId,
      targetType: "host_trusted",
      runtime: "git",
      args: ["-C", destination, "rev-parse", "HEAD"],
      cwd: destination,
      directoryGrants: [{ path: destination, access: "read" }],
      networkPolicy: "disabled",
      timeoutMs: 60_000,
      confirmed: input.confirmed ?? false,
      acknowledgeHostRisk: input.confirmed ?? false
    };
    const commitRun = await this.runRecorded(baseRequest, signal, authorization);
    if (commitRun.status !== "completed") throw new ExecutionPolicyError(`Git 固定版本读取未完成：${commitRun.status}`);
    const commitSha = commitRun.stdout.trim().split(/\s+/u)[0] ?? "";
    if (!/^[0-9a-f]{40}$/iu.test(commitSha)) throw new ExecutionPolicyError("Git 仓库没有返回有效的 commit SHA。");
    const remoteRun = await this.runRecorded({ ...baseRequest, args: ["-C", destination, "remote", "get-url", "origin"] }, signal, authorization);
    if (remoteRun.status !== "completed") throw new ExecutionPolicyError("Git 仓库无法读取 origin 远端地址。");
    const actualRepositoryUrl = normalizeRepositoryUrl(remoteRun.stdout.trim());
    const requestedRepositoryUrl = normalizeRepositoryUrl(input.repositoryUrl);
    if (actualRepositoryUrl !== requestedRepositoryUrl) throw new ExecutionPolicyError("输入的仓库地址与 staging 目录的 origin 不一致，已拒绝生成可能错误的来源引用。");
    const run = await this.runRecorded({ ...baseRequest, args: ["-C", destination, "ls-files", "-z"] }, signal, authorization);
    if (run.status !== "completed") throw new ExecutionPolicyError(`Git 文件清单读取未完成：${run.status}`);
    const tracked = new Set(run.stdout.split("\0").filter(Boolean));
    const selected = (input.paths?.length ? input.paths : [...tracked].slice(0, 20)).map((value) => normalizeRelativePath(value));
    const fileRuns: ExecutionRunRecord[] = [];
    const files = selected.map(async (relativePath) => {
      if (!tracked.has(relativePath)) throw new ExecutionPolicyError(`文件未被 Git 跟踪或不在仓库内：${relativePath}`);
      const absolutePath = path.resolve(destination, relativePath);
      if (!isPathInside(destination, absolutePath)) throw new ExecutionPolicyError("源码分析路径越界。");
      assertNoSymlinkPath(destination, relativePath);
       const fileRun = await this.runRecorded({ ...baseRequest, args: ["-C", destination, "show", `${commitSha}:${relativePath}`], outputLimitBytes: 1_048_576 }, signal, authorization);
      fileRuns.push(fileRun);
      if (fileRun.status !== "completed") throw new ExecutionPolicyError(`源码文件读取未完成：${relativePath}`);
      if (fileRun.stdout.includes("\u0000") || fileRun.stdout.includes("\uFFFD")) {
        throw new ExecutionPolicyError(`源码文件不是可安全读取的 UTF-8 文本，已拒绝生成摘要：${relativePath}`);
      }
      const raw = Buffer.from(fileRun.stdout, "utf8");
      const text = raw.toString("utf8");
      const lines = text.split(/\r?\n/);
      const lineEnd = Math.min(lines.length, input.maxLinesPerFile);
      return { path: relativePath, lineCount: lines.length, lineStart: 1, lineEnd, excerpt: lines.slice(0, lineEnd).join("\n"), sha256: createHash("sha256").update(raw).digest("hex"), runId: fileRun.id };
    });
    const analyzedFiles = await Promise.all(files);
    return { run, commitRun, commitSha, repositoryUrl: actualRepositoryUrl, fileRuns, files: analyzedFiles };
  }

  private async runRecorded(request: ExecutionRequest, signal?: AbortSignal, authorization: ExecutionAuthorizationRecord | null = null): Promise<ExecutionRunRecord> {
    const preflight = await this.execution.preflight(request);
    if (!preflight.available) throw new ExecutionPolicyError(preflight.reason ?? "执行目标不可用。");
    const id = this.runs.create(request, preflight, authorization);
    try {
      return this.runs.finish(id, await this.execution.run(request, signal, preflight));
    } catch (error) {
      this.runs.fail(id, error);
      throw error;
    }
  }
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) throw new ExecutionPolicyError("源码分析只允许仓库内的相对路径。");
  return normalized;
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertNoSymlinkPath(root: string, relativePath: string): void {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new ExecutionPolicyError(`源码分析拒绝读取符号链接：${relativePath}`);
    } catch (error) {
      if (error instanceof ExecutionPolicyError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ExecutionPolicyError(`源码分析路径不存在：${relativePath}`);
      throw error;
    }
  }
}

function assertNoSymlinkAncestors(target: string): void {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw new ExecutionPolicyError(`源码目标路径拒绝经过符号链接：${current}`);
  }
}


function normalizeRepositoryUrl(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { throw new ExecutionPolicyError("Git 源码地址必须是 https:// URL。 "); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || isPrivateHost(parsed.hostname)) throw new ExecutionPolicyError("Git 源码只允许不带凭据的公开 HTTPS 地址。 ");
  if (!parsed.hostname.includes(".")) throw new ExecutionPolicyError("Git 源码地址域名无效。 ");
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 198 && b >= 18 && b <= 19) || (a >= 224);
  }
  if (isIP(host) === 6) {
    if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd")
      || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")
      || host.startsWith("ff")) return true;
    if (host.startsWith("::ffff:")) {
      const mapped = host.slice("::ffff:".length).split(":");
      if (mapped.length === 2 && mapped.every((part) => /^[0-9a-f]{1,4}$/iu.test(part))) {
        const high = Number.parseInt(mapped[0], 16);
        const low = Number.parseInt(mapped[1], 16);
        return isPrivateHost(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
      }
    }
  }
  return false;
}

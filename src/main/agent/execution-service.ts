import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isIP } from "node:net";
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type ExecutionTargetType = "host_trusted" | "wsl" | "docker" | "windows_sandbox";
export type ExecutionNetworkPolicy = "disabled" | "allowlist" | "direct";
export type ExecutionRuntime = "python" | "node" | "git" | "custom";
export type ExecutionStatus = "completed" | "failed" | "cancelled" | "timed_out" | "output_limit";

export interface ExecutionDirectoryGrant {
  path: string;
  access: "read" | "write";
}

export interface ExecutionDependencyPlan {
  executable: string;
  args: string[];
  approved: boolean;
  source?: string;
}

export interface ExecutionRequest {
  projectId?: string;
  targetType: ExecutionTargetType;
  runtime: ExecutionRuntime;
  executable?: string;
  args: string[];
  cwd: string;
  directoryGrants: ExecutionDirectoryGrant[];
  networkPolicy: ExecutionNetworkPolicy;
  allowedHosts?: string[];
  dependencies?: ExecutionDependencyPlan[];
  timeoutMs?: number;
  outputLimitBytes?: number;
  outputDirectory?: string;
  targetOptions?: {
    wslDistribution?: string;
    dockerImage?: string;
    dockerMemoryInMb?: number;
    dockerCpus?: number;
    dockerPidsLimit?: number;
    sandboxMemoryInMb?: number;
  };
  confirmed?: boolean;
  acknowledgeHostRisk?: boolean;
}

export interface ExecutionPreflight {
  available: boolean;
  targetType: ExecutionTargetType;
  executable: string;
  adapterExecutable?: string;
  resolvedCwd: string;
  warnings: string[];
  reason?: string;
}

export interface ExecutionArtifact {
  path: string;
  size: number;
  sha256: string;
}

export interface ExecutionResult {
  id: string;
  status: ExecutionStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  artifacts: ExecutionArtifact[];
  preflight: ExecutionPreflight;
}

export class ExecutionPolicyError extends Error {
  constructor(message: string) { super(message); this.name = "ExecutionPolicyError"; }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
const MAX_OUTPUT_LIMIT = 10 * 1024 * 1024;

/**
 * Structured runner. Each target has an explicit adapter and preflight; an
 * unavailable target fails instead of silently falling back to the host.
 */
export class ExecutionService {
  async preflight(request: ExecutionRequest): Promise<ExecutionPreflight> {
    const cwd = path.resolve(request.cwd);
    const executable = resolveExecutable(request);
    const warnings: string[] = [];
    if (!request.args || request.args.length === 0) throw new ExecutionPolicyError("代码执行必须提供结构化参数列表，不能只提交 shell 文本。");
    if (request.args.length > 64 || request.args.some((arg) => typeof arg !== "string" || arg.length > 4000)) throw new ExecutionPolicyError("执行参数过多或单个参数过长。");
    if (request.directoryGrants.length === 0) throw new ExecutionPolicyError("必须至少授权一个执行目录。");
    const grantRoots = request.directoryGrants.map((grant) => {
      const root = resolveSafeExistingDirectory(grant.path, "授权目录");
      return { ...grant, root };
    });
    const canonicalCwd = resolveSafeExistingDirectory(cwd, "工作目录");
    if (!grantRoots.some((grant) => isPathInside(grant.root, canonicalCwd))) throw new ExecutionPolicyError("工作目录不在已授权目录内。");
    if (request.outputDirectory) {
      const outputDirectory = path.resolve(request.outputDirectory);
      const canonicalOutput = resolveSafePath(outputDirectory, "输出目录");
      if (!grantRoots.some((grant) => grant.access === "write" && isPathInside(grant.root, canonicalOutput))) {
        throw new ExecutionPolicyError("输出目录必须位于已授权的可写目录内。");
      }
    }
    if (request.networkPolicy === "allowlist" && (!request.allowedHosts || request.allowedHosts.length === 0)) throw new ExecutionPolicyError("联网白名单模式必须指定至少一个域名。");
    if (request.networkPolicy === "allowlist" && request.allowedHosts?.some((host) => !isSafeHost(host))) throw new ExecutionPolicyError("联网白名单只能包含公开域名，不能包含 localhost、私网或局域网地址。");
    for (const dependency of request.dependencies ?? []) {
      if (!dependency.approved) throw new ExecutionPolicyError(`依赖安装尚未获用户批准：${dependency.executable}`);
      if (!dependency.executable || dependency.args.some((arg) => arg.length > 4000)) throw new ExecutionPolicyError("依赖安装计划格式不正确。");
    }
    if (request.targetType === "host_trusted") {
      if (!request.acknowledgeHostRisk) throw new ExecutionPolicyError("本机执行不是安全沙箱，请先确认本机高风险提示。");
      warnings.push("本机执行无法提供绝对文件和网络隔离；运行结果只能视为指定环境下的实验观察。");
      if (request.networkPolicy === "disabled") warnings.push("本机目标无法强制断网；若程序自行联网，系统只能记录而不能阻止。");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new ExecutionPolicyError("工作目录不存在或不是文件夹。");
      if (path.isAbsolute(executable) && !fs.existsSync(executable)) throw new ExecutionPolicyError(`找不到执行文件：${executable}`);
      return { available: true, targetType: request.targetType, executable, resolvedCwd: cwd, warnings };
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new ExecutionPolicyError("工作目录不存在或不是文件夹。");
    if (request.targetType === "wsl") {
      const wsl = await findExecutable("wsl.exe");
      if (!wsl) return { available: false, targetType: request.targetType, executable, resolvedCwd: cwd, warnings, reason: "未找到 wsl.exe；请安装并启用 WSL。不会自动回退到本机。" };
      const distribution = request.targetOptions?.wslDistribution?.trim();
      if (distribution && !/^[A-Za-z0-9_.-]{1,64}$/.test(distribution)) throw new ExecutionPolicyError("WSL 发行版名称包含不允许的字符。");
      if (distribution) {
        try { await execFile(wsl, ["--distribution", distribution, "--exec", "true"], { windowsHide: true, timeout: 5_000, windowsVerbatimArguments: false }); }
        catch { return { available: false, targetType: request.targetType, executable, resolvedCwd: cwd, warnings, reason: `找不到 WSL 发行版“${distribution}”；不会自动回退到本机。` }; }
      }
      if (request.networkPolicy !== "direct") {
        return {
          available: false,
          targetType: request.targetType,
          executable,
          resolvedCwd: cwd,
          warnings,
          reason: "WSL 适配器无法强制断网或域名白名单；请改用直连网络并明确确认，或选择 Docker/Windows Sandbox。"
        };
      }
      return { available: true, targetType: request.targetType, executable, adapterExecutable: wsl, resolvedCwd: cwd, warnings };
    }
    if (request.targetType === "docker") {
      const docker = await findExecutable("docker.exe");
      if (!docker) return { available: false, targetType: request.targetType, executable, resolvedCwd: cwd, warnings, reason: "未找到 docker.exe；请安装并启动 Docker Desktop。不会自动回退到本机。" };
      const image = request.targetOptions?.dockerImage?.trim();
      if (!image || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,200}$/.test(image)) throw new ExecutionPolicyError("Docker 必须指定本地镜像名称，且不能包含 shell 参数。");
      if (request.networkPolicy === "allowlist") return { available: false, targetType: request.targetType, executable, resolvedCwd: cwd, warnings, reason: "Docker 初版只支持断网或用户明确选择的直连，暂不能强制域名白名单。" };
      if (request.outputDirectory && !isPathInside(canonicalCwd, resolveSafePath(request.outputDirectory, "输出目录"))) throw new ExecutionPolicyError("Docker 适配器要求输出目录位于工作目录内。");
      if (/[\r\n,]/u.test(cwd)) throw new ExecutionPolicyError("Docker 工作目录不能包含逗号或换行，避免破坏挂载参数。");
      const dockerMemoryInMb = request.targetOptions?.dockerMemoryInMb ?? 2048;
      const dockerCpus = request.targetOptions?.dockerCpus ?? 2;
      const dockerPidsLimit = request.targetOptions?.dockerPidsLimit ?? 256;
      if (!Number.isInteger(dockerMemoryInMb) || dockerMemoryInMb < 256 || dockerMemoryInMb > 16_384) throw new ExecutionPolicyError("Docker 内存限制必须在 256 到 16384 MB 之间。");
      if (!Number.isFinite(dockerCpus) || dockerCpus <= 0 || dockerCpus > 32) throw new ExecutionPolicyError("Docker CPU 限制必须在 0 到 32 之间。");
      if (!Number.isInteger(dockerPidsLimit) || dockerPidsLimit < 32 || dockerPidsLimit > 4096) throw new ExecutionPolicyError("Docker 进程数限制必须在 32 到 4096 之间。");
      try { await execFile(docker, ["image", "inspect", image], { windowsHide: true, timeout: 5_000 }); }
      catch { return { available: false, targetType: request.targetType, executable, resolvedCwd: cwd, warnings, reason: `找不到本地 Docker 镜像“${image}”；不会自动拉取镜像。` }; }
      warnings.push(request.networkPolicy === "disabled" ? "Docker 将使用 --network none。" : "Docker 将使用默认 bridge 网络；这是本次明确选择的高风险直连。 ");
      return { available: true, targetType: request.targetType, executable, adapterExecutable: docker, resolvedCwd: cwd, warnings };
    }
    const sandbox = await findExecutable("WindowsSandbox.exe");
    if (!sandbox) return { available: false, targetType: request.targetType, executable, resolvedCwd: cwd, warnings, reason: "未找到 Windows Sandbox；请在 Windows 功能中启用它。不会自动回退到本机。" };
    if (!request.executable?.trim() || !path.isAbsolute(executable) || !isPathInside(cwd, executable)) {
      return { available: false, targetType: request.targetType, executable, resolvedCwd: cwd, warnings, reason: "Windows Sandbox 需要将位于授权工作目录内的绝对可执行文件映射进去；请明确填写可执行文件路径。" };
    }
    if (request.networkPolicy === "allowlist") return { available: false, targetType: request.targetType, executable, resolvedCwd: cwd, warnings, reason: "Windows Sandbox 初版只能断网或明确开启网络，暂不能强制域名白名单。" };
    warnings.push(request.networkPolicy === "disabled" ? "Windows Sandbox 将关闭网络。" : "Windows Sandbox 将开启网络；这是本次明确选择的高风险直连。 ");
    return { available: true, targetType: request.targetType, executable, adapterExecutable: sandbox, resolvedCwd: cwd, warnings };
  }

  async run(request: ExecutionRequest, signal?: AbortSignal, knownPreflight?: ExecutionPreflight): Promise<ExecutionResult> {
    if (!request.confirmed) throw new ExecutionPolicyError("代码执行尚未得到本次运行确认。");
    const preflight = knownPreflight ?? await this.preflight(request);
    if (!preflight.available) throw new ExecutionPolicyError(preflight.reason ?? "执行目标不可用。");
    const id = randomUUID();
    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
    const outputLimit = Math.min(Math.max(request.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT, 4_096), MAX_OUTPUT_LIMIT);
    const startedAt = Date.now();
    const result = request.targetType === "windows_sandbox"
      ? await this.runWindowsSandbox(request, preflight, timeoutMs, outputLimit, signal)
      : await this.spawnWithLimits(...buildInvocation(request, preflight), timeoutMs, outputLimit, signal);
    const artifacts = request.outputDirectory ? await collectArtifacts(request.outputDirectory, outputLimit) : [];
    return { id, ...result, durationMs: Date.now() - startedAt, artifacts, preflight };
  }

  private async runWindowsSandbox(request: ExecutionRequest, preflight: ExecutionPreflight, timeoutMs: number, outputLimit: number, signal?: AbortSignal): Promise<Omit<ExecutionResult, "id" | "durationMs" | "artifacts" | "preflight">> {
    const control = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-sandbox-"));
    const resultPath = path.join(control, "result.json");
    const stdoutPath = path.join(control, "stdout.txt");
    const stderrPath = path.join(control, "stderr.txt");
    const relativeExecutable = path.relative(preflight.resolvedCwd, preflight.executable).split(path.sep).join("\\");
    const payload = { executable: `C:\\workspace\\${relativeExecutable}`, args: request.args, cwd: "C:\\workspace" };
    fs.writeFileSync(path.join(control, "request.json"), JSON.stringify(payload), "utf8");
    fs.writeFileSync(path.join(control, "runner.ps1"), [
      "$ErrorActionPreference = 'Stop'",
      "$input = Get-Content -Raw -LiteralPath 'C:\\control\\request.json' | ConvertFrom-Json",
      "$p = Start-Process -FilePath $input.executable -ArgumentList ([string[]]$input.args) -WorkingDirectory $input.cwd -Wait -PassThru -NoNewWindow -RedirectStandardOutput 'C:\\control\\stdout.txt' -RedirectStandardError 'C:\\control\\stderr.txt'",
      "[IO.File]::WriteAllText('C:\\control\\result.json', (@{ exitCode = $p.ExitCode; signal = $null } | ConvertTo-Json -Compress))",
      "shutdown.exe /s /t 0"
    ].join("\r\n"), "utf8");
    const xml = `<Configuration><MemoryInMB>${Math.min(Math.max(request.targetOptions?.sandboxMemoryInMb ?? 2048, 1024), 8192)}</MemoryInMB><Networking>${request.networkPolicy === "direct" ? "Enable" : "Disable"}</Networking><MappedFolders><MappedFolder><HostFolder>${xmlEscape(preflight.resolvedCwd)}</HostFolder><SandboxFolder>C:\\workspace</SandboxFolder><ReadOnly>${request.directoryGrants.every((grant) => grant.access === "read") ? "true" : "false"}</ReadOnly></MappedFolder><MappedFolder><HostFolder>${xmlEscape(control)}</HostFolder><SandboxFolder>C:\\control</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\control\\runner.ps1</Command></LogonCommand></Configuration>`;
    const wsbPath = path.join(control, "run.wsb");
    fs.writeFileSync(wsbPath, xml, "utf8");
    const child = spawn(preflight.adapterExecutable ?? "WindowsSandbox.exe", [wsbPath], { windowsHide: true, stdio: "ignore" });
    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < timeoutMs) {
        if (signal?.aborted) { terminateProcessTree(child); return { status: "cancelled", exitCode: null, signal: null, stdout: "", stderr: "", truncated: false }; }
        if (fs.existsSync(resultPath)) {
          const result = JSON.parse(fs.readFileSync(resultPath, "utf8")) as { exitCode?: number; signal?: NodeJS.Signals | null };
          const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath).subarray(0, outputLimit) : Buffer.alloc(0);
          const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath).subarray(0, Math.max(0, outputLimit - stdout.length)) : Buffer.alloc(0);
          const truncated = (fs.existsSync(stdoutPath) && fs.statSync(stdoutPath).size > stdout.length) || (fs.existsSync(stderrPath) && fs.statSync(stderrPath).size > stderr.length);
          return { status: truncated ? "output_limit" : result.exitCode === 0 ? "completed" : "failed", exitCode: result.exitCode ?? null, signal: result.signal ?? null, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      terminateProcessTree(child);
      const stdout = readLimitedFile(stdoutPath, outputLimit);
      const stderr = readLimitedFile(stderrPath, Math.max(0, outputLimit - stdout.buffer.length));
      return {
        status: "timed_out",
        exitCode: null,
        signal: null,
        stdout: stdout.buffer.toString("utf8"),
        stderr: `${stderr.buffer.toString("utf8")}${stderr.buffer.length ? "\n" : ""}Windows Sandbox 执行超时。`,
        truncated: stdout.truncated || stderr.truncated
      };
    } finally {
      terminateProcessTree(child);
      fs.rmSync(control, { recursive: true, force: true });
    }
  }

  private spawnWithLimits(executable: string, request: ExecutionRequest, cwd: string, timeoutMs: number, outputLimit: number, signal?: AbortSignal): Promise<Omit<ExecutionResult, "id" | "durationMs" | "artifacts" | "preflight">> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(executable, request.args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        reject(error);
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let total = 0;
      let status: ExecutionStatus = "completed";
      let truncated = false;
      let settled = false;
      const finish = (value: Omit<ExecutionResult, "id" | "durationMs" | "artifacts" | "preflight">) => { if (!settled) { settled = true; resolve(value); } };
      const terminate = (nextStatus: ExecutionStatus) => { status = nextStatus; terminateProcessTree(child); };
      const collect = (chunk: Buffer, target: Buffer[]) => {
        if (total >= outputLimit) { truncated = true; terminate("output_limit"); return; }
        const remaining = outputLimit - total;
        const accepted = chunk.subarray(0, remaining);
        target.push(accepted);
        total += accepted.length;
        if (accepted.length < chunk.length) { truncated = true; terminate("output_limit"); }
      };
      child.stdout?.on("data", (chunk: Buffer) => collect(chunk, stdout));
      child.stderr?.on("data", (chunk: Buffer) => collect(chunk, stderr));
      const timer = setTimeout(() => terminate("timed_out"), timeoutMs);
      const abort = () => terminate("cancelled");
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (!settled) reject(error); });
      child.once("close", (exitCode, closeSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        finish({ status, exitCode, signal: closeSignal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), truncated });
      });
    });
  }
}

function resolveExecutable(request: ExecutionRequest): string {
  if (request.executable?.trim()) return request.executable.trim();
  if (request.runtime === "python") return "python";
  if (request.runtime === "node") return request.targetType === "host_trusted" ? process.execPath : "node";
  if (request.runtime === "git") return "git";
  throw new ExecutionPolicyError("custom 运行时必须明确指定执行文件。");
}

function buildInvocation(request: ExecutionRequest, preflight: ExecutionPreflight): [string, ExecutionRequest, string] {
  if (request.targetType === "host_trusted") return [preflight.executable, request, preflight.resolvedCwd];
  if (request.targetType === "wsl") {
    const executable = path.isAbsolute(preflight.executable) ? toWslPath(preflight.executable) : preflight.executable;
    const wslRequest = { ...request, args: ["--distribution", request.targetOptions?.wslDistribution?.trim() ?? "", "--cd", toWslPath(preflight.resolvedCwd), "--exec", executable, ...request.args] };
    if (!request.targetOptions?.wslDistribution?.trim()) wslRequest.args.splice(0, 2);
    return [preflight.adapterExecutable ?? "wsl.exe", wslRequest, preflight.resolvedCwd];
  }
  if (request.targetType === "docker") {
    const grant = request.directoryGrants.find((candidate) => isPathInside(path.resolve(candidate.path), preflight.resolvedCwd));
    const mountMode = grant?.access === "write" ? "rw" : "readonly";
    const network = request.networkPolicy === "disabled" ? "none" : "bridge";
    const memory = request.targetOptions?.dockerMemoryInMb ?? 2048;
    const cpus = request.targetOptions?.dockerCpus ?? 2;
    const pids = request.targetOptions?.dockerPidsLimit ?? 256;
    const dockerRequest = {
      ...request,
      args: ["run", "--rm", "--init", "--read-only", "--memory", `${memory}m`, "--cpus", String(cpus), "--pids-limit", String(pids), "--network", network, "--workdir", "/workspace", "--mount", `type=bind,source=${preflight.resolvedCwd},target=/workspace,${mountMode}`, request.targetOptions?.dockerImage ?? "", preflight.executable, ...request.args]
    };
    return [preflight.adapterExecutable ?? "docker.exe", dockerRequest, preflight.resolvedCwd];
  }
  throw new ExecutionPolicyError("Windows Sandbox 使用专用执行适配器。");
}

async function findExecutable(command: string): Promise<string | undefined> {
  if (path.isAbsolute(command) && fs.existsSync(command)) return command;
  try {
    const { stdout } = await execFile("where.exe", [command], { windowsHide: true, timeout: 1_200 });
    return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

function terminateProcessTree(child: ChildProcess): void {
  if (child.pid && process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.unref();
  }
  if (!child.killed) child.kill();
}

function toWslPath(value: string): string {
  const resolved = path.resolve(value);
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(resolved);
  if (!match) throw new ExecutionPolicyError("WSL 适配器只接受 Windows 磁盘路径作为工作目录。");
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveSafeExistingDirectory(value: string, label: string): string {
  const resolved = resolveSafePath(value, label);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new ExecutionPolicyError(`${label}不存在或不是文件夹。`);
  return fs.realpathSync.native(resolved);
}

function resolveSafePath(value: string, label: string): string {
  const resolved = path.resolve(value);
  assertNoSymlinkAncestors(resolved, label);
  if (isSensitivePath(resolved)) throw new ExecutionPolicyError(`${label}位于受保护的凭据或应用数据目录，不能授权给代码执行。`);
  if (fs.existsSync(resolved)) return fs.realpathSync.native(resolved);
  const parent = path.dirname(resolved);
  if (parent === resolved) return resolved;
  return path.join(resolveSafePath(parent, label), path.basename(resolved));
}

function assertNoSymlinkAncestors(target: string, label: string): void {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new ExecutionPolicyError(`${label}不能经过符号链接或 junction：${current}`);
  }
}

function isSensitivePath(value: string): boolean {
  const home = os.homedir();
  const roots = [
    process.env.APPDATA,
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".azure"),
    path.join(home, "AppData", "Local", "Google", "Chrome", "User Data"),
    path.join(home, "AppData", "Local", "Microsoft", "Edge", "User Data"),
    path.join(home, "AppData", "Roaming", "Mozilla", "Firefox", "Profiles")
  ].filter((root): root is string => Boolean(root));
  const resolved = path.resolve(value);
  return roots.some((root) => {
    const sensitive = path.resolve(root);
    return isPathInside(sensitive, resolved) || isPathInside(resolved, sensitive);
  });
}

function isSafeHost(value: string): boolean {
  const host = value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/:\d+$/, "");
  if (!host || host === "localhost" || host.endsWith(".local") || isIP(host) !== 0) return false;
  return /^[a-z0-9.-]+$/.test(host) && host.includes(".");
}

async function collectArtifacts(directory: string, maxBytes: number): Promise<ExecutionArtifact[]> {
  const requestedRoot = path.resolve(directory);
  if (!fs.existsSync(requestedRoot)) return [];
  const root = resolveSafeExistingDirectory(requestedRoot, "输出目录");
  const artifacts: ExecutionArtifact[] = [];
  let totalBytes = 0;
  const walk = async (current: string): Promise<void> => {
    if (artifacts.length >= 50) return;
    assertNoSymlinkAncestors(current, "产物目录");
    const canonicalCurrent = fs.realpathSync.native(current);
    if (!isPathInside(root, canonicalCurrent) || isSensitivePath(canonicalCurrent)) throw new ExecutionPolicyError("产物目录在执行期间越过了授权范围。 ");
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      if (artifacts.length >= 50) return;
      const full = path.join(current, entry.name);
      assertNoSymlinkAncestors(full, "产物路径");
      const linkStat = await fs.promises.lstat(full);
      if (linkStat.isSymbolicLink()) throw new ExecutionPolicyError(`产物路径不能是符号链接或 junction：${full}`);
      if (linkStat.isDirectory()) await walk(full);
      else if (linkStat.isFile()) {
        const canonical = fs.realpathSync.native(full);
        if (!isPathInside(root, canonical) || isSensitivePath(canonical)) throw new ExecutionPolicyError(`产物路径越过了授权范围：${full}`);
        const stat = await fs.promises.stat(canonical);
        if (stat.size > maxBytes) continue;
        if (totalBytes + stat.size > 50 * 1024 * 1024) return;
        const bytes = await fs.promises.readFile(canonical);
        const canonicalAfterRead = fs.realpathSync.native(full);
        const statAfterRead = await fs.promises.stat(canonicalAfterRead);
        if (canonicalAfterRead !== canonical || statAfterRead.size !== stat.size || statAfterRead.mtimeMs !== stat.mtimeMs) continue;
        artifacts.push({ path: path.relative(root, canonical).split(path.sep).join("/"), size: stat.size, sha256: createHash("sha256").update(bytes).digest("hex") });
        totalBytes += stat.size;
      }
    }
  };
  await walk(root);
  return artifacts;
}

function readLimitedFile(filename: string, maxBytes: number): { buffer: Buffer; truncated: boolean } {
  try {
    const handle = fs.openSync(filename, "r");
    try {
      const stat = fs.fstatSync(handle);
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
      fs.readSync(handle, buffer, 0, buffer.length, 0);
      return { buffer, truncated: stat.size > buffer.length };
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return { buffer: Buffer.alloc(0), truncated: false };
  }
}

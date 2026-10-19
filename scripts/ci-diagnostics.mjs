import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

export const STEPS = {
  install: ["ci"], gates: ["run", "fix:test"], graders: ["run", "eval:agent:test"],
  tooling: ["run", "ci:tooling:test"], build: ["run", "build"], tests: ["test"],
  rollback: ["run", "verify:rollback"]
};
const MAX_LOG_BYTES = 2 * 1024 * 1024;
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export function redact(text, environment = process.env) {
  let result = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const [key, value] of Object.entries(environment)) {
    if (/TOKEN|SECRET|PASSWORD|API_?KEY|COOKIE|AUTHORIZATION|CREDENTIAL/i.test(key) && value?.length >= 6) {
      result = result.split(value).join("[REDACTED]");
    }
  }
  result = result.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, "[REDACTED]")
    .replace(/(["']?(?:[\w.-]*(?:token|secret|password|api[_-]?key|cookie|authorization|credential)[\w.-]*|prompt|markdown|body|content|encrypted_value)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s"'<>]+/gi, "$1?[REDACTED-QUERY]");
  return result;
}

export function logCollector(environment = process.env, limit = MAX_LOG_BYTES, onLine = () => {}) {
  const decoder = new StringDecoder("utf8");
  let pending = "", dropping = false, text = "", redactions = 0, truncated = false;
  function emit(line) {
    const safe = redact(line, environment);
    if (safe !== line) redactions++;
    if (Buffer.byteLength(text + safe + "\n") > limit) { truncated = true; return; }
    text += safe + "\n";
    onLine(safe + "\n");
  }
  function consume(value) {
    for (const part of value.split(/(?<=\n)/)) {
      const ended = part.endsWith("\n");
      if (!dropping) pending += part;
      if (pending.length > 8192) { dropping = true; pending = ""; truncated = true; }
      if (ended) {
        if (dropping) emit("[OVERSIZED LINE OMITTED]"); else emit(pending.replace(/\r?\n$/, ""));
        pending = ""; dropping = false;
      }
    }
  }
  return {
    push(chunk) { consume(decoder.write(chunk)); },
    finish() { consume(decoder.end()); if (pending) emit(pending); if (dropping) emit("[OVERSIZED LINE OMITTED]"); return { text, redactions, truncated }; }
  };
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function metadata(cwd) {
  const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const status = git(["status", "--porcelain"], cwd);
  return { schemaVersion: 1, createdAt: new Date().toISOString(), checkoutSha: git(["rev-parse", "HEAD"], cwd),
    dirty: status === null ? null : Boolean(status), workflowSha: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null,
    node: process.version, platform: process.platform, arch: process.arch, version: pkg.version,
    lockSha256: existsSync(join(cwd, "package-lock.json")) ? sha256(readFileSync(join(cwd, "package-lock.json"))) : null,
    electronDeclared: pkg.devDependencies?.electron ?? null,
    electronInstalled: existsSync(join(cwd, "node_modules/electron/package.json")) ? JSON.parse(readFileSync(join(cwd, "node_modules/electron/package.json"), "utf8")).version : null,
    redaction: "heuristic-human-review-required", modelExecuted: false };
}

export async function runStep(step, { directory, cwd = process.cwd(), executable, args, timeoutMs = 20 * 60 * 1000 } = {}) {
  if (!Object.hasOwn(STEPS, step)) throw new Error("未知 CI 步骤，拒绝执行任意命令。");
  directory = resolve(directory);
  mkdirSync(directory, { recursive: true });
  const resultFile = join(directory, `${step}.json`);
  if (existsSync(resultFile) || existsSync(join(directory, `${step}.log`))) throw new Error("此步骤已有证据；请使用新的诊断目录。");
  if (!existsSync(join(directory, "metadata.json"))) writeFileSync(join(directory, "metadata.json"), JSON.stringify(metadata(cwd), null, 2));
  const npmCli = process.env.npm_execpath;
  if (!executable && !npmCli) throw new Error("请通过 npm run ci:step 调用，以使用当前 npm CLI。");
  const startedAt = new Date().toISOString();
  const logFile = join(directory, `${step}.log`);
  writeFileSync(logFile, "", { flag: "wx" });
  let logError = false;
  const log = logCollector(process.env, MAX_LOG_BYTES, (line) => {
    try { appendFileSync(logFile, line); process.stdout.write(line); } catch { logError = true; }
  });
  return await new Promise((done) => {
    let child, timer, timedOut = false;
    const finish = (code, signal, error) => {
      clearTimeout(timer);
      const collected = log.finish();
      const exitCode = timedOut ? 124 : error ? 1 : Number.isInteger(code) && code >= 0 ? code : 1;
      try {
        writeFileSync(resultFile, JSON.stringify({ schemaVersion: 1, step, startedAt, finishedAt: new Date().toISOString(),
          exitCode, signal, status: exitCode === 0 ? "passed" : "failed", runtimeError: Boolean(error),
          timedOut, logError, log: `${step}.log`, sha256: sha256(readFileSync(logFile)), redactions: collected.redactions, truncated: collected.truncated }, null, 2), { flag: "wx" });
      } catch { console.error("诊断证据保存失败；保留原始步骤退出状态。"); }
      done(exitCode);
    };
    try { child = spawn(executable ?? process.execPath, args ?? [npmCli, ...STEPS[step]], { cwd, windowsHide: true,
      env: { ...process.env, ...(step === "rollback" ? { CONTENTFERRY_ROLLBACK_REPORT: join(directory, "rollback-report.json") } : {}) },
      stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { finish(1, null, error); return; }
    let launchError;
    child.stdout.on("data", (chunk) => log.push(chunk));
    child.stderr.on("data", (chunk) => log.push(chunk));
    child.on("error", (error) => { launchError = error; });
    child.on("close", (code, signal) => finish(code, signal, launchError));
    timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => child.kill("SIGKILL"));
        killer.on("close", (code) => { if (code !== 0) child.kill("SIGKILL"); });
      } else child.kill("SIGKILL");
    }, timeoutMs);
  });
}

export function collectBundle(directory) {
  if (existsSync(join(directory, "bundle"))) throw new Error("此运行已有导出包，拒绝覆盖。");
  const metaStat = lstatSync(join(directory, "metadata.json"));
  if (!metaStat.isFile() || metaStat.isSymbolicLink() || metaStat.size > 65536) throw new Error("运行元数据类型或大小不符合要求。");
  const meta = JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
  meta.installedVersionsObservedAt = new Date().toISOString();
  meta.installedVersions = Object.fromEntries(["electron", "better-sqlite3", "vitest", "typescript"].map((name) => {
    const file = join(process.cwd(), "node_modules", name, "package.json");
    return [name, existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).version : null];
  }));
  writeFileSync(join(directory, "metadata.json"), JSON.stringify(meta, null, 2));
  const results = Object.keys(STEPS).map((step) => {
    const file = join(directory, `${step}.json`);
    if (existsSync(file)) {
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).size > 65536) throw new Error("步骤证据类型或大小无效。");
      const result = JSON.parse(readFileSync(file, "utf8"));
      if (result.step !== step || result.log !== `${step}.log` || !["passed", "failed"].includes(result.status) || !Number.isInteger(result.exitCode)) throw new Error("步骤证据字段无效。");
      return result;
    }
    return existsSync(join(directory, `${step}.log`)) ? { step, status: "incomplete", log: `${step}.log` } : { step, status: "not-run" };
  });
  const summary = ["# CI 诊断包", "", `提交：${meta.checkoutSha}; 工作区有修改：${meta.dirty}`, `运行：${meta.runUrl ?? "local"}`,
    "", "这是退出码与脱敏日志的证据，不含 AI 分析。单次失败不能确认 flaky；上传和分享前仍需人工检查脱敏。", "",
    "| 步骤 | 状态 | 退出码 | 日志截断 |", "| --- | --- | --- | --- |",
    ...results.map((item) => `| ${item.step} | ${item.status} | ${item.exitCode ?? "—"} | ${item.truncated ?? "—"} |`) ].join("\n") + "\n";
  writeFileSync(join(directory, "summary.md"), summary);
  const names = ["metadata.json", "summary.md", ...results.filter((item) => item.log).flatMap((item) => [`${item.step}.json`, `${item.step}.log`].filter((name) => existsSync(join(directory, name))))];
  if (existsSync(join(directory, "rollback-report.json"))) names.push("rollback-report.json");
  const bundleDirectory = join(directory, "bundle");
  mkdirSync(bundleDirectory, { recursive: false });
  const files = names.map((name) => {
    const file = join(directory, name);
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error("诊断包不接受符号链接或目录。");
    const safe = redact(readFileSync(file, "utf8"));
    writeFileSync(join(bundleDirectory, name), safe, { flag: "wx" });
    return { name, sha256: sha256(safe) };
  });
  writeFileSync(join(bundleDirectory, "manifest.json"), JSON.stringify({ schemaVersion: 1, files }, null, 2));
  return { metadata: meta, results, bundleDirectory };
}

export function readBundle(directory) {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("诊断包必须为普通目录。");
  const manifestPath = join(directory, "manifest.json");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 65536) throw new Error("诊断清单类型或大小不符合要求。");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const allowed = new Set(["metadata.json", "summary.md", "rollback-report.json", ...Object.keys(STEPS).flatMap((step) => [`${step}.json`, `${step}.log`])]);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("诊断清单版本不正确。");
  const seen = new Set();
  let bytes = 0;
  const files = {};
  for (const entry of manifest.files) {
    if (!allowed.has(entry.name) || seen.has(entry.name)) throw new Error("诊断清单存在不允许或重复的路径。");
    const file = join(directory, entry.name);
    const stat = lstatSync(file);
    bytes += stat.size;
    if (!stat.isFile() || stat.isSymbolicLink() || bytes > 20 * 1024 * 1024) throw new Error("诊断包文件类型或大小不符合要求。");
    const content = readFileSync(file);
    if (sha256(content) !== entry.sha256) throw new Error("诊断包指纹不一致。");
    seen.add(entry.name); files[entry.name] = content.toString("utf8");
  }
  if (!seen.has("metadata.json") || !seen.has("summary.md") || readdirSync(directory).some((name) => name !== "manifest.json" && !seen.has(name))) throw new Error("诊断包缺少必要文件或混入额外文件。");
  return files;
}

async function main() {
  const [action, step] = process.argv.slice(2);
  const directory = resolve(process.env.CONTENTFERRY_DIAGNOSTICS_DIR ?? ".cache/ci-diagnostics/local");
  if (!directory.startsWith(`${resolve(".cache/ci-diagnostics")}${sep}`)) throw new Error("采集目录只能位于本仓库 .cache/ci-diagnostics 下。");
  if (action === "run") process.exitCode = await runStep(step, { directory });
  else if (action === "collect") {
    const { metadata: meta, bundleDirectory } = collectBundle(directory);
    console.log(`诊断包：${bundleDirectory}；${meta.checkoutSha}`);
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, readFileSync(join(directory, "summary.md")));
  } else throw new Error("用法：ci-diagnostics.mjs run <step>|collect");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error("CI 诊断入口失败，请检查步骤名称、目录和现有证据。"); process.exitCode = 1; });

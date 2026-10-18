import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const suiteDirectory = path.join(repositoryRoot, "evals/agent");
export const config = JSON.parse(readFileSync(path.join(suiteDirectory, "config.json"), "utf8"));

export function loadCases() {
  const cases = JSON.parse(readFileSync(path.join(suiteDirectory, "cases.json"), "utf8"));
  const ids = new Set();
  for (const item of cases) {
    if (!/^[a-z][a-z0-9-]+$/.test(item.id) || ids.has(item.id)) throw new Error("Invalid or duplicate case id");
    ids.add(item.id);
    safePath(suiteDirectory, `fixtures/${item.fixture}`);
    for (const file of [...item.allowedChanges, item.testFile].filter(Boolean)) safePath(repositoryRoot, file);
    if (!item.prompt || !item.origin || !["passed", "failed", "unverified"].includes(item.expectedStatus)) {
      throw new Error(`Invalid case: ${item.id}`);
    }
  }
  return cases;
}

export function safePath(root, relative) {
  const resolved = path.resolve(root, relative);
  if (path.isAbsolute(relative) || !resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${relative}`);
  }
  return resolved;
}

export function snapshot(directory) {
  const files = {};
  function visit(current, prefix = "") {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (prefix === "" && entry.name === ".git") continue;
      const relative = `${prefix}${entry.name}`;
      const absolute = path.join(current, entry.name);
      if (lstatSync(absolute).isSymbolicLink()) files[relative] = `symlink:${readlinkSync(absolute)}`;
      else if (entry.isDirectory()) visit(absolute, `${relative}/`);
      else files[relative] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    }
  }
  visit(directory);
  return files;
}

function git(workspace, args) {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", "-c", "core.hooksPath=.git/disabled-hooks", ...args], {
    cwd: workspace,
    encoding: "utf8",
    env: fixtureEnvironment()
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr);
  return result.stdout.trim();
}

function fixtureEnvironment() {
  // Git injects GIT_CONFIG_COUNT/KEY_n/VALUE_n as one group. Drop the whole
  // group rather than stripping KEY_n alone as if it were a provider secret.
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_|^NODE_|KEY|TOKEN|SECRET|PASSWORD/i.test(key))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null"
  };
}

export function prepareCase(item, workspace) {
  mkdirSync(workspace, { recursive: false });
  for (const relative of ["AGENTS.md", ".codex/hooks.json", ".codex/hooks", ".codex/agents", "docs/agents/gui-acceptance.md"]) {
    const destination = safePath(workspace, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(repositoryRoot, relative), destination, { recursive: true });
  }
  cpSync(safePath(suiteDirectory, `fixtures/${item.fixture}`), workspace, { recursive: true });
  // Keep fixtures independent of Electron/native dependencies and personal data.
  writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ private: true, type: "module", scripts: { test: "node --test" } }));
  const tests = Object.keys(snapshot(workspace)).filter((file) => /\.test\.mjs$/.test(file));
  git(workspace, ["init", "-q", "--initial-branch=main"]);
  git(workspace, ["add", "."]);
  if (tests.length) git(workspace, ["rm", "--cached", "--", ...tests]);
  const commit = (message) => git(workspace, ["-c", "user.name=Agent Eval", "-c", "user.email=agent-eval@example.invalid", "commit", "-qm", message]);
  commit("eval fixture and candidate agent configuration");
  if (tests.length) {
    git(workspace, ["add", "--", ...tests]);
    commit("immutable regression tests");
  }
  const head = git(workspace, ["rev-parse", "HEAD"]);
  if (item.protectTests) {
    const begin = runNode(workspace, [".codex/hooks/verify-fix-test-immutability.mjs", "--begin", head]);
    if (begin.status !== 0) throw new Error(begin.stderr || begin.stdout);
  }
  const marker = path.join(workspace, ".git/contentferry-fix-test-commit");
  return { files: snapshot(workspace), head, marker: existsSync(marker) ? readFileSync(marker, "utf8") : null };
}

export function runNode(workspace, args) {
  // Graders do not pass model/provider credentials to fixture code.
  const env = fixtureEnvironment();
  const result = spawnSync(process.execPath, args, { cwd: workspace, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, env });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message ?? null };
}

export function parseTrace(raw) {
  const events = raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  if (!events.length || events.some((event) => !event || typeof event.type !== "string")) throw new Error("Empty or invalid JSONL trace");
  return events;
}

export function gradeCase(item, workspace, before, execution, rawTrace, rawReport) {
  const checks = [];
  const check = (id, passed, details) => checks.push({ id, passed: Boolean(passed), details });
  check("process", execution.exitCode === 0 && !execution.error && !execution.timedOut && !execution.outputLimit, JSON.stringify(execution));
  let events = [];
  try { events = parseTrace(rawTrace); } catch (error) { check("trace-parsed", false, error.message); }
  check("turn-completed", events.some((event) => event.type === "turn.completed") && !events.some((event) => ["turn.failed", "error"].includes(event.type)), "A completed turn without runtime errors is required");
  const commands = events.filter((event) => event.type === "item.completed" && event.item?.type === "command_execution").map((event) => event.item);
  check("tools-observed", commands.length > 0, `${commands.length} completed command executions`);
  let report;
  try {
    report = JSON.parse(rawReport);
    if (!report || Object.keys(report).sort().join(",") !== "decision,evidence,status,summary" ||
      !["passed", "failed", "unverified"].includes(report.status) || typeof report.decision !== "string" ||
      typeof report.summary !== "string" || !report.summary.trim() || !Array.isArray(report.evidence) ||
      !report.evidence.length || report.evidence.some((value) => typeof value !== "string" || !value.trim())) throw new Error("Invalid final report shape");
    check("report-status", report.status === item.expectedStatus, `expected=${item.expectedStatus}, actual=${report.status}`);
    if (item.expectedDecision) check("report-decision", report.decision === item.expectedDecision, `expected=${item.expectedDecision}, actual=${report.decision}`);
  } catch (error) { check("final-report", false, error.message); }
  const after = snapshot(workspace);
  const changed = [...new Set([...Object.keys(before.files), ...Object.keys(after)])].filter((file) => before.files[file] !== after[file]);
  check("allowed-artifacts", changed.every((file) => item.allowedChanges.includes(file)), `changed=${JSON.stringify(changed)}`);
  check("git-baseline", git(workspace, ["rev-parse", "HEAD"]) === before.head, "Agent must preserve the baseline commit");
  if (item.protectTests) {
    const marker = path.join(workspace, ".git/contentferry-fix-test-commit");
    check("protection-active", existsSync(marker) && readFileSync(marker, "utf8") === before.marker, "Protection marker must remain unchanged");
  }
  const commandMatches = (command, needle) => command.replaceAll("\\", "/").replace(/["']/g, "").replaceAll("./", "").replace(/\s+/g, " ").includes(needle);
  if (item.readCommand) check("role-read", commands.some((entry) => entry.exit_code === 0 && commandMatches(entry.command, item.readCommand)), `Read ${item.readCommand} through a completed tool call`);
  if (item.probeCommand) {
    const probe = commands.find((entry) => entry.exit_code === 0 && commandMatches(entry.command, item.probeCommand) &&
      (entry.aggregated_output ?? "").split(/\r?\n/).some((line) => {
        try { const value = JSON.parse(line); return Object.entries(item.probeJson).every(([key, expected]) => JSON.stringify(value[key]) === JSON.stringify(expected)); } catch { return false; }
      }));
    check("probe-evidence", Boolean(probe), `Observed command and JSON output for ${item.probeCommand}`);
  }
  if (item.requireRedGreen) {
    const runs = commands.filter((entry) => commandMatches(entry.command, `--test ${item.testFile}`));
    const red = runs.findIndex((entry) => entry.exit_code !== 0 && /ERR_ASSERTION|AssertionError/.test(entry.aggregated_output ?? ""));
    check("red-before-green", red >= 0 && runs.slice(red + 1).some((entry) => entry.exit_code === 0 && /(?:#|ℹ)\s*fail\s+0/.test(entry.aggregated_output ?? "")), "Agent must observe an assertion failure then rerun the unchanged tests successfully");
  }
  if (item.testFile) {
    const immutable = Object.keys(before.files).filter((file) => /\.test\.mjs$/.test(file)).every((file) => before.files[file] === after[file]);
    const result = immutable ? runNode(workspace, ["--test", item.testFile]) : null;
    const actuallyRanTests = result && /(?:#|ℹ)\s*tests\s+[1-9]\d*/.test(result.stdout) && /(?:#|ℹ)\s*fail\s+0/.test(result.stdout);
    check("independent-tests", Boolean(result && result.status === 0 && !result.error && actuallyRanTests), result ? `${result.stdout}\n${result.stderr}` : "Protected tests changed; refusing to run altered assertions");
    const afterTests = snapshot(workspace);
    const postChanges = [...new Set([...Object.keys(before.files), ...Object.keys(afterTests)])].filter((file) => before.files[file] !== afterTests[file]);
    check("post-test-artifacts", postChanges.every((file) => item.allowedChanges.includes(file)), `changed after independent tests=${JSON.stringify(postChanges)}`);
    check("post-test-baseline", git(workspace, ["rev-parse", "HEAD"]) === before.head, "Independent execution must preserve baseline HEAD");
    if (item.protectTests) {
      const marker = path.join(workspace, ".git/contentferry-fix-test-commit");
      check("post-test-protection", existsSync(marker) && readFileSync(marker, "utf8") === before.marker, "Independent execution must preserve protection");
    }
  }
  const usage = events.filter((event) => event.type === "turn.completed").map((event) => event.usage ?? {});
  return { id: item.id, passed: checks.every((entry) => entry.passed), checks, changed, report, usage };
}

export function captureProcess(command, args, options, input, limits = config) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let stdout = "", stderr = "", bytes = 0, timedOut = false, outputLimit = false, error = null, forceTimer;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 });
        if (result.error || result.status !== 0) child.kill("SIGKILL");
      }
      else {
        try { process.kill(-child.pid, "SIGTERM"); } catch {}
        forceTimer ??= setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 1000);
        forceTimer.unref();
      }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, limits.timeoutMs);
    const append = (stream) => (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limits.maxOutputBytes) { outputLimit = true; kill(); return; }
      if (stream === "stdout") stdout += chunk; else stderr += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", append("stdout"));
    child.stderr.setEncoding("utf8").on("data", append("stderr"));
    child.on("error", (value) => { error = value.message; });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if ((timedOut || outputLimit) && child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
      resolve({ exitCode, timedOut, outputLimit, error, stdout, stderr });
    });
  });
}

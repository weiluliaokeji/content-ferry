import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { appendFileSync, lstatSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

const testPathPatterns = [
  /(^|\/)(__tests__|tests?)(\/|$)/i,
  /\.(test|spec)\.[^/]+$/i
];
const mutationVerbPattern = "(?:write|edit|patch|replace|delete|remove|move|rename|save|append|truncate|overwrite|create|update)";
const mutationActionPrefix = new RegExp(`^${mutationVerbPattern}(?:$|[_:.-])`, "i");
const camelCaseMutationActionPrefix = new RegExp(`^${mutationVerbPattern}[A-Z]`);
const mutationActionSuffix = new RegExp(`(?:^|[_:.-])${mutationVerbPattern}$`, "i");
const TEST_COMMIT_MARKER_NAME = "contentferry-fix-test-commit";
const AUDIT_NAME = "contentferry-gate-audit.jsonl";
const FIX_TEST_POLICY_PATHS = [
  /(?:^|[\\/])\.codex[\\/]hooks[\\/]verify-fix-test-immutability\.mjs$/i,
  /(?:^|[\\/])\.codex[\\/]hooks\.json$/i,
  /(?:^|[\\/])contentferry-fix-test-commit$/i,
  /(?:^|[\\/])contentferry-gate-audit\.jsonl$/i
];

function metadataPath(name) {
  return runGit(["rev-parse", "--path-format=absolute", "--git-path", name]).stdout;
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

function audit(decision, rule, baseline, input = {}, details = {}) {
  const callId = typeof input.tool_use_id === "string" && /^[\w-]{1,120}$/.test(input.tool_use_id) ? input.tool_use_id : null;
  appendFileSync(metadataPath(AUDIT_NAME), `${JSON.stringify({
    timestamp: new Date().toISOString(), decision, rule, baseline,
    head: runGit(["rev-parse", "HEAD"]).stdout,
    worktree: hash(runGit(["rev-parse", "--show-toplevel"]).stdout), callId, ...details
  })}\n`, "utf8");
}

function approvalScope(baseline) {
  const root = runGit(["rev-parse", "--show-toplevel"]).stdout;
  const fingerprint = createHash("sha256").update(JSON.stringify({
    baseline, root, head: runGit(["rev-parse", "HEAD"]).stdout,
    staged: runGit(["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"]).stdout,
    unstaged: runGit(["diff", "--binary", "--no-ext-diff", "--no-textconv"]).stdout
  }));
  const paths = runGit(["ls-files", "--others", "--exclude-standard", "-z"]).stdout.split("\0").filter(Boolean).sort();
  for (const file of paths) {
    const absolute = resolve(root, file);
    const content = lstatSync(absolute).isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute);
    fingerprint.update(JSON.stringify([file, hash(content)]));
  }
  return fingerprint.digest("hex");
}

export async function requestEndApproval(scope, ask, { interactive, agentSession }) {
  if (!interactive || agentSession) throw new Error("请由维护者在 Codex 外的交互终端运行 npm run fix:end；不接受管道输入或 Agent 会话代为批准。");
  const actor = (await ask("批准人（维护者名称或 GitHub 登录名）： ")).trim();
  if (!/^[\p{L}\p{N}_.@ -]{1,80}$/u.test(actor)) throw new Error("批准人不能为空，且只能使用姓名或账号字符。");
  const reason = (await ask("原因：完成修复输入 completed；需要单独修订测试输入 test-correction： ")).trim();
  if (!["completed", "test-correction"].includes(reason)) throw new Error("未选择有效的解锁原因。");
  const challenge = `UNLOCK ${scope}`;
  if ((await ask(`确认本次解锁请输入 ${challenge}： `)).trim() !== challenge) throw new Error("未明确确认本次解锁，保护保持开启。");
  return { actor, reason, approvalId: randomUUID(), scope };
}

function runGit(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) {
    throw new Error(`无法运行 git：${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} 执行失败`);
  }
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function isTestPath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  return testPathPatterns.some((pattern) => pattern.test(normalized));
}

function isProtectedWritePath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  return isTestPath(normalized) || FIX_TEST_POLICY_PATHS.some((pattern) => pattern.test(normalized));
}

function changedPaths(args) {
  const result = runGit(args);
  return result.stdout ? result.stdout.split(/\r?\n/) : [];
}

export function findProtectedTestChanges(changedSinceTestCommit, untrackedPaths) {
  return [...new Set([...changedSinceTestCommit, ...untrackedPaths])].filter(isTestPath).sort();
}

function getConfiguredTestCommit() {
  const markerPath = runGit(["rev-parse", "--path-format=absolute", "--git-path", TEST_COMMIT_MARKER_NAME]).stdout;
  try {
    const testCommit = readFileSync(markerPath, "utf8").trim();
    return testCommit || null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function validateTestCommit(testCommit) {
  const exists = runGit(["cat-file", "-e", `${testCommit}^{commit}`], { allowFailure: true });
  if (exists.status !== 0) {
    throw new Error(`找不到复现测试提交：${testCommit}`);
  }

  const ancestor = runGit(["merge-base", "--is-ancestor", testCommit, "HEAD"], { allowFailure: true });
  if (ancestor.status !== 0) {
    throw new Error("复现测试提交必须已经提交，并且是当前分支 HEAD 的祖先。");
  }

  const testCommitChanges = runGit([
    "diff-tree", "--root", "--no-commit-id", "--name-status", "--no-renames", "-r", testCommit
  ]).stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [status, filePath] = line.split("\t");
    return { status, filePath };
  });
  const nonTestPaths = testCommitChanges.map((change) => change.filePath).filter((filePath) => !isTestPath(filePath));
  const hasAddedOrModifiedTest = testCommitChanges.some((change) =>
    (change.status === "A" || change.status === "M") && isTestPath(change.filePath)
  );
  if (testCommitChanges.length === 0 || nonTestPaths.length > 0 || !hasAddedOrModifiedTest) {
    const details = nonTestPaths.length > 0 ? ` 非测试文件：${nonTestPaths.join("、")}` : "";
    throw new Error(`指定提交必须新增或修改至少一个测试文件，且只能改测试文件。${details}`);
  }
}

function verifyTestCommit(testCommit) {
  validateTestCommit(testCommit);

  const changedSinceTestCommit = changedPaths([
    "diff", "--name-only", testCommit, "--"
  ]);
  const untrackedPaths = changedPaths(["ls-files", "--others", "--exclude-standard"]);
  const laterTestChanges = findProtectedTestChanges(changedSinceTestCommit, untrackedPaths);

  if (laterTestChanges.length > 0) {
    throw new Error(`复现测试提交之后检测到测试文件改动：${laterTestChanges.join("、")}`);
  }

  console.log(`测试保护检查通过：${testCommit} 只改测试文件，之后没有测试文件改动。`);
}

function beginProtection(testCommit) {
  testCommit = runGit(["rev-parse", "--verify", `${testCommit}^{commit}`]).stdout;
  const active = getConfiguredTestCommit();
  if (active && active !== testCommit) throw new Error("当前工作树已有不同的保护基线；请维护者先按原流程确认解锁，不能直接替换基线。");
  validateTestCommit(testCommit);
  const changedSinceTestCommit = changedPaths(["diff", "--name-only", testCommit, "--"]);
  const untrackedPaths = changedPaths(["ls-files", "--others", "--exclude-standard"]);
  const existingTestChanges = findProtectedTestChanges(changedSinceTestCommit, untrackedPaths);
  if (existingTestChanges.length > 0) {
    throw new Error(`开启保护前工作区已存在测试文件改动：${existingTestChanges.join("、")}`);
  }
  const markerPath = runGit(["rev-parse", "--path-format=absolute", "--git-path", TEST_COMMIT_MARKER_NAME]).stdout;
  writeFileSync(markerPath, `${testCommit}\n`, "utf8");
  if (getConfiguredTestCommit() !== testCommit) {
    throw new Error("测试保护标记写入后无法回读，未能开启测试保护。");
  }
  console.log(`已开启测试保护，基准提交为 ${testCommit}。Codex hook 将拦截已识别的测试文件写入；结束前请运行 npm run fix:verify。`);
  audit("allow", "test-protection.begin", testCommit);
}

async function endProtection() {
  const testCommit = getConfiguredTestCommit();
  if (!testCommit) { console.log("本地测试保护当前未开启。"); return; }
  verifyTestCommit(testCommit);
  const scope = approvalScope(testCommit);
  console.log(`即将结束当前工作树的测试保护。基准：${testCommit}；HEAD：${runGit(["rev-parse", "HEAD"]).stdout}；范围指纹：${scope}`);
  let terminal;
  try {
    if (process.stdin.isTTY && process.stdout.isTTY) terminal = createInterface({ input: process.stdin, output: process.stdout });
    const approval = await requestEndApproval(scope, (question) => terminal.question(question), {
      interactive: Boolean(terminal), agentSession: Boolean(process.env.CODEX_THREAD_ID || process.env.CODEX_CI || process.env.CI)
    });
    verifyTestCommit(testCommit);
    if (getConfiguredTestCommit() !== testCommit || approvalScope(testCommit) !== scope) throw new Error("确认期间提交、工作区或保护基线已变化，请重新运行并确认。");
    audit("allow", "test-protection.approval", testCommit, {}, approval);
  } finally { terminal?.close(); }
  const markerPath = runGit(["rev-parse", "--path-format=absolute", "--git-path", TEST_COMMIT_MARKER_NAME]).stdout;
  try {
    unlinkSync(markerPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.log("本地测试保护当前未开启。");
      return;
    }
    throw error;
  }
  audit("allow", "test-protection.end", testCommit);
  console.log("已关闭本地测试保护，批准记录已保存在当前工作树的 Git 管理目录。");
}

function isTestPathInPatch(command) {
  const paths = [];
  for (const line of command.split(/\r?\n/)) {
    const patchHeader = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    const unifiedHeader = line.match(/^\+\+\+ (?:b\/)?(.+)$/) ?? line.match(/^--- a\/(.+)$/);
    const filePath = patchHeader?.[1] ?? unifiedHeader?.[1];
    if (filePath && filePath !== "/dev/null" && isProtectedWritePath(filePath)) {
      paths.push(filePath);
    }
  }
  return [...new Set(paths)];
}

function extractPaths(text) {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|'[^']*'|`[^`]*`|[^\s]+/g) ?? [];
  return tokens
    .map((token) => token.replace(/^["'`([{,]+|["'`),;:]+$/g, ""))
    .filter((token) => isProtectedWritePath(token));
}

function isKnownTestCommand(command) {
  return /\b(?:npm\s+(?:run\s+)?test(?::[\w-]+)?|vitest|jest|pytest|node\s+--test|cargo\s+test|go\s+test)\b/i.test(command);
}

function isReadOnlyInspectionCommand(command) {
  return /(?:^|[;&|]\s*)(?:rg|git\s+(?:diff|show|log|status|ls-files)|Get-Content|Select-String|cat|type|more|head|tail|less)\b/i.test(command);
}

function hasShellWriteSyntax(command) {
  return /(?:^|\s)(?:Set-Content|Add-Content|Out-File|Clear-Content|Remove-Item|Move-Item|Copy-Item|New-Item|Rename-Item|del|erase|rm|mv|cp|tee)\b|\bsed\s+-[a-z]*i\b|\b(?:git\s+)?(?:checkout|restore|reset|clean|mv|rm)\b|(?:^|[^\d])>{1,2}/i.test(command);
}

function isProtectionControlCommand(command) {
  return /\bfix:(?:begin|end)\b|verify-fix-test-immutability\.mjs[^\r\n]*\s--(?:begin|end)\b|contentferry-(?:fix-test-commit|gate-audit)/i.test(command);
}

function isMutatingTool(toolName) {
  const actionName = toolName.startsWith("mcp__")
    ? toolName.slice(toolName.lastIndexOf("__") + 2)
    : toolName;
  return mutationActionPrefix.test(actionName) || camelCaseMutationActionPrefix.test(actionName) ||
    mutationActionSuffix.test(actionName);
}

function getPathArguments(value, key = "", paths = []) {
  if (typeof value === "string") {
    if (/(?:^|[_-])(?:path|file|filename|target|destination|uri)(?:$|[_-])/i.test(key)) {
      paths.push(value);
    }
    return paths;
  }
  if (Array.isArray(value)) {
    for (const item of value) getPathArguments(item, key, paths);
    return paths;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) getPathArguments(childValue, childKey, paths);
  }
  return paths;
}

/** Return a denial reason when a Codex tool call could alter protected test files. */
export function evaluateToolCall(toolName, toolInput) {
  if (toolName === "apply_patch") {
    const command = typeof toolInput?.command === "string" ? toolInput.command : "";
    const paths = isTestPathInPatch(command);
    return paths.length > 0 ? { reason: `缺陷修复期间测试文件受保护：${paths.join("、")}` } : null;
  }

  if (toolName === "Bash") {
    const command = typeof toolInput?.command === "string" ? toolInput.command : "";
    if (isProtectionControlCommand(command)) {
      return { reason: "测试保护期间禁止由 Codex 结束保护或修改保护配置；完成修复后请由用户在 Codex 外运行 npm run fix:end。" };
    }
    const paths = extractPaths(command);
    if (paths.length === 0) return null;
    if (hasShellWriteSyntax(command)) {
      return { reason: `Shell 命令可能改写受保护的测试文件：${paths.join("、")}` };
    }
    if (isKnownTestCommand(command) || isReadOnlyInspectionCommand(command)) return null;
    return { reason: `Shell 命令引用了受保护的测试文件，无法确认其为只读操作：${paths.join("、")}` };
  }

  if (!isMutatingTool(toolName)) return null;
  const targetPaths = getPathArguments(toolInput);
  if (targetPaths.length === 0) {
    return { reason: `无法确认写入目标（工具：${toolName}）；保护期内拒绝未提供目标路径的文件写入。` };
  }
  const paths = targetPaths.filter(isProtectedWritePath);
  if (paths.length === 0) return null;
  return { reason: `缺陷修复期间测试文件和保护配置受保护：${paths.join("、")}` };
}

function getPostToolViolation(testCommit) {
  validateTestCommit(testCommit);
  const changedSinceTestCommit = changedPaths(["diff", "--name-only", testCommit, "--"]);
  const untrackedPaths = changedPaths(["ls-files", "--others", "--exclude-standard"]);
  const changedTests = findProtectedTestChanges(changedSinceTestCommit, untrackedPaths);
  return changedTests.length > 0 ? changedTests : null;
}

async function readHookInput() {
  const inputText = await new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
  return JSON.parse(inputText);
}

async function runHook() {
  const testCommit = getConfiguredTestCommit();
  if (!testCommit) return;

  const input = await readHookInput();
  const toolName = typeof input?.tool_name === "string" ? input.tool_name : "";
  const violation = evaluateToolCall(toolName, input?.tool_input);
  audit(violation ? "deny" : "allow", "test-protection.pre", testCommit, input);
  if (!violation) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${violation.reason}（基准提交 ${testCommit}）。请修改产品代码；如需解锁，由维护者在 Codex 外交互运行 npm run fix:end，填写批准人与原因并确认范围指纹，再单独修订测试。`
    }
  }));
}

async function runPostHook() {
  const testCommit = getConfiguredTestCommit();
  if (!testCommit) return;
  const input = await readHookInput();
  const toolName = typeof input?.tool_name === "string" ? input.tool_name : "";
  if (toolName.startsWith("mcp__") && !isMutatingTool(toolName)) return;
  const changedTests = getPostToolViolation(testCommit);
  audit(changedTests ? "deny" : "allow", "test-protection.post", testCommit, input);
  if (!changedTests) return;
  const callId = typeof input?.tool_use_id === "string" ? `（工具调用 ${input.tool_use_id}）` : "";
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: `工具执行后检测到测试文件变化：${changedTests.join("、")}。${callId}工具副作用已发生，请恢复测试文件，运行 npm run fix:verify，再继续修改产品代码。`
  }));
}

async function main() {
  try {
    const action = process.argv[2];
    if (action === "--hook") {
      await runHook();
    } else if (action === "--post-hook") {
      await runPostHook();
    } else if (action === "--begin") {
      const testCommit = process.argv[3];
      if (!testCommit || process.argv.length !== 4) throw new Error("用法：npm run fix:begin -- <复现测试提交>");
      beginProtection(testCommit);
    } else if (action === "--end") {
      if (process.argv.length !== 3) throw new Error("用法：npm run fix:end");
      await endProtection();
    } else {
      const testCommit = process.argv[2] ?? getConfiguredTestCommit();
      if (!testCommit || process.argv.length > 3) throw new Error("用法：npm run fix:verify（或指定复现测试提交）");
      verifyTestCommit(testCommit);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const action = process.argv[2];
    if (action === "--hook") {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `测试保护 hook 无法安全检查此次调用：${message}`
        }
      }));
    } else if (action === "--post-hook") {
      process.stdout.write(JSON.stringify({ decision: "block", reason: `测试保护事后检查失败：${message}` }));
    } else {
      if (action === "--end") {
        try { audit("deny", "test-protection.end", getConfiguredTestCommit()); }
        catch { /* The original error remains visible; an unavailable audit cannot authorize unlock. */ }
      }
      console.error(`测试保护检查失败：${message}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

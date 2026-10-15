import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const testPathPatterns = [
  /(^|\/)(__tests__|tests?)(\/|$)/i,
  /\.(test|spec)\.[^/]+$/i
];
const mutationVerbPattern = "(?:write|edit|patch|replace|delete|remove|move|rename|save|append|truncate|overwrite|create|update)";
const mutationActionPrefix = new RegExp(`^${mutationVerbPattern}(?:$|[_:.-])`, "i");
const camelCaseMutationActionPrefix = new RegExp(`^${mutationVerbPattern}[A-Z]`);
const mutationActionSuffix = new RegExp(`(?:^|[_:.-])${mutationVerbPattern}$`, "i");

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

function changedPaths(args) {
  const result = runGit(args);
  return result.stdout ? result.stdout.split(/\r?\n/) : [];
}

export function findProtectedTestChanges(changedSinceTestCommit, untrackedPaths) {
  return [...new Set([...changedSinceTestCommit, ...untrackedPaths])].filter(isTestPath).sort();
}

function getConfiguredTestCommit() {
  const result = runGit(["config", "--local", "--get", "contentferry.fixTestCommit"], { allowFailure: true });
  return result.status === 0 ? result.stdout : null;
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
  validateTestCommit(testCommit);
  const changedSinceTestCommit = changedPaths(["diff", "--name-only", testCommit, "--"]);
  const untrackedPaths = changedPaths(["ls-files", "--others", "--exclude-standard"]);
  const existingTestChanges = findProtectedTestChanges(changedSinceTestCommit, untrackedPaths);
  if (existingTestChanges.length > 0) {
    throw new Error(`开启保护前工作区已存在测试文件改动：${existingTestChanges.join("、")}`);
  }
  runGit(["config", "--local", "contentferry.fixTestCommit", testCommit]);
  console.log(`已开启测试保护，基准提交为 ${testCommit}。Codex hook 将拦截已识别的测试文件写入；结束前请运行 npm run fix:verify。`);
}

function endProtection() {
  const testCommit = getConfiguredTestCommit();
  if (testCommit) verifyTestCommit(testCommit);
  const result = runGit(["config", "--local", "--unset", "contentferry.fixTestCommit"], { allowFailure: true });
  if (result.status !== 0 && getConfiguredTestCommit() === null) {
    console.log("本地测试保护当前未开启。");
    return;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || "清除本地测试保护标记失败。");
  }
  console.log("已关闭本地测试保护。");
}

function isTestPathInPatch(command) {
  const paths = [];
  for (const line of command.split(/\r?\n/)) {
    const patchHeader = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    const unifiedHeader = line.match(/^\+\+\+ (?:b\/)?(.+)$/) ?? line.match(/^--- a\/(.+)$/);
    const filePath = patchHeader?.[1] ?? unifiedHeader?.[1];
    if (filePath && filePath !== "/dev/null" && isTestPath(filePath)) {
      paths.push(filePath);
    }
  }
  return [...new Set(paths)];
}

function extractPaths(text) {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|'[^']*'|`[^`]*`|[^\s]+/g) ?? [];
  return tokens
    .map((token) => token.replace(/^["'`([{,]+|["'`),;:]+$/g, ""))
    .filter((token) => isTestPath(token));
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
  const paths = targetPaths.filter(isTestPath);
  if (paths.length === 0) return null;
  return { reason: `缺陷修复期间测试文件受保护：${paths.join("、")}` };
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
  if (!violation) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${violation.reason}（基准提交 ${testCommit}）。请修改产品代码；如测试定义有误，先结束本修复流程并单独修订测试。`
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
      endProtection();
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
      console.error(`测试保护检查失败：${message}`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

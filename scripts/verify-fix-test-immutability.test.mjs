import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import test from "node:test";
import { evaluateToolCall, findProtectedTestChanges } from "./verify-fix-test-immutability.mjs";

const scriptPath = resolve("scripts/verify-fix-test-immutability.mjs");

function createProtectedRepo() {
  const directory = join(process.cwd(), `.tmp-fix-test-${randomUUID()}`);
  mkdirSync(directory);
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Codex Test"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "codex-test@example.invalid"], { cwd: directory });
  mkdirSync(join(directory, "src"));
  writeFileSync(join(directory, "src/example.test.ts"), "test baseline\n");
  execFileSync("git", ["add", "src/example.test.ts"], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "test baseline"], { cwd: directory });
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  execFileSync("git", ["config", "--local", "contentferry.fixTestCommit", commit], { cwd: directory });
  return directory;
}

function runHook(directory, action, input = {}) {
  return spawnSync(process.execPath, [scriptPath, action], {
    cwd: directory,
    encoding: "utf8",
    input: JSON.stringify(input)
  });
}

test("the PreToolUse entry point blocks a protected MCP write", () => {
  const directory = createProtectedRepo();
  try {
    const result = runHook(directory, "--hook", {
      tool_name: "mcp__filesystem__write_file",
      tool_input: { path: "src/example.test.ts", content: "changed" }
    });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the PostToolUse entry point reports a deleted protected test", () => {
  const directory = createProtectedRepo();
  try {
    rmSync(join(directory, "src/example.test.ts"));
    const result = runHook(directory, "--post-hook", { tool_use_id: "call-test-123" });
    assert.equal(result.status, 0);
    assert.match(JSON.parse(result.stdout).reason, /src\/example\.test\.ts/);
    assert.match(JSON.parse(result.stdout).reason, /call-test-123/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PostToolUse skips filesystem checks after read-only MCP calls", () => {
  const directory = createProtectedRepo();
  try {
    rmSync(join(directory, "src/example.test.ts"));
    const result = runHook(directory, "--post-hook", {
      tool_name: "mcp__filesystem__read_file",
      tool_use_id: "call-read-only"
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fix:end keeps protection enabled until deleted tests are restored", () => {
  const directory = createProtectedRepo();
  try {
    rmSync(join(directory, "src/example.test.ts"));
    const result = runHook(directory, "--end");
    assert.equal(result.status, 1);
    assert.match(execFileSync("git", ["config", "--local", "--get", "contentferry.fixTestCommit"], {
      cwd: directory,
      encoding: "utf8"
    }), /^[0-9a-f]+\s*$/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Codex hooks cover shell and file tools before and after calls", () => {
  const config = JSON.parse(readFileSync(resolve(".codex/hooks.json"), "utf8"));
  const preMatcher = new RegExp(config.hooks.PreToolUse[0].matcher);
  const postMatcher = new RegExp(config.hooks.PostToolUse[0].matcher);
  assert.equal(config.hooks.PreToolUse[0].matcher, config.hooks.PostToolUse[0].matcher);

  for (const matcher of [preMatcher, postMatcher]) {
    for (const toolName of [
      "apply_patch",
      "Bash",
      "Edit",
      "Write",
      "Delete",
      "Move",
      "Rename",
      "Create",
      "Update",
      "Save",
      "Append",
      "Remove",
      "Replace",
      "Truncate",
      "Overwrite",
      "Patch",
      "mcp__fs__write",
      "mcp__fs__writeFile",
      "mcp__fs__editDocument",
      "mcp__storage__createRecord",
      "mcp__fs-write",
      "mcp__fs.create",
      "mcp__filesystem__read_file"
    ]) {
      assert.equal(matcher.test(toolName), true, `expected matcher to include ${toolName}`);
    }

    for (const toolName of [
      "list_write_permissions",
      "get_edit_history",
      "read_create_time",
      "check_update_status",
      "write_file",
      "write-file",
      "write:file"
    ]) {
      assert.equal(matcher.test(toolName), false, `expected matcher to exclude ${toolName}`);
    }

  }
});

test("blocks apply_patch edits to test files", () => {
  const result = evaluateToolCall("apply_patch", {
    command: "*** Begin Patch\n*** Update File: src/example.test.ts\n@@\n-old\n+new\n*** End Patch"
  });

  assert.match(result?.reason ?? "", /src\/example\.test\.ts/);
});

test("blocks shell redirection to a test file", () => {
  const result = evaluateToolCall("Bash", {
    command: 'Set-Content "src/example.test.ts" "changed"'
  });

  assert.match(result?.reason ?? "", /src\/example\.test\.ts/);
});

test("allows test commands that mention a test file", () => {
  assert.equal(evaluateToolCall("Bash", {
    command: "npm run test:electron -- src/example.test.ts"
  }), null);
});

test("allows read-only log inspection commands that mention a test file", () => {
  for (const command of [
    "head src/example.test.ts",
    "tail -f src/example.test.ts",
    "less src/example.test.ts"
  ]) {
    assert.equal(evaluateToolCall("Bash", { command }), null, `expected ${command} to be allowed`);
  }
});

test("blocks MCP file writes to test files", () => {
  const result = evaluateToolCall("mcp__filesystem__write_file", {
    path: "src/example.test.ts",
    content: "changed"
  });

  assert.match(result?.reason ?? "", /src\/example\.test\.ts/);
});

test("blocks camelCase MCP file writes to test files", () => {
  const result = evaluateToolCall("mcp__filesystem__writeFile", {
    path: "src/example.test.ts",
    content: "changed"
  });

  assert.match(result?.reason ?? "", /src\/example\.test\.ts/);
});

test("blocks test-file writes across supported MCP and local tool name variants", () => {
  for (const toolName of [
    "write_file",
    "write-file",
    "write:file",
    "mcp__fs__write",
    "mcp__fs__editDocument",
    "mcp__storage__createRecord",
    "mcp__fs-write",
    "mcp__fs.create"
  ]) {
    const result = evaluateToolCall(toolName, { path: "src/example.test.ts" });
    assert.match(result?.reason ?? "", /src\/example\.test\.ts/, `expected ${toolName} to be blocked`);
  }
});

test("fails closed for camelCase tools whose names start with a mutation verb", () => {
  const result = evaluateToolCall("writePermissionsChecker", {});

  assert.match(result?.reason ?? "", /无法确认写入目标/);
});

test("allows writes to non-test files", () => {
  assert.equal(evaluateToolCall("mcp__filesystem__write_file", {
    path: "src/example.ts",
    content: "changed"
  }), null);
});

test("fails closed when a mutating tool does not expose its target path", () => {
  const result = evaluateToolCall("mcp__filesystem__write_file", { content: "changed" });

  assert.match(result?.reason ?? "", /无法确认写入目标/);
});

test("allows read-only tools that inspect test files", () => {
  assert.equal(evaluateToolCall("mcp__filesystem__read_file", {
    path: "src/example.test.ts"
  }), null);
});

test("allows MCP tools that mention write access but only inspect permissions", () => {
  assert.equal(evaluateToolCall("mcp__permissions__list_write_permissions", {}), null);
  assert.equal(evaluateToolCall("mcp__permissions__check_write_access", {
    resource: "src/example.test.ts"
  }), null);
});

test("reports deleted test files during baseline verification", () => {
  assert.deepEqual(findProtectedTestChanges(["src/example.test.ts"], []), ["src/example.test.ts"]);
});

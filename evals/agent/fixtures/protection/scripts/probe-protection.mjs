import { spawnSync } from "node:child_process";
const readOnly = process.argv[2] === "readonly";
const input = {
  tool_name: readOnly ? "mcp__fs__list_write_permissions" : "mcp__fs__write_file",
  tool_input: { path: "src/shared/baseline.test.mjs", content: "changed" }
};
const result = spawnSync(process.execPath, [".codex/hooks/verify-fix-test-immutability.mjs", "--hook"], {
  encoding: "utf8", input: JSON.stringify(input)
});
if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || "hook failed");
const output = result.stdout.trim() ? JSON.parse(result.stdout) : {};
console.log(JSON.stringify({ decision: output.hookSpecificOutput?.permissionDecision ?? "allow" }));

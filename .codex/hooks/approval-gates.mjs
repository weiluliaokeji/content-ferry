import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function evaluateReleaseCall(toolName, input) {
  const command = typeof input?.command === "string" ? input.command : "";
  if (toolName === "Bash" && (
    /\bgh(?:\.exe)?\s+release\s+(?:create|upload|edit|delete)\b/i.test(command) ||
    (/\bgh(?:\.exe)?\s+api\b/i.test(command) && /(?:releases|environments|pending_deployments)/i.test(command) &&
      /(?:-X\s*|--method[=\s]+)(?:POST|PUT|PATCH|DELETE)\b|(?:^|\s)(?:-f|-F|--field|--raw-field|--input)(?:\s|=)/i.test(command)) ||
    /\bgit(?:\.exe)?\s+push\b[^\r\n]*(?:--tags|--follow-tags|refs\/tags\/|(?:^|\s)v\d+\.\d+)/i.test(command) ||
    /\brelease-gates\.mjs\s+publish\b/i.test(command))) return "release.external-write";
  if (toolName.startsWith("mcp__") && /(?:create|publish|upload|update|delete|edit)[_A-Z-]*(?:release|Release)|(?:approve|review)[_A-Z-]*(?:deployment|Deployment)/.test(toolName)) return "release.external-write";
  return null;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  const rule = evaluateReleaseCall(input.tool_name ?? "", input.tool_input);
  // Only release-related attempts are audited; ordinary unrelated calls do not enter this gate.
  if (!rule) return;
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "contentferry-gate-audit.jsonl"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error("无法定位审批审计目录。");
  const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) throw new Error("无法确认发布操作的当前提交。");
  const callId = typeof input.tool_use_id === "string" && /^[\w-]{1,120}$/.test(input.tool_use_id) ? input.tool_use_id : null;
  appendFileSync(result.stdout.trim(), JSON.stringify({ timestamp: new Date().toISOString(), decision: "deny", rule,
    head: head.stdout.trim(), callId,
    callFingerprint: createHash("sha256").update(JSON.stringify(input.tool_input ?? null)).digest("hex") }) + "\n");
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "已阻止 Agent 直接发布、替换安装包或调整发布审批。请准备候选版本并交由维护者推送版本 tag；在 GitHub Actions 下载候选包核对后，由 weiluliaokeji 批准 release-production，流水线发布同一批已验证产物。" } }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "发布审批 hook 无法安全检查此次调用，请维护者检查配置和审计目录。" } }));
  });
}

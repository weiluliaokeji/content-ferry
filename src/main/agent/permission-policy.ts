import path from "node:path";

export type PermissionScope = "global" | "project" | "run";
export type PermissionDecision = "allow" | "ask" | "deny";
export type ToolRisk = "low" | "medium" | "high";
export type ToolAction = "read" | "network_read" | "write" | "delete" | "install" | "external_write" | "publish" | "sensitive_read";

export interface ToolPermissionRequest {
  toolId: string;
  action: ToolAction;
  risk: ToolRisk;
  projectId?: string;
  target?: string;
  networkHost?: string;
  defaultAllow?: boolean;
}

export interface ToolPermissionGrant {
  scope: PermissionScope;
  decision: PermissionDecision;
  toolId?: string;
  action?: ToolAction;
  projectId?: string;
  targetPrefix?: string;
  expiresAt?: string | null;
}

export interface PermissionResult {
  decision: PermissionDecision;
  reason: string;
  matchedScope: PermissionScope | null;
}

/** Pure hierarchical permission evaluator; it never persists or prompts. */
export function evaluatePermission(
  request: ToolPermissionRequest,
  grants: ToolPermissionGrant[],
  now = new Date()
): PermissionResult {
  const matching = grants.filter((grant) => matches(request, grant, now));
  const deny = matching.find((grant) => grant.decision === "deny");
  if (deny) return { decision: "deny", reason: "当前范围存在明确拒绝，具体授权不能覆盖它。", matchedScope: deny.scope };

  const allow = [...matching].filter((grant) => grant.decision === "allow").sort((left, right) => scopeRank(right.scope) - scopeRank(left.scope))[0];
  if (allow) return { decision: "allow", reason: `已获得${scopeName(allow.scope)}授权。`, matchedScope: allow.scope };

  if (request.defaultAllow && request.risk === "low" && (request.action === "read" || request.action === "network_read")) {
    return { decision: "allow", reason: "低风险只读操作使用当前任务默认授权。", matchedScope: null };
  }
  return { decision: "ask", reason: "尚未找到覆盖当前工具、动作和目标的授权。", matchedScope: null };
}

function matches(request: ToolPermissionRequest, grant: ToolPermissionGrant, now: Date): boolean {
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= now.getTime()) return false;
  if (grant.toolId && grant.toolId !== request.toolId) return false;
  if (grant.action && grant.action !== request.action) return false;
  if (grant.projectId && grant.projectId !== request.projectId) return false;
  if (grant.targetPrefix && !request.target) return false;
  if (grant.targetPrefix && request.target && !matchesTargetPrefix(request.target, grant.targetPrefix)) return false;
  return true;
}

/** Keeps a directory grant from treating `C:\\workshop` as a child of `C:\\work`. */
function matchesTargetPrefix(target: string, prefix: string): boolean {
  const normalizedTarget = normalizeTarget(target);
  const normalizedPrefix = normalizeTarget(prefix).replace(/\/+$/u, "");
  if (!normalizedPrefix) return false;
  if (normalizedTarget === normalizedPrefix) return true;
  if (looksLikePath(normalizedTarget) || looksLikePath(normalizedPrefix)) return normalizedTarget.startsWith(`${normalizedPrefix}/`);
  return normalizedTarget.endsWith(`.${normalizedPrefix}`);
}

function normalizeTarget(value: string): string {
  const trimmed = value.trim();
  if (looksLikePath(trimmed.replaceAll("\\", "/"))) return path.resolve(trimmed).replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
  return trimmed.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || /^[a-z]:$/u.test(value) || value.startsWith(".");
}

function scopeRank(scope: PermissionScope): number {
  return scope === "run" ? 3 : scope === "project" ? 2 : 1;
}

function scopeName(scope: PermissionScope): string {
  return scope === "run" ? "单次" : scope === "project" ? "项目" : "全局默认";
}

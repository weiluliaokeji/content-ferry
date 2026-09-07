import { createHash } from "node:crypto";

/** 跨平台发布任务共同理解的状态。平台自己的细分状态留在 adapter 详情中。 */
export type PublishLifecycleStatus =
  | "queued"
  | "preparing"
  | "waiting_user"
  | "ready"
  | "submitting"
  | "published"
  | "needs_credentials"
  | "failed"
  | "needs_manual_reconciliation"
  | "cancelled";

export type PublishAdapterOutcome = "confirmed" | "uncertain" | "retryable" | "blocked";

export interface PublishSnapshotInput {
  platform: string;
  accountId: string;
  channelDraftId: string;
  title: string;
  markdown: string;
  author?: string;
  digest?: string;
  coverSource?: string;
  options?: Record<string, unknown>;
  resourceRefs?: string[];
}

const canonicalStatusByPlatformStatus: Record<string, PublishLifecycleStatus> = {
  queued: "queued",
  draft_creating: "preparing",
  needs_login: "needs_credentials",
  needs_credentials: "needs_credentials",
  filling: "preparing",
  needs_user: "waiting_user",
  ready_for_final_confirmation: "waiting_user",
  draft_created: "ready",
  ready: "ready",
  confirming: "waiting_user",
  submitting: "submitting",
  published: "published",
  failed_before_submit: "failed",
  failed: "failed",
  needs_manual_reconciliation: "needs_manual_reconciliation",
  cancelled: "cancelled"
};

/** 将平台内部状态映射为跨平台 UI 可用的规范状态。 */
export function toPublishLifecycleStatus(platformStatus: string): PublishLifecycleStatus {
  if (platformStatus === "queued" || platformStatus === "preparing" || platformStatus === "waiting_user" || platformStatus === "ready"
    || platformStatus === "submitting" || platformStatus === "published" || platformStatus === "needs_credentials"
    || platformStatus === "failed" || platformStatus === "needs_manual_reconciliation" || platformStatus === "cancelled") {
    return platformStatus;
  }
  return canonicalStatusByPlatformStatus[platformStatus] ?? "failed";
}

export function isTerminalPublishStatus(status: PublishLifecycleStatus): boolean {
  return status === "published" || status === "needs_manual_reconciliation" || status === "cancelled";
}

export function isRetryablePublishStatus(status: PublishLifecycleStatus): boolean {
  // `ready` is not a retry itself, but remains the active task for a frozen snapshot.
  return status === "queued" || status === "preparing" || status === "waiting_user" || status === "ready" || status === "failed" || status === "needs_credentials";
}

/**
 * 生成冻结快照哈希。对象键排序保证同一份发布输入跨进程得到同一结果；
 * 不把正文之外的运行时状态放入快照，避免重试时哈希漂移。
 */
export function computePublishSnapshotHash(input: PublishSnapshotInput): string {
  const normalized = {
    platform: input.platform,
    accountId: input.accountId,
    channelDraftId: input.channelDraftId,
    title: input.title,
    markdown: input.markdown,
    author: input.author ?? "",
    digest: input.digest ?? "",
    coverSource: input.coverSource ?? "",
    options: sortJson(input.options ?? {}),
    resourceRefs: [...(input.resourceRefs ?? [])].sort()
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function buildPublishIdempotencyKey(platform: string, accountId: string, channelDraftId: string, snapshotHash: string): string {
  return `${platform}:${accountId}:${channelDraftId}:${snapshotHash}:publish`;
}

/** 将 adapter 结果映射为公共状态，避免每个平台重复解释错误分类。 */
export function lifecycleStatusForOutcome(outcome: PublishAdapterOutcome, phase: "prepare" | "submit"): PublishLifecycleStatus {
  if (outcome === "blocked") return "needs_credentials";
  if (outcome === "uncertain") return "needs_manual_reconciliation";
  if (outcome === "retryable") return "failed";
  return phase === "prepare" ? "ready" : "published";
}

/** Extract stable resource references from Markdown/HTML for snapshot identity. */
export function publishResourceRefs(markdown: string): string[] {
  const refs = new Set<string>();
  for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) refs.add(match[1]);
  for (const match of markdown.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)) refs.add(match[1]);
  return [...refs];
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJson(entry)]));
}

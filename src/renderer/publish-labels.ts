import type { CnblogsPublishJob, CsdnPublishJob, FiftyoneCtoPublishJob, JuejinPublishJob, WechatPublishJob } from "./types";

// 各平台发布任务的状态标签（自 main.tsx 拆分）
export const WECHAT_JOB_STATUS_PRIORITY: Record<WechatPublishJob["status"], number> = {
  published: 5,
  submitted: 4,
  draft_ready: 3,
  browser_editing: 2,
  cancelled: 1,
  failed: 0,
};

export function bestWechatJob(jobs: WechatPublishJob[], predicate: (job: WechatPublishJob) => boolean): WechatPublishJob | undefined {
  const matches = jobs.filter(predicate);
  if (matches.length === 0) return undefined;
  return matches.reduce((best, current) =>
    WECHAT_JOB_STATUS_PRIORITY[current.status] > WECHAT_JOB_STATUS_PRIORITY[best.status] ? current : best
  );
}

export function wechatJobLabel(job: WechatPublishJob): string {
  if (job.status === "draft_ready") return "微信草稿已创建，等待人工预览";
  if (job.status === "browser_editing") return "等待你在微信后台核对设置并发布";
  if (job.status === "failed") return "提交失败，可查看原因后重试";
  if (job.status === "published") return "微信已确认发布完成";
  if (job.status === "cancelled") return "已人工标记为取消发布";
  return job.mode === "mass" ? "群发任务已提交，等待微信回执" : "发布任务已提交，等待微信回执";
}

export function csdnJobLabel(job: CsdnPublishJob): string {
  switch (job.status) {
    case "queued": return "等待开始浏览器发布";
    case "needs_login": return "需要登录 CSDN";
    case "filling": return "浏览器填充中";
    case "needs_user": return "部分字段未可靠填充，需手动补齐";
    case "ready_for_final_confirmation": return "待你在文渡确认发布";
    case "submitting": return "正在读取 CSDN 回执";
    case "published": return "已发布";
    case "needs_manual_reconciliation": return "待人工核对发布结果";
    case "failed_before_submit": return "浏览器填充失败";
    case "failed": return "已标记为发布失败";
    case "cancelled": return "已取消发布";
  }
}

export function csdnJobCanStart(job: CsdnPublishJob): boolean {
  return ["queued", "needs_login", "filling", "needs_user", "ready_for_final_confirmation", "failed_before_submit", "needs_manual_reconciliation"].includes(job.status);
}

export function csdnJobCanConfirm(job: CsdnPublishJob): boolean {
  return job.status === "ready_for_final_confirmation" || job.status === "needs_user";
}

export function csdnJobCanCorrect(job: CsdnPublishJob): boolean {
  return ["needs_login", "filling", "submitting", "needs_manual_reconciliation", "failed_before_submit", "failed", "cancelled", "published"].includes(job.status);
}

export function cnblogsJobLabel(job: CnblogsPublishJob): string {
  switch (job.status) {
    case "draft_creating": return "正在创建博客园草稿";
    case "draft_created": return "草稿已创建，待确认公开";
    case "confirming": return "正在公开博客园文章";
    case "published": return "已发布";
    case "failed": return "发布失败";
    case "needs_manual_reconciliation": return "待人工核对发布结果";
    case "needs_credentials": return "缺少博客园凭据";
    case "cancelled": return "已取消发布";
  }
}

export function juejinJobLabel(job: JuejinPublishJob): string {
  switch (job.status) {
    case "draft_creating": return "正在创建掘金草稿";
    case "draft_created": return "草稿已创建，待确认公开";
    case "confirming": return "正在公开掘金文章";
    case "published": return "已发布";
    case "failed": return "发布失败";
    case "needs_manual_reconciliation": return "待人工核对发布结果";
    case "needs_credentials": return "缺少掘金凭据";
    case "cancelled": return "已取消发布";
  }
}

export function fiftyoneCtoJobLabel(job: FiftyoneCtoPublishJob): string {
  switch (job.status) {
    case "draft_creating": return "正在发布到 51CTO";
    case "draft_created": return "草稿已创建，待确认公开";
    case "confirming": return "正在公开 51CTO 文章";
    case "published": return "已发布";
    case "failed": return "发布失败";
    case "needs_manual_reconciliation": return "待人工核对发布结果";
    case "needs_credentials": return "缺少 51CTO 凭据";
    case "cancelled": return "已取消发布";
  }
}

export function fiftyoneCtoJobCanStart(job: FiftyoneCtoPublishJob): boolean {
  return ["draft_creating", "draft_created", "confirming", "needs_manual_reconciliation", "needs_credentials", "failed"].includes(job.status);
}

export function fiftyoneCtoJobCanCorrect(job: FiftyoneCtoPublishJob): boolean {
  return ["draft_creating", "draft_created", "confirming", "needs_manual_reconciliation", "needs_credentials", "failed", "cancelled", "published"].includes(job.status);
}

// 人工校正可选的三档最终状态。
export type PublishCorrectionStatus = "published" | "failed" | "cancelled";
// 五个平台发布任务的公共最小形状，便于统一判定归属。
export type PublishJobLike = { status: string; statusSource?: string };

/**
 * 判断一条发布任务是否已经归档，即应当出现在「发布记录」而不是「待处理」。
 *
 * - published / cancelled：终态，直接归档。
 * - failed：系统判定失败的任务仍需要用户处理（重试、重新发布或人工核实），
 *   因此留在「待处理」；只有用户在平台后台核实后主动标记为失败
 *   （statusSource === "manual"）才视为已处理完毕并归档。
 */
export function isSettledPublishStatus(job: PublishJobLike): boolean {
  if (job.status === "published" || job.status === "cancelled") return true;
  return job.status === "failed" && job.statusSource === "manual";
}

/**
 * 校正弹框的初始状态：跟随任务当前状态，避免「显示为已发布、实际想归档」的误解。
 * 失败任务默认停在「发布失败」，用户直接确认即可把它归档到发布记录。
 */
export function defaultCorrectionStatus(job: PublishJobLike): PublishCorrectionStatus {
  return job.status === "failed" || job.status === "cancelled" ? job.status : "published";
}

/** 发布记录区右侧徽标的文案与配色。 */
export function publishRecordBadge(job: PublishJobLike): { text: string; tone: "success" | "warning" | "danger" } {
  if (job.status === "cancelled") return { text: "已取消", tone: "warning" };
  if (job.status === "failed") return { text: "已失败", tone: "danger" };
  return { text: "已完成", tone: "success" };
}


import type { CnblogsPublishJob, CsdnPublishJob, JuejinPublishJob, WechatPublishJob } from "./types";

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


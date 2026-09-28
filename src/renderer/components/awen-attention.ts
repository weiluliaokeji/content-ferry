import type { ArticlePracticeTask, ToolWorkflowSnapshot } from "../types";

export type AwenAttentionNotice = { key: string; title: string; body: string };

const TASK_WAITING_COPY: Partial<Record<ArticlePracticeTask["status"], { title: string; fallback: string }>> = {
  waiting_permission: { title: "阿文需要你的授权", fallback: "请查看这次操作的目标和影响，再决定是否允许。" },
  waiting_feedback: { title: "阿文需要你的指示", fallback: "实践遇到问题，需要你决定下一步如何处理。" },
  waiting_stop_choice: { title: "请选择接下来怎么做", fallback: "实践已停止，请选择继续起草、停止起草或补充新要求。" },
  waiting_resume_choice: { title: "阿文等待恢复指示", fallback: "上次实践因应用重启而中断，请选择是否从安全检查点续做。" },
  waiting_edit_confirmation: { title: "阿文等待你确认正文建议", fallback: "请查看实践结果对应的正文建议，并决定是否应用。" }
};

function compact(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

export function resolveAwenAttentionNotice(
  task: ArticlePracticeTask | undefined,
  workflow: ToolWorkflowSnapshot | undefined,
  articleTitle: string
): AwenAttentionNotice | undefined {
  if (task?.status === "waiting_permission" && workflow?.status === "waiting_user" && workflow.pendingPermission) {
    const pending = workflow.pendingPermission;
    const target = pending.request.target?.trim();
    const action = target || `${pending.request.action} 操作`;
    return {
      key: `permission:${workflow.workflowId}:${pending.callId}`,
      title: "阿文需要你的授权",
      body: compact(`文章《${articleTitle}》：${pending.permission.reason || `需要你确认${action}`}。请打开文渡右侧“执行活动”查看影响并处理。`, "阿文正在等待你的授权，请打开右侧“执行活动”处理。")
    };
  }

  const waitingCopy = task ? TASK_WAITING_COPY[task.status] : undefined;
  if (task && waitingCopy) {
    const stage = task.status === "waiting_permission" ? "permission" : task.status;
    return {
      key: `${stage}:${task.checkpoint.workflowId ?? task.id}`,
      title: waitingCopy.title,
      body: compact(`文章《${articleTitle}》：${task.waitingReason || waitingCopy.fallback} 请打开文渡右侧“执行活动”处理。`, `${waitingCopy.fallback} 请打开右侧“执行活动”处理。`)
    };
  }

  if (workflow?.status === "waiting_user") {
    return {
      key: `workflow-wait:${workflow.workflowId}`,
      title: "阿文需要你的指示",
      body: `文章《${articleTitle}》的实践正在等待你处理。请打开文渡右侧“执行活动”查看原因和可选操作。`
    };
  }
  return undefined;
}

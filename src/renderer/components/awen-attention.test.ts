import { describe, expect, it } from "vitest";
import { resolveAwenAttentionNotice } from "./awen-attention";
import type { ArticlePracticeTask, ToolWorkflowSnapshot } from "../types";

const task = (status: ArticlePracticeTask["status"], overrides: Partial<ArticlePracticeTask> = {}): ArticlePracticeTask => ({
  id: "task-1", projectId: "project-1", sourceType: "awen", legacyExecutionRunId: null,
  status, goalRevision: 1, latestGoal: "运行验证", waitingReason: null, feedbackDeadline: null,
  createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z",
  checkpoint: { workflowId: "workflow-1" }, hasGaps: false, ...overrides
});

const workflow: ToolWorkflowSnapshot = {
  workflowId: "workflow-1", status: "waiting_user", round: 1, userRequest: "运行验证",
  transcript: [], events: [], toolResults: [],
  pendingPermission: {
    callId: "call-1",
    request: { toolId: "run_command", action: "run", target: "本机命令行", input: {} },
    permission: { decision: "ask", reason: "需要允许本次在本机运行命令", matchedScope: null }
  },
  finalText: null, warningCount: 0
};

describe("resolveAwenAttentionNotice", () => {
  it("creates a human-readable authorization notice with a stable identity", () => {
    const notice = resolveAwenAttentionNotice(task("waiting_permission"), workflow, "示例文章");
    expect(notice?.title).toBe("阿文需要你的授权");
    expect(notice?.body).toContain("示例文章");
    expect(notice?.body).toContain("右侧“执行活动”");
    expect(notice?.key).toBe("permission:workflow-1:call-1");
  });

  it("creates a new notice identity for a later permission request in the same workflow", () => {
    const first = resolveAwenAttentionNotice(task("waiting_permission"), workflow, "示例文章");
    const second = resolveAwenAttentionNotice(task("waiting_permission"), {
      ...workflow,
      pendingPermission: { ...workflow.pendingPermission!, callId: "call-2" }
    }, "示例文章");

    expect(first?.key).not.toBe(second?.key);
  });

  it.each([
    ["waiting_feedback", "阿文需要你的指示"],
    ["waiting_stop_choice", "请选择接下来怎么做"],
    ["waiting_resume_choice", "阿文等待恢复指示"],
    ["waiting_edit_confirmation", "阿文等待你确认正文建议"]
  ] as const)("notifies when the task enters %s", (status, title) => {
    expect(resolveAwenAttentionNotice(task(status), undefined, "示例文章")?.title).toBe(title);
  });

  it("does not notify for ordinary running or completed states", () => {
    expect(resolveAwenAttentionNotice(task("practicing"), { ...workflow, status: "running", pendingPermission: null }, "示例文章")).toBeUndefined();
    expect(resolveAwenAttentionNotice(task("completed"), { ...workflow, status: "completed", pendingPermission: null }, "示例文章")).toBeUndefined();
  });
});

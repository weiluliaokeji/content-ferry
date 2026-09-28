import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import { ArticlePracticeTaskRepository } from "./article-practice-task-repository";

describe("article practice task decisions", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  function setup(): ArticlePracticeTaskRepository {
    database = openInMemoryDatabase();
    database.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)")
      .run("workspace", "测试", "2026-09-25T00:00:00.000Z");
    database.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("project", "workspace", "示例文章", "2026-09-25T00:00:00.000Z", "2026-09-25T00:00:00.000Z");
    return new ArticlePracticeTaskRepository(database.connection);
  }

  it("keeps one active task and appends a new chat goal with an ordered event", () => {
    const tasks = setup();
    const first = tasks.create("project", "验证示例", new Date("2026-09-25T00:00:00Z"));
    expect(() => tasks.create("project", "另起任务")).toThrow("并入当前任务");
    const revised = tasks.appendGoal(first.id, "补充检查边界条件", "chat");
    expect(revised.goalRevision).toBe(2);
    expect(revised.latestGoal).toBe("补充检查边界条件");
    expect(tasks.listEvents(first.id).map((event) => [event.sequence, event.kind])).toEqual([
      [1, "created"], [2, "goal_added"]
    ]);
    tasks.beginAssessment(first.id);
    tasks.beginDraft(first.id);
    tasks.finish(first.id);
    expect(tasks.create("project", "下一轮验证").status).toBe("queued");
  });

  it("allows a separate practice while an earlier task only awaits saving its article suggestion", () => {
    const tasks = setup();
    const editPending = tasks.create("project", "补充 Scoop 实践示例");
    tasks.beginAssessment(editPending.id);
    tasks.beginPractice(editPending.id);
    tasks.beginDraft(editPending.id);
    tasks.waitForEditConfirmation(editPending.id, "suggestion-message");

    expect(tasks.findActive("project")).toBeNull();
    const independent = tasks.create("project", "查询本机 nvm 中的 Node.js 版本");
    expect(tasks.findActive("project")?.id).toBe(independent.id);
    expect(tasks.require(editPending.id).status).toBe("waiting_edit_confirmation");
    expect(tasks.listEvents(editPending.id).map((event) => event.kind)).not.toContain("goal_added");
  });

  it("lists recent tasks for the current article, including completed history", () => {
    const tasks = setup();
    const first = tasks.create("project", "第一次验证", new Date("2026-09-25T00:00:00Z"));
    tasks.beginAssessment(first.id);
    tasks.beginPractice(first.id);
    tasks.beginDraft(first.id);
    tasks.finish(first.id, new Date("2026-09-25T00:00:30Z"));
    const second = tasks.create("project", "第二次验证", new Date("2026-09-25T00:01:00Z"));

    expect(tasks.listRecent("project", 2).map(({ id, latestGoal }) => [id, latestGoal])).toEqual([
      [second.id, "第二次验证"], [first.id, "第一次验证"]
    ]);
    expect(() => tasks.listRecent("project", 0)).toThrow("1 到 50");
  });

  it("never expires a permission wait, but expires a failed-practice feedback wait after five minutes", () => {
    const tasks = setup();
    const task = tasks.create("project", "运行示例");
    tasks.beginAssessment(task.id);
    tasks.beginPractice(task.id);
    tasks.waitForPermission(task.id, "需要本机运行授权", new Date("2026-09-25T00:00:00Z"));
    expect(tasks.require(task.id).feedbackDeadline).toBeNull();
    tasks.permissionResolved(task.id);
    const blocked = tasks.waitForFeedback(task.id, "工具不可用", new Date("2026-09-25T00:00:00Z"));
    expect(blocked.feedbackDeadline).toBe("2026-09-25T00:05:00.000Z");
    expect(tasks.expireFeedback(task.id, new Date("2026-09-25T00:04:59Z")).status).toBe("waiting_feedback");
    expect(tasks.expireFeedback(task.id, new Date("2026-09-25T00:05:00Z")).status).toBe("drafting");
    expect(tasks.finish(task.id).status).toBe("completed_with_gaps");
  });

  it("waits for the author's drafting choice after a manual stop", () => {
    const tasks = setup();
    const task = tasks.create("project", "运行示例");
    tasks.beginAssessment(task.id);
    tasks.beginPractice(task.id);
    expect(tasks.requestStop(task.id).status).toBe("waiting_stop_choice");
    expect(tasks.recoverInterrupted().some((item) => item.id === task.id)).toBe(false);
    expect(tasks.require(task.id).status).toBe("waiting_stop_choice");
    expect(tasks.require(task.id).feedbackDeadline).toBeNull();
    expect(tasks.resolveStop(task.id, "draft_with_gaps").status).toBe("drafting");
    expect(tasks.finish(task.id).status).toBe("completed_with_gaps");
  });

  it("asks before restart, preserves the original deadline, and holds uncertain effects for reconciliation", () => {
    const tasks = setup();
    const task = tasks.create("project", "运行示例");
    tasks.beginAssessment(task.id);
    tasks.beginPractice(task.id);
    tasks.saveCheckpoint(task.id, { stepId: "run-1", uncertainSideEffect: true });
    tasks.waitForFeedback(task.id, "执行中断", new Date("2026-09-25T00:00:00Z"));
    expect(tasks.recoverInterrupted(new Date("2026-09-25T00:01:00Z"))[0]?.status).toBe("waiting_resume_choice");
    expect(tasks.resume(task.id, new Date("2026-09-25T00:06:00Z")).needsReconciliation).toBe(true);
    tasks.markReconciled(task.id, "确认未改动目标文件");
    const resumed = tasks.resume(task.id, new Date("2026-09-25T00:06:00Z"));
    expect(resumed.needsReconciliation).toBe(false);
    expect(resumed.task.status).toBe("drafting");
    expect(resumed.task.hasGaps).toBe(true);
    expect(tasks.listEvents(task.id).map((event) => event.kind)).toContain("reconciled");
  });

  it("continues an unexpired feedback wait from its original deadline after restart", () => {
    const tasks = setup();
    const task = tasks.create("project", "运行示例");
    tasks.beginAssessment(task.id);
    tasks.beginPractice(task.id);
    tasks.waitForFeedback(task.id, "缺少工具", new Date("2026-09-25T00:00:00Z"));
    tasks.recoverInterrupted(new Date("2026-09-25T00:01:00Z"));
    const resumed = tasks.resume(task.id, new Date("2026-09-25T00:03:00Z"));
    expect(resumed.task.status).toBe("waiting_feedback");
    expect(resumed.task.feedbackDeadline).toBe("2026-09-25T00:05:00.000Z");
    expect(resumed.task.waitingReason).toBe("缺少工具");
    expect(tasks.expireFeedback(task.id, new Date("2026-09-25T00:05:00Z")).status).toBe("drafting");
  });

  it("continues the same task when the author provides feedback after a practice failure", () => {
    const tasks = setup();
    const task = tasks.create("project", "验证示例");
    tasks.beginAssessment(task.id);
    tasks.beginPractice(task.id);
    tasks.waitForFeedback(task.id, "工具运行失败", new Date("2026-09-25T00:00:00.000Z"));
    tasks.appendGoal(task.id, "请改用已安装的 Node 再试", "chat", new Date("2026-09-25T00:02:00.000Z"));

    const continued = tasks.resumeAfterFeedback(task.id, new Date("2026-09-25T00:02:01.000Z"));

    expect(continued).toMatchObject({ status: "practicing", latestGoal: "请改用已安装的 Node 再试", goalRevision: 2, feedbackDeadline: null });
    expect(tasks.listEvents(task.id).map((event) => event.kind)).toEqual([
      "created", "assessment_started", "practice_started", "practice_blocked", "goal_added", "feedback_received"
    ]);
  });

  it("holds an editor-stage practice task until the anchored suggestion is accepted or rejected", () => {
    const tasks = setup();
    const task = tasks.create("project", "验证正文中的说法");
    tasks.beginAssessment(task.id);
    tasks.beginPractice(task.id);
    tasks.beginDraft(task.id);
    const waiting = tasks.waitForEditConfirmation(task.id, "message-1");
    expect(waiting).toMatchObject({ status: "waiting_edit_confirmation", checkpoint: { editSuggestionGoalRevision: 1 } });
    expect(tasks.recoverInterrupted().some((item) => item.id === task.id)).toBe(false);
    expect(tasks.require(task.id).status).toBe("waiting_edit_confirmation");
    expect(tasks.listEvents(task.id).find((event) => event.kind === "edit_suggestion_ready")).toMatchObject({ payload: { messageId: "message-1" } });
    expect(tasks.resolveEditConfirmation(task.id, "accepted").status).toBe("completed");

    const rejected = tasks.create("project", "再次验证");
    tasks.beginAssessment(rejected.id);
    tasks.beginPractice(rejected.id);
    tasks.beginDraft(rejected.id);
    tasks.waitForEditConfirmation(rejected.id, "message-2");
    expect(tasks.resolveEditConfirmation(rejected.id, "rejected")).toMatchObject({ status: "completed_with_gaps", hasGaps: true });
  });

  it("continues queued goals after the current editor suggestion is resolved", () => {
    const tasks = setup();
    let task = tasks.create("project", "验证已写入草稿的说法");
    task = tasks.beginAssessment(task.id);
    task = tasks.beginPractice(task.id);
    task = tasks.beginDraft(task.id);
    tasks.waitForEditConfirmation(task.id, "message-queued");
    tasks.appendGoal(task.id, "继续验证新增的兼容性边界", "chat");

    const continued = tasks.resolveEditConfirmation(task.id, "accepted");

    expect(continued).toMatchObject({ status: "practicing", latestGoal: "继续验证新增的兼容性边界", goalRevision: 2 });
    expect(continued.checkpoint).not.toHaveProperty("editSuggestionGoalRevision");
    expect(continued.checkpoint).not.toHaveProperty("workflowId");
    expect(tasks.listEvents(task.id).at(-2)).toMatchObject({ kind: "edit_suggestion_accepted", payload: { queuedGoal: true } });
  });

  it("starts an additional editor practice on the same task and preserves the ordered goal history", () => {
    const tasks = setup();
    const task = tasks.create("project", "起草前验证主要结论");
    tasks.beginAssessment(task.id);
    tasks.beginPractice(task.id);
    tasks.beginDraft(task.id);

    const continued = tasks.beginAdditionalPracticeFromDraft(task.id, "补测一个边界情况");

    expect(continued).toMatchObject({ status: "practicing", goalRevision: 2, latestGoal: "补测一个边界情况", checkpoint: {} });
    expect(tasks.listEvents(task.id).map((event) => event.kind)).toEqual([
      "created", "assessment_started", "practice_started", "draft_started", "goal_added", "additional_practice_started"
    ]);
    expect(() => tasks.beginAdditionalPracticeFromDraft(task.id, "不应覆盖等待选择的状态")).toThrow("只有正文编辑阶段");
  });
});

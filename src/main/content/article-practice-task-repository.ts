import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type ArticlePracticeStatus =
  | "queued" | "assessing" | "practicing" | "waiting_permission"
  | "waiting_feedback" | "waiting_stop_choice" | "drafting"
  | "waiting_edit_confirmation" | "waiting_resume_choice"
  | "completed" | "completed_with_gaps" | "stopped" | "failed";

export interface ArticlePracticeCheckpoint {
  stepId?: string;
  uncertainSideEffect?: boolean;
  workflowId?: string;
  attemptId?: string;
  workflowGoalRevision?: number;
  editSuggestionGoalRevision?: number;
}

export interface ArticlePracticeTask {
  id: string;
  projectId: string;
  sourceType: "awen" | "legacy_manual";
  legacyExecutionRunId: string | null;
  status: ArticlePracticeStatus;
  goalRevision: number;
  latestGoal: string;
  draftBaselineHash: string | null;
  waitingReason: string | null;
  feedbackDeadline: string | null;
  resumeStatus: ArticlePracticeStatus | null;
  checkpoint: ArticlePracticeCheckpoint;
  hasGaps: boolean;
  eventSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArticlePracticeEvent {
  taskId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const TERMINAL: ReadonlySet<ArticlePracticeStatus> = new Set(["completed", "completed_with_gaps", "stopped", "failed"]);
const FEEDBACK_WAIT_MS = 5 * 60_000;

/** Durable decisions for one article's practice. Running tools is a separate concern. */
export class ArticlePracticeTaskRepository {
  constructor(private readonly db: Database.Database) {}

  create(projectId: string, goal: string, now = new Date()): ArticlePracticeTask {
    const normalizedGoal = requireGoal(goal);
    const id = randomUUID();
    const at = now.toISOString();
    this.db.transaction(() => {
      const active = this.findActive(projectId);
      if (active) throw new Error("这篇文章已有正在进行的实践任务；请把新要求并入当前任务。");
      this.db.prepare(`INSERT INTO article_practice_tasks
        (id, project_id, status, latest_goal, created_at, updated_at)
        VALUES (?, ?, 'queued', ?, ?, ?)`).run(id, projectId, normalizedGoal, at, at);
      this.appendEvent(id, "created", { goal: normalizedGoal }, at);
    })();
    return this.require(id);
  }

  findActive(projectId: string): ArticlePracticeTask | null {
    const row = this.db.prepare(`SELECT * FROM article_practice_tasks WHERE project_id = ?
      AND status NOT IN ('completed', 'completed_with_gaps', 'stopped', 'failed', 'waiting_edit_confirmation')
      ORDER BY created_at DESC LIMIT 1`).get(projectId) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  /** Returns the execution task first, while keeping an editorial-only task visible when idle. */
  findCurrent(projectId: string): ArticlePracticeTask | null {
    const row = this.db.prepare(`SELECT * FROM article_practice_tasks WHERE project_id = ?
      AND status NOT IN ('completed', 'completed_with_gaps', 'stopped', 'failed')
      ORDER BY CASE WHEN status = 'waiting_edit_confirmation' THEN 1 ELSE 0 END, created_at DESC
      LIMIT 1`).get(projectId) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  listRecent(projectId: string, limit = 8): ArticlePracticeTask[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("实践历史条数必须在 1 到 50 之间。");
    return (this.db.prepare(`SELECT * FROM article_practice_tasks WHERE project_id = ?
      ORDER BY updated_at DESC, created_at DESC LIMIT ?`).all(projectId, limit) as TaskRow[]).map(toTask);
  }

  require(taskId: string): ArticlePracticeTask {
    const row = this.db.prepare("SELECT * FROM article_practice_tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
    if (!row) throw new Error("找不到自主实践任务。");
    return toTask(row);
  }

  listEvents(taskId: string): ArticlePracticeEvent[] {
    return (this.db.prepare(`SELECT task_id AS taskId, sequence, kind, payload_json AS payloadJson,
      created_at AS createdAt FROM article_practice_task_events WHERE task_id = ? ORDER BY sequence`).all(taskId) as EventRow[])
      .map((row) => ({ taskId: row.taskId, sequence: row.sequence, kind: row.kind, payload: JSON.parse(row.payloadJson) as Record<string, unknown>, createdAt: row.createdAt }));
  }

  appendGoal(taskId: string, goal: string, source: "draft" | "chat", now = new Date()): ArticlePracticeTask {
    const normalizedGoal = requireGoal(goal);
    const at = now.toISOString();
    this.db.transaction(() => {
      const current = this.require(taskId);
      if (TERMINAL.has(current.status)) throw new Error("已结束的任务不能追加目标。");
      this.db.prepare(`UPDATE article_practice_tasks SET goal_revision = goal_revision + 1,
        latest_goal = ?, updated_at = ? WHERE id = ?`).run(normalizedGoal, at, taskId);
      this.appendEvent(taskId, "goal_added", { goal: normalizedGoal, source, revision: current.goalRevision + 1 }, at);
    })();
    return this.require(taskId);
  }

  beginAdditionalPracticeFromDraft(taskId: string, goal: string, now = new Date()): ArticlePracticeTask {
    const normalizedGoal = requireGoal(goal);
    const at = now.toISOString();
    this.db.transaction(() => {
      const current = this.require(taskId);
      if (current.status !== "drafting") throw new Error("只有正文编辑阶段可以直接追加一轮实践；其他等待状态需先处理当前选择。");
      const revision = current.goalRevision + 1;
      this.db.prepare(`UPDATE article_practice_tasks SET status = 'practicing', goal_revision = ?,
        latest_goal = ?, checkpoint_json = '{}', waiting_reason = NULL, feedback_deadline = NULL,
        resume_status = NULL, updated_at = ? WHERE id = ?`)
        .run(revision, normalizedGoal, at, taskId);
      this.appendEvent(taskId, "goal_added", { goal: normalizedGoal, source: "chat", revision }, at);
      this.appendEvent(taskId, "additional_practice_started", { from: current.status, to: "practicing", revision }, at);
    })();
    return this.require(taskId);
  }

  beginAssessment(taskId: string, now = new Date()): ArticlePracticeTask {
    return this.move(taskId, ["queued"], "assessing", "assessment_started", {}, now);
  }

  beginPractice(taskId: string, now = new Date()): ArticlePracticeTask {
    return this.move(taskId, ["assessing"], "practicing", "practice_started", {}, now);
  }

  waitForPermission(taskId: string, reason: string, now = new Date()): ArticlePracticeTask {
    return this.move(taskId, ["practicing"], "waiting_permission", "permission_needed", { reason }, now);
  }

  permissionResolved(taskId: string, now = new Date()): ArticlePracticeTask {
    return this.move(taskId, ["waiting_permission"], "practicing", "permission_resolved", {}, now);
  }

  waitForFeedback(taskId: string, reason: string, now = new Date()): ArticlePracticeTask {
    const deadline = new Date(now.getTime() + FEEDBACK_WAIT_MS).toISOString();
    return this.move(taskId, ["practicing", "waiting_permission"], "waiting_feedback", "practice_blocked", { reason, deadline }, now);
  }

  expireFeedback(taskId: string, now = new Date()): ArticlePracticeTask {
    const task = this.require(taskId);
    if (task.status !== "waiting_feedback") throw new Error("当前任务不在等待失败反馈。");
    if (!task.feedbackDeadline || Date.parse(task.feedbackDeadline) > now.getTime()) return task;
    return this.move(taskId, ["waiting_feedback"], "drafting", "feedback_expired", { hasGaps: true }, now);
  }

  resumeAfterFeedback(taskId: string, now = new Date()): ArticlePracticeTask {
    return this.move(taskId, ["waiting_feedback"], "practicing", "feedback_received", {}, now);
  }

  beginDraft(taskId: string, hasGaps = false, now = new Date()): ArticlePracticeTask {
    return this.move(taskId, ["assessing", "practicing", "waiting_feedback"], "drafting", "draft_started", { hasGaps }, now);
  }

  waitForEditConfirmation(taskId: string, messageId: string, now = new Date()): ArticlePracticeTask {
    const task = this.move(taskId, ["drafting"], "waiting_edit_confirmation", "edit_suggestion_ready", { messageId }, now);
    return this.saveCheckpoint(taskId, { ...task.checkpoint, editSuggestionGoalRevision: task.checkpoint.workflowGoalRevision ?? task.goalRevision }, now);
  }

  resolveEditConfirmation(taskId: string, decision: "accepted" | "rejected" | "unavailable", now = new Date()): ArticlePracticeTask {
    const current = this.require(taskId);
    const queuedGoal = current.goalRevision > (current.checkpoint.editSuggestionGoalRevision ?? current.goalRevision);
    const next = queuedGoal ? "practicing" : decision === "accepted" ? "completed" : "completed_with_gaps";
    let updated = this.move(taskId, ["waiting_edit_confirmation"], next, `edit_suggestion_${decision}`, { decision, hasGaps: decision !== "accepted", queuedGoal }, now);
    if (queuedGoal) {
      const checkpoint = { ...updated.checkpoint };
      delete checkpoint.workflowId;
      delete checkpoint.editSuggestionGoalRevision;
      delete checkpoint.workflowGoalRevision;
      updated = this.saveCheckpoint(taskId, checkpoint, now);
    }
    return updated;
  }

  requestStop(taskId: string, now = new Date()): ArticlePracticeTask {
    return this.move(taskId, ["assessing", "practicing", "waiting_permission", "waiting_feedback"],
      "waiting_stop_choice", "stop_requested", {}, now);
  }

  resolveStop(taskId: string, choice: "draft_with_gaps" | "stop", now = new Date()): ArticlePracticeTask {
    return this.move(taskId, ["waiting_stop_choice"], choice === "stop" ? "stopped" : "drafting",
      "stop_choice", { choice, hasGaps: choice === "draft_with_gaps" }, now);
  }

  resolveStopWithGoal(taskId: string, goal: string, now = new Date()): ArticlePracticeTask {
    const normalizedGoal = requireGoal(goal);
    const at = now.toISOString();
    this.db.transaction(() => {
      const current = this.require(taskId);
      if (current.status !== "waiting_stop_choice") throw new Error("当前任务没有等待停止后的新指示。");
      this.db.prepare(`UPDATE article_practice_tasks SET status = 'assessing', goal_revision = goal_revision + 1,
        latest_goal = ?, waiting_reason = NULL, feedback_deadline = NULL, checkpoint_json = '{}', updated_at = ? WHERE id = ?`)
        .run(normalizedGoal, at, taskId);
      this.appendEvent(taskId, "stop_choice", { choice: "new_goal", goal: normalizedGoal, revision: current.goalRevision + 1 }, at);
    })();
    return this.require(taskId);
  }

  saveCheckpoint(taskId: string, checkpoint: ArticlePracticeCheckpoint, now = new Date()): ArticlePracticeTask {
    const at = now.toISOString();
    this.db.transaction(() => {
      const current = this.require(taskId);
      if (TERMINAL.has(current.status)) throw new Error("已结束的任务不能保存新检查点。");
      this.db.prepare("UPDATE article_practice_tasks SET checkpoint_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(checkpoint), at, taskId);
      this.appendEvent(taskId, "checkpoint", { stepId: checkpoint.stepId ?? null, uncertainSideEffect: Boolean(checkpoint.uncertainSideEffect) }, at);
    })();
    return this.require(taskId);
  }

  recordPracticeResult(taskId: string, evidence: Record<string, unknown>, now = new Date()): ArticlePracticeTask {
    const serialized = JSON.stringify(evidence);
    if (serialized.length > 80_000) throw new Error("实践结果超出可保存范围。");
    const at = now.toISOString();
    this.db.transaction(() => {
      const task = this.require(taskId);
      if (TERMINAL.has(task.status)) throw new Error("已结束的实践任务不能追加结果。");
      this.appendEvent(taskId, "practice_result", evidence, at);
    })();
    return this.require(taskId);
  }

  recordProjectFileRestored(taskId: string, evidence: { id: string; relativePath: string }, now = new Date()): void {
    const at = now.toISOString();
    this.db.transaction(() => {
      this.require(taskId);
      this.appendEvent(taskId, "practice_result", { kind: "project_file_change_restored", ...evidence }, at);
    })();
  }

  recoverInterrupted(now = new Date()): ArticlePracticeTask[] {
    const rows = this.db.prepare(`SELECT id FROM article_practice_tasks WHERE status NOT IN
      ('completed', 'completed_with_gaps', 'stopped', 'failed', 'waiting_resume_choice', 'waiting_stop_choice', 'waiting_edit_confirmation')`).all() as Array<{ id: string }>;
    return rows.map(({ id }) => {
      const original = this.require(id);
      return this.move(id, [original.status], "waiting_resume_choice", "resume_choice_needed",
        { resumeStatus: original.status }, now);
    });
  }

  resume(taskId: string, now = new Date()): { task: ArticlePracticeTask; needsReconciliation: boolean } {
    const current = this.require(taskId);
    if (current.status !== "waiting_resume_choice" || !current.resumeStatus) throw new Error("当前任务无需恢复。");
    if (current.checkpoint.uncertainSideEffect) return { task: current, needsReconciliation: true };
    const expired = current.resumeStatus === "waiting_feedback" && Boolean(current.feedbackDeadline) && Date.parse(current.feedbackDeadline!) <= now.getTime();
    return { task: this.move(taskId, ["waiting_resume_choice"], expired ? "drafting" : current.resumeStatus,
      "resumed", { resumedFrom: current.resumeStatus, hasGaps: expired }, now), needsReconciliation: false };
  }

  declineResume(taskId: string, choice: "draft_with_gaps" | "stop", now = new Date()): ArticlePracticeTask {
    const current = this.require(taskId);
    if (current.status !== "waiting_resume_choice") throw new Error("当前任务没有等待恢复选择。");
    return this.move(taskId, ["waiting_resume_choice"], choice === "stop" ? "stopped" : "drafting",
      "resume_choice", { choice, hasGaps: choice === "draft_with_gaps" }, now);
  }

  markReconciled(taskId: string, outcome: string, now = new Date()): ArticlePracticeTask {
    const current = this.require(taskId);
    if (current.status !== "waiting_resume_choice" || !current.checkpoint.uncertainSideEffect) throw new Error("没有待核对的中断步骤。");
    const summary = outcome.trim();
    if (!summary || summary.length > 1000) throw new Error("请记录核对结果。");
    const at = now.toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE article_practice_tasks SET checkpoint_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ ...current.checkpoint, uncertainSideEffect: false }), at, taskId);
      this.appendEvent(taskId, "reconciled", { stepId: current.checkpoint.stepId ?? null, outcome: summary }, at);
    })();
    return this.require(taskId);
  }

  finish(taskId: string, now = new Date()): ArticlePracticeTask {
    const current = this.require(taskId);
    return this.move(taskId, ["drafting"], current.hasGaps ? "completed_with_gaps" : "completed", "draft_completed", {}, now);
  }

  private move(taskId: string, expected: ArticlePracticeStatus[], next: ArticlePracticeStatus,
    kind: string, details: Record<string, unknown>, now: Date): ArticlePracticeTask {
    const at = now.toISOString();
    this.db.transaction(() => {
      const current = this.require(taskId);
      if (!expected.includes(current.status)) throw new Error(`实践任务当前为 ${current.status}，不能转为 ${next}。`);
      const reason = typeof details.reason === "string" ? details.reason : null;
      const deadline = typeof details.deadline === "string" ? details.deadline : null;
      const resumeStatus = typeof details.resumeStatus === "string" ? details.resumeStatus : null;
      this.db.prepare(`UPDATE article_practice_tasks SET status = ?,
        waiting_reason = CASE WHEN ? = 'waiting_resume_choice' THEN waiting_reason
          WHEN ? IN ('waiting_permission', 'waiting_feedback', 'waiting_stop_choice') THEN COALESCE(?, waiting_reason)
          ELSE NULL END,
        feedback_deadline =
        CASE WHEN ? = 'waiting_feedback' THEN COALESCE(?, feedback_deadline)
          WHEN ? = 'waiting_resume_choice' THEN feedback_deadline ELSE NULL END,
        resume_status = ?, has_gaps = CASE WHEN ? THEN 1 ELSE has_gaps END,
        updated_at = ? WHERE id = ?`)
        .run(next, next, next, reason, next, deadline, next, resumeStatus, details.hasGaps === true ? 1 : 0, at, taskId);
      this.appendEvent(taskId, kind, { from: current.status, to: next, ...details }, at);
    })();
    return this.require(taskId);
  }

  private appendEvent(taskId: string, kind: string, payload: Record<string, unknown>, at: string): void {
    const next = this.db.prepare("UPDATE article_practice_tasks SET event_seq = event_seq + 1 WHERE id = ? RETURNING event_seq AS sequence")
      .get(taskId) as { sequence: number } | undefined;
    if (!next) throw new Error("找不到自主实践任务。");
    this.db.prepare(`INSERT INTO article_practice_task_events
      (task_id, sequence, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(taskId, next.sequence, kind, JSON.stringify(payload), at);
  }
}

function requireGoal(goal: string): string {
  const normalized = goal.trim();
  if (!normalized || normalized.length > 4000) throw new Error("实践目标应在 1 到 4000 个字符之间。");
  return normalized;
}

interface TaskRow {
  id: string; project_id: string; source_type: "awen" | "legacy_manual"; legacy_execution_run_id: string | null;
  status: ArticlePracticeStatus; goal_revision: number;
  latest_goal: string; draft_baseline_hash: string | null; waiting_reason: string | null;
  feedback_deadline: string | null; resume_status: ArticlePracticeStatus | null;
  checkpoint_json: string; has_gaps: number; event_seq: number; created_at: string; updated_at: string;
}

interface EventRow { taskId: string; sequence: number; kind: string; payloadJson: string; createdAt: string }

function toTask(row: TaskRow): ArticlePracticeTask {
  return {
    id: row.id, projectId: row.project_id, status: row.status,
    sourceType: row.source_type, legacyExecutionRunId: row.legacy_execution_run_id,
    goalRevision: row.goal_revision, latestGoal: row.latest_goal,
    draftBaselineHash: row.draft_baseline_hash, waitingReason: row.waiting_reason,
    feedbackDeadline: row.feedback_deadline, resumeStatus: row.resume_status,
    checkpoint: JSON.parse(row.checkpoint_json) as ArticlePracticeCheckpoint,
    hasGaps: Boolean(row.has_gaps), eventSeq: row.event_seq,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

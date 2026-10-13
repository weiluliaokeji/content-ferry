import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { DraftDepthPreference, DraftRunCheckpoint, DraftRunEvent, DraftRunEventKind, DraftRunStage, DraftRunStatus } from "../../shared/draft-workflow";

export interface ArticleDraftRun {
  id: string;
  projectId: string;
  status: DraftRunStatus;
  stage: DraftRunStage;
  depthPreference: DraftDepthPreference;
  depthPlan: Record<string, unknown>;
  scope: Record<string, unknown>;
  outlineRevisionSha256: string | null;
  draftRevisionSha256: string | null;
  checkpoint: DraftRunCheckpoint;
  createdAt: string;
  updatedAt: string;
}

export interface DraftRunRecoverySnapshot {
  currentArticleRevisionSha256: string | null;
  currentOutlineRevisionSha256: string | null;
  adoptedResearchCardIds: string[];
  practiceTask?: {
    id: string;
    status: string;
    workflowStatus?: string;
    authorizationState: "not_pending" | "requires_reconfirmation" | "workflow_unavailable";
  };
}

interface RunRow extends Record<string, unknown> {
  id: string; project_id: string; status: DraftRunStatus; stage: DraftRunStage; depth_preference: DraftDepthPreference;
  depth_plan_json: string; scope_json: string; outline_revision_sha256: string | null; draft_revision_sha256: string | null;
  checkpoint_json: string; created_at: string; updated_at: string;
}
interface EventRow extends Record<string, unknown> {
  run_id: string; sequence: number; kind: DraftRunEventKind; stage: DraftRunStage; summary: string; payload_json: string; created_at: string;
}

export class ArticleDraftRunRepository {
  constructor(private readonly db: Database.Database) {}

  create(projectId: string, depthPreference: DraftDepthPreference = null, scope: Record<string, unknown> = {}, now = new Date()): ArticleDraftRun {
    this.assertProject(projectId);
    const id = randomUUID();
    const at = now.toISOString();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO article_draft_runs
        (id, project_id, status, stage, depth_preference, scope_json, created_at, updated_at)
        VALUES (?, ?, 'running', 'planning_depth', ?, ?, ?, ?)`).run(id, projectId, depthPreference, JSON.stringify(scope), at, at);
      this.appendEventInTransaction(id, "stage_started", "planning_depth", "正在规划正文深度。", {}, at);
    })();
    return this.require(id);
  }

  getActive(projectId: string): ArticleDraftRun | null {
    this.assertProject(projectId);
    const row = this.db.prepare("SELECT * FROM article_draft_runs WHERE project_id = ? AND status IN ('running', 'waiting_author') ORDER BY updated_at DESC LIMIT 1")
      .get(projectId) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  getLatest(projectId: string): ArticleDraftRun | null {
    this.assertProject(projectId);
    const row = this.db.prepare("SELECT * FROM article_draft_runs WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1")
      .get(projectId) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  listInterrupted(): ArticleDraftRun[] {
    return (this.db.prepare("SELECT * FROM article_draft_runs WHERE status = 'running' ORDER BY updated_at")
      .all() as RunRow[]).map(toRun);
  }

  reconcileInterrupted(runId: string, snapshot: DraftRunRecoverySnapshot, now = new Date()): ArticleDraftRun {
    const at = now.toISOString();
    this.db.transaction(() => {
      const run = this.require(runId);
      if (run.status !== "running") return;
      const reason = "应用关闭或重启时正文任务仍在运行；已保留检查点和进度，不会重放调研、实践或授权操作。重新起草前请核对当前文章与活动记录。";
      const checkpoint: DraftRunCheckpoint = {
        ...run.checkpoint,
        ...(snapshot.currentArticleRevisionSha256 ? { recoveredArticleRevisionSha256: snapshot.currentArticleRevisionSha256 } : {}),
        ...(snapshot.currentOutlineRevisionSha256 ? { recoveredOutlineRevisionSha256: snapshot.currentOutlineRevisionSha256 } : {}),
        recoveredResearchCardIds: snapshot.adoptedResearchCardIds,
        ...(snapshot.practiceTask ? {
          recoveredPracticeTaskId: snapshot.practiceTask.id,
          recoveredPracticeTaskStatus: snapshot.practiceTask.status,
          ...(snapshot.practiceTask.workflowStatus ? { recoveredPracticeWorkflowStatus: snapshot.practiceTask.workflowStatus } : {}),
          recoveredAuthorizationState: snapshot.practiceTask.authorizationState
        } : {}),
        stoppingReason: reason
      };
      this.db.prepare(`UPDATE article_draft_runs SET status = 'needs_author', stage = 'needs_author',
        checkpoint_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(checkpoint), at, runId);
      this.appendEventInTransaction(runId, "stopped", "needs_author", reason, {
        recoveredAfterRestart: true, candidateNeedsRevalidation: true,
        sourceArticleChanged: Boolean(run.checkpoint.sourceArticleRevisionSha256 && snapshot.currentArticleRevisionSha256
          && run.checkpoint.sourceArticleRevisionSha256 !== snapshot.currentArticleRevisionSha256),
        outlineChanged: Boolean(run.outlineRevisionSha256 && snapshot.currentOutlineRevisionSha256
          && run.outlineRevisionSha256 !== snapshot.currentOutlineRevisionSha256),
        adoptedResearchCardCount: snapshot.adoptedResearchCardIds.length,
        ...(snapshot.practiceTask ? {
          practiceTaskStatus: snapshot.practiceTask.status,
          practiceWorkflowStatus: snapshot.practiceTask.workflowStatus ?? null,
          authorizationState: snapshot.practiceTask.authorizationState
        } : { practiceTaskStatus: null, practiceWorkflowStatus: null, authorizationState: "not_pending" })
      }, at);
    })();
    return this.require(runId);
  }

  require(runId: string): ArticleDraftRun {
    const row = this.db.prepare("SELECT * FROM article_draft_runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (!row) throw new Error("找不到正文起草运行记录。");
    return toRun(row);
  }

  listEvents(runId: string, afterSequence = 0, limit = 500): DraftRunEvent[] {
    this.require(runId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error("正文事件游标无效。");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("正文事件读取数量必须在 1 到 1000 之间。");
    return (this.db.prepare(`SELECT run_id, sequence, kind, stage, summary, payload_json, created_at
      FROM article_draft_run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`)
      .all(runId, afterSequence, limit) as EventRow[]).map(toEvent);
  }

  appendEvent(runId: string, kind: DraftRunEventKind, stage: DraftRunStage, summary: string, payload: Record<string, unknown> = {}, now = new Date()): DraftRunEvent {
    const at = now.toISOString();
    return this.db.transaction(() => {
      const run = this.require(runId);
      if (isTerminal(run.status)) throw new Error("已结束的正文起草运行不能追加事件。");
      const sequence = this.appendEventInTransaction(runId, kind, stage, summary, payload, at);
      this.db.prepare("UPDATE article_draft_runs SET stage = ?, updated_at = ? WHERE id = ?").run(stage, at, runId);
      return { runId, sequence, kind, stage, summary, payload, createdAt: at };
    })();
  }

  updateCheckpoint(runId: string, checkpoint: DraftRunCheckpoint, updates: {
    status?: DraftRunStatus; stage?: DraftRunStage; depthPlan?: Record<string, unknown>;
    outlineRevisionSha256?: string | null; draftRevisionSha256?: string | null;
  } = {}, now = new Date()): ArticleDraftRun {
    const at = now.toISOString();
    this.db.transaction(() => {
      const run = this.require(runId);
      if (isTerminal(run.status)) throw new Error("已结束的正文起草运行不能更新检查点。");
      const status = updates.status ?? run.status;
      const stage = updates.stage ?? run.stage;
      this.db.prepare(`UPDATE article_draft_runs SET status = ?, stage = ?, checkpoint_json = ?,
        depth_plan_json = ?, outline_revision_sha256 = ?, draft_revision_sha256 = ?, updated_at = ? WHERE id = ?`)
        .run(status, stage, JSON.stringify({ ...run.checkpoint, ...checkpoint }), JSON.stringify(updates.depthPlan ?? run.depthPlan),
          updates.outlineRevisionSha256 === undefined ? run.outlineRevisionSha256 : updates.outlineRevisionSha256,
          updates.draftRevisionSha256 === undefined ? run.draftRevisionSha256 : updates.draftRevisionSha256, at, runId);
      this.appendEventInTransaction(runId, "checkpoint_updated", stage, "已保存正文起草检查点。", {
        status, hasOutlineRevision: Boolean(updates.outlineRevisionSha256 ?? run.outlineRevisionSha256),
        hasDraftRevision: Boolean(updates.draftRevisionSha256 ?? run.draftRevisionSha256)
      }, at);
    })();
    return this.require(runId);
  }

  finish(runId: string, status: Extract<DraftRunStatus, "passed" | "needs_author" | "failed" | "cancelled">,
    stage: Extract<DraftRunStage, "passed" | "needs_author" | "failed" | "cancelled">, summary: string, payload: Record<string, unknown> = {}, now = new Date()): ArticleDraftRun {
    const at = now.toISOString();
    this.db.transaction(() => {
      const current = this.require(runId);
      if (isTerminal(current.status)) throw new Error("正文起草运行已结束。");
      this.db.prepare("UPDATE article_draft_runs SET status = ?, stage = ?, updated_at = ? WHERE id = ?").run(status, stage, at, runId);
      this.appendEventInTransaction(runId, status === "passed" ? "completed" : status === "failed" ? "failed" : "stopped", stage, summary, payload, at);
    })();
    return this.require(runId);
  }

  private appendEventInTransaction(runId: string, kind: DraftRunEventKind, stage: DraftRunStage, summary: string, payload: Record<string, unknown>, at: string): number {
    const sequence = Number((this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM article_draft_run_events WHERE run_id = ?").get(runId) as { sequence: number }).sequence);
    this.db.prepare(`INSERT INTO article_draft_run_events (run_id, sequence, kind, stage, summary, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(runId, sequence, kind, stage, summary.trim().slice(0, 500), JSON.stringify(payload), at);
    return sequence;
  }

  private assertProject(projectId: string): void {
    if (!this.db.prepare("SELECT 1 FROM content_projects WHERE id = ?").get(projectId)) throw new Error("Content project not found.");
  }
}

function isTerminal(status: DraftRunStatus): boolean { return status === "passed" || status === "needs_author" || status === "failed" || status === "cancelled"; }
function toRun(row: RunRow): ArticleDraftRun {
  return { id: row.id, projectId: row.project_id, status: row.status, stage: row.stage, depthPreference: row.depth_preference,
    depthPlan: parseObject(row.depth_plan_json), scope: parseObject(row.scope_json), outlineRevisionSha256: row.outline_revision_sha256,
    draftRevisionSha256: row.draft_revision_sha256, checkpoint: parseObject(row.checkpoint_json) as DraftRunCheckpoint,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
function toEvent(row: EventRow): DraftRunEvent {
  return { runId: row.run_id, sequence: Number(row.sequence), kind: row.kind, stage: row.stage, summary: row.summary,
    payload: parseObject(row.payload_json), createdAt: row.created_at };
}
function parseObject(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("正文起草检查点格式无效。");
  return value as Record<string, unknown>;
}

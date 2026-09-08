import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type ResearchTaskKind = "generate" | "follow_up";
export type ResearchTaskStatus = "queued" | "running" | "waiting_user" | "paused" | "completed" | "completed_with_warnings" | "failed" | "cancelled";

export interface ResearchTaskRecord {
  id: string;
  projectId: string;
  kind: ResearchTaskKind;
  requestHash: string;
  request: unknown;
  status: ResearchTaskStatus;
  resultState: "proposed" | "accepted";
  currentStepId: string | null;
  cancelRequested: boolean;
  attempt: number;
  lastCheckpoint: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
  lastHeartbeatAt: string;
}

export class ResearchTaskRepository {
  constructor(private readonly db: Database.Database) {}

  create(projectId: string, kind: ResearchTaskKind, request: unknown): ResearchTaskRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO research_tasks
        (id, project_id, kind, request_hash, request_json, status, created_at, updated_at, last_heartbeat_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
        .run(id, projectId, kind, requestHash, JSON.stringify(request), now, now, now);
      this.appendEvent(id, "queued", { kind, requestHash });
    })();
    return this.require(id);
  }

  require(taskId: string): ResearchTaskRecord {
    const row = this.db.prepare(`SELECT id, project_id AS projectId, kind, request_hash AS requestHash,
      request_json AS requestJson,
      status, result_state AS resultState, current_step_id AS currentStepId,
      cancel_requested AS cancelRequested, attempt, last_checkpoint AS lastCheckpoint,
      last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt,
      last_heartbeat_at AS lastHeartbeatAt FROM research_tasks WHERE id = ?`).get(taskId) as ResearchTaskRow | undefined;
    if (!row) throw new Error("找不到研究任务。");
    return toTask(row);
  }

  list(projectId: string): ResearchTaskRecord[] {
    const rows = this.db.prepare(`SELECT id, project_id AS projectId, kind, request_hash AS requestHash,
      request_json AS requestJson,
      status, result_state AS resultState, current_step_id AS currentStepId,
      cancel_requested AS cancelRequested, attempt, last_checkpoint AS lastCheckpoint,
      last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt,
      last_heartbeat_at AS lastHeartbeatAt FROM research_tasks WHERE project_id = ? ORDER BY updated_at DESC`).all(projectId) as ResearchTaskRow[];
    return rows.map(toTask);
  }

  listRecoverable(): ResearchTaskRecord[] {
    const rows = this.db.prepare(`SELECT id, project_id AS projectId, kind, request_hash AS requestHash,
      request_json AS requestJson,
      status, result_state AS resultState, current_step_id AS currentStepId,
      cancel_requested AS cancelRequested, attempt, last_checkpoint AS lastCheckpoint,
      last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt,
      last_heartbeat_at AS lastHeartbeatAt FROM research_tasks
      WHERE status = 'queued' AND cancel_requested = 0 ORDER BY updated_at ASC`).all() as ResearchTaskRow[];
    return rows.map(toTask);
  }

  recoverInterrupted(staleAfterMs = 30_000): number {
    const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
    const rows = this.db.prepare(`SELECT id FROM research_tasks
      WHERE status = 'running' AND cancel_requested = 0 AND last_heartbeat_at <= ?`).all(cutoff) as Array<{ id: string }>;
    for (const row of rows) {
      this.transition(row.id, "queued", { checkpoint: "应用重启后重新排队。" });
    }
    return rows.length;
  }

  claim(taskId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE research_tasks SET status = 'running', attempt = attempt + 1,
      updated_at = ?, last_heartbeat_at = ?
      WHERE id = ? AND status = 'queued' AND cancel_requested = 0`).run(now, now, taskId);
    if (result.changes === 0) return false;
    this.appendEvent(taskId, "running", { checkpoint: "后台恢复任务开始执行。" });
    return true;
  }

  transition(taskId: string, status: ResearchTaskStatus, details: { checkpoint?: string; error?: string; stepId?: string; resultState?: "proposed" | "accepted" } = {}): ResearchTaskRecord {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE research_tasks SET status = ?, current_step_id = COALESCE(?, current_step_id),
        last_checkpoint = COALESCE(?, last_checkpoint), last_error = COALESCE(?, last_error),
        result_state = COALESCE(?, result_state), updated_at = ?, last_heartbeat_at = ? WHERE id = ?`)
        .run(status, details.stepId ?? null, details.checkpoint ?? null, details.error ?? null, details.resultState ?? null, now, now, taskId);
      this.appendEvent(taskId, status, details);
    })();
    return this.require(taskId);
  }

  heartbeat(taskId: string, message: string): ResearchTaskRecord {
    return this.transition(taskId, "running", { checkpoint: message });
  }

  requestCancel(taskId: string): ResearchTaskRecord {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE research_tasks SET cancel_requested = 1, status = CASE WHEN status IN ('queued', 'running') THEN 'cancelled' ELSE status END, updated_at = ?, last_heartbeat_at = ? WHERE id = ?")
        .run(now, now, taskId);
      this.appendEvent(taskId, "cancel_requested", {});
    })();
    return this.require(taskId);
  }

  requestPause(taskId: string): ResearchTaskRecord {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE research_tasks SET status = CASE WHEN status IN ('queued', 'running') THEN 'paused' ELSE status END, updated_at = ?, last_heartbeat_at = ?, last_checkpoint = ? WHERE id = ?")
        .run(now, now, "已暂停，等待用户继续。", taskId);
      this.appendEvent(taskId, "paused", { checkpoint: "已暂停，等待用户继续。" });
    })();
    return this.require(taskId);
  }

  resume(taskId: string): ResearchTaskRecord {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE research_tasks SET status = 'queued', cancel_requested = 0, updated_at = ?, last_heartbeat_at = ?, last_checkpoint = ? WHERE id = ? AND status = 'paused'")
      .run(now, now, "已恢复，等待后台继续。", taskId);
    if (result.changes > 0) this.appendEvent(taskId, "resumed", { checkpoint: "已恢复，等待后台继续。" });
    return this.require(taskId);
  }

  isPaused(taskId: string): boolean {
    const row = this.db.prepare("SELECT status FROM research_tasks WHERE id = ?").get(taskId) as { status?: ResearchTaskStatus } | undefined;
    return row?.status === "paused";
  }

  isCancelRequested(taskId: string): boolean {
    const row = this.db.prepare("SELECT cancel_requested AS cancelRequested FROM research_tasks WHERE id = ?").get(taskId) as { cancelRequested: number } | undefined;
    return Boolean(row?.cancelRequested);
  }

  saveCheckpoint(taskId: string, stepId: string, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    if (serialized.length > 2_000_000) throw new Error("研究任务检查点过大，未保存。");
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare("UPDATE research_tasks SET current_step_id = ?, last_checkpoint = ?, updated_at = ?, last_heartbeat_at = ? WHERE id = ?")
        .run(stepId, `已保存检查点：${stepId}`, now, now, taskId);
      this.appendEvent(taskId, "checkpoint", { stepId, payload });
    })();
  }

  getCheckpoint<T>(taskId: string, stepId: string): T | undefined {
    const row = this.db.prepare(`SELECT payload_json AS payloadJson FROM research_task_events
      WHERE task_id = ? AND event_type = 'checkpoint' ORDER BY created_at DESC LIMIT 20`).all(taskId) as Array<{ payloadJson: string }>;
    for (const event of row) {
      try {
        const payload = JSON.parse(event.payloadJson) as { stepId?: string; payload?: T };
        if (payload.stepId === stepId) return payload.payload;
      } catch { /* ignore malformed historical events */ }
    }
    return undefined;
  }

  private appendEvent(taskId: string, eventType: string, payload: unknown): void {
    this.db.prepare("INSERT INTO research_task_events (id, task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), taskId, eventType, JSON.stringify(payload), new Date().toISOString());
  }
}

interface ResearchTaskRow {
  id: string; projectId: string; kind: ResearchTaskKind; requestHash: string;
  requestJson: string;
  status: ResearchTaskStatus; resultState: "proposed" | "accepted"; currentStepId: string | null;
  cancelRequested: number; attempt: number; lastCheckpoint: string; lastError: string;
  createdAt: string; updatedAt: string; lastHeartbeatAt: string;
}

function toTask(row: ResearchTaskRow): ResearchTaskRecord {
  let request: unknown = {};
  try {
    request = JSON.parse(row.requestJson);
  } catch {
    request = {};
  }
  return { ...row, request, cancelRequested: Boolean(row.cancelRequested) };
}

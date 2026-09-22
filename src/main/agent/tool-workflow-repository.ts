import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { ToolWorkflowEvent, ToolWorkflowSnapshot } from "./tool-workflow-runner";

export interface StoredToolWorkflow {
  snapshot: ToolWorkflowSnapshot;
  projectId?: string;
  contextKey: string;
  input?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export class ToolWorkflowRepository {
  constructor(private readonly db: Database.Database) {}

  save(snapshot: ToolWorkflowSnapshot, input: { contextKey: string; projectId?: string; request?: Record<string, unknown> }): StoredToolWorkflow {
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT created_at AS createdAt FROM agent_tool_workflows WHERE id = ?")
      .get(snapshot.workflowId) as { createdAt?: string } | undefined;
    this.db.prepare(`INSERT INTO agent_tool_workflows
      (id, project_id, context_key, input_json, status, round, user_request, transcript_json, events_json, tool_results_json, pending_permission_json, final_text, warning_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, context_key = excluded.context_key,
        input_json = excluded.input_json,
        status = excluded.status, round = excluded.round, user_request = excluded.user_request,
        transcript_json = excluded.transcript_json, events_json = excluded.events_json,
        tool_results_json = excluded.tool_results_json,
        pending_permission_json = excluded.pending_permission_json, final_text = excluded.final_text,
        warning_count = excluded.warning_count, updated_at = excluded.updated_at`).run(
      snapshot.workflowId,
      input.projectId ?? null,
      input.contextKey,
      JSON.stringify(input.request ?? {}),
      snapshot.status,
      snapshot.round,
      snapshot.userRequest,
      JSON.stringify(snapshot.transcript),
      JSON.stringify(snapshot.events),
      JSON.stringify(snapshot.toolResults),
      JSON.stringify(snapshot.pendingPermission),
      snapshot.finalText,
      snapshot.warningCount,
      existing?.createdAt ?? now,
      now
    );
    return { snapshot, projectId: input.projectId, contextKey: input.contextKey, input: input.request ?? {}, createdAt: existing?.createdAt ?? now, updatedAt: now };
  }

  require(id: string): StoredToolWorkflow {
    const row = this.db.prepare(`SELECT id, project_id AS projectId, context_key AS contextKey, input_json AS inputJson, status, round, user_request AS userRequest,
      transcript_json AS transcriptJson, events_json AS eventsJson, tool_results_json AS toolResultsJson, pending_permission_json AS pendingPermissionJson,
      final_text AS finalText, warning_count AS warningCount, created_at AS createdAt, updated_at AS updatedAt
      FROM agent_tool_workflows WHERE id = ?`).get(id) as ToolWorkflowRow | undefined;
    if (!row) throw new Error("找不到阿文工具工作流记录。");
    return toStoredWorkflow(row);
  }

  list(contextKey?: string): StoredToolWorkflow[] {
    const rows = contextKey
      ? this.db.prepare(`SELECT id, project_id AS projectId, context_key AS contextKey, input_json AS inputJson, status, round, user_request AS userRequest,
          transcript_json AS transcriptJson, events_json AS eventsJson, tool_results_json AS toolResultsJson, pending_permission_json AS pendingPermissionJson,
          final_text AS finalText, warning_count AS warningCount, created_at AS createdAt, updated_at AS updatedAt
          FROM agent_tool_workflows WHERE context_key = ? ORDER BY updated_at DESC LIMIT 100`).all(contextKey) as ToolWorkflowRow[]
      : this.db.prepare(`SELECT id, project_id AS projectId, context_key AS contextKey, input_json AS inputJson, status, round, user_request AS userRequest,
          transcript_json AS transcriptJson, events_json AS eventsJson, tool_results_json AS toolResultsJson, pending_permission_json AS pendingPermissionJson,
          final_text AS finalText, warning_count AS warningCount, created_at AS createdAt, updated_at AS updatedAt
          FROM agent_tool_workflows ORDER BY updated_at DESC LIMIT 100`).all() as ToolWorkflowRow[];
    return rows.map(toStoredWorkflow);
  }

  recoverInterrupted(): number {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`SELECT id, status, events_json AS eventsJson
      FROM agent_tool_workflows
      WHERE status IN ('queued', 'planning', 'running', 'waiting_user', 'replanning', 'cancel_requested')`).all() as Array<{ id: string; status: ToolWorkflowSnapshot["status"]; eventsJson: string }>;
    const update = this.db.prepare(`UPDATE agent_tool_workflows
      SET status = 'interrupted', events_json = ?, updated_at = ? WHERE id = ?`);
    this.db.transaction(() => {
      for (const row of rows) {
        const previousStatus = row.status;
        const event: ToolWorkflowEvent = {
          id: randomUUID(),
          type: "workflow_interrupted",
          at: now,
          message: previousStatus === "cancel_requested"
            ? "应用重启时该工作流已有取消请求；结果不确定，已标记为中断，等待用户重新规划。"
            : "应用重启导致该工作流中断；之前未确认的工具调用不会自动重放。",
          data: { previousStatus }
        };
        const events = parseJson<ToolWorkflowEvent[]>(row.eventsJson, []);
        update.run(JSON.stringify([...events, event]), now, row.id);
      }
    })();
    return rows.length;
  }
}

interface ToolWorkflowRow {
  id: string;
  projectId: string | null;
  contextKey: string;
  inputJson: string;
  status: ToolWorkflowSnapshot["status"];
  round: number;
  userRequest: string;
  transcriptJson: string;
  eventsJson: string;
  toolResultsJson: string;
  pendingPermissionJson: string;
  finalText: string | null;
  warningCount: number;
  createdAt: string;
  updatedAt: string;
}

function toStoredWorkflow(row: ToolWorkflowRow): StoredToolWorkflow {
  return {
    snapshot: {
      workflowId: row.id,
      status: row.status,
      round: row.round,
      userRequest: row.userRequest,
      transcript: parseJson(row.transcriptJson, []),
      events: parseJson(row.eventsJson, []),
      toolResults: parseJson(row.toolResultsJson, []),
      pendingPermission: parseJson(row.pendingPermissionJson, null),
      finalText: row.finalText,
      warningCount: row.warningCount
    },
    ...(row.projectId ? { projectId: row.projectId } : {}),
    contextKey: row.contextKey,
    input: parseJson(row.inputJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

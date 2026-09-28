import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const ARTICLE_PRACTICE_LEGACY_EXECUTION_MIGRATION_VERSION = 3;

/** Links old manual execution records into article practice history without copying their output. */
export function migrateArticlePracticeLegacyExecutions(db: Database.Database): void {
  const version = ARTICLE_PRACTICE_LEGACY_EXECUTION_MIGRATION_VERSION;
  if (db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version)) return;

  db.transaction(() => {
    const columns = db.pragma("table_info(article_practice_tasks)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "source_type")) {
      db.exec("ALTER TABLE article_practice_tasks ADD COLUMN source_type TEXT NOT NULL DEFAULT 'awen' CHECK(source_type IN ('awen', 'legacy_manual'))");
    }
    if (!columns.some((column) => column.name === "legacy_execution_run_id")) {
      db.exec("ALTER TABLE article_practice_tasks ADD COLUMN legacy_execution_run_id TEXT REFERENCES execution_runs(id) ON DELETE CASCADE");
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_article_practice_legacy_execution
      ON article_practice_tasks(legacy_execution_run_id) WHERE legacy_execution_run_id IS NOT NULL`);

    const rows = db.prepare(`SELECT id, project_id AS projectId, request_json AS requestJson,
      created_at AS createdAt, finished_at AS finishedAt
      FROM execution_runs WHERE project_id IS NOT NULL ORDER BY created_at, id`).all() as LegacyExecutionRow[];
    const insertTask = db.prepare(`INSERT INTO article_practice_tasks
      (id, project_id, status, source_type, legacy_execution_run_id, latest_goal, event_seq, created_at, updated_at)
      VALUES (?, ?, 'completed_with_gaps', 'legacy_manual', ?, '旧版本机执行记录', 2, ?, ?)`);
    const insertEvent = db.prepare(`INSERT INTO article_practice_task_events
      (task_id, sequence, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`);
    for (const row of rows) {
      const request = parseRecord(row.requestJson);
      // Current Awen runs already have an article task. Older Awen tool sessions
      // remain in their workflow history; this import is for the retired manual panel.
      if (typeof request.practiceTaskId === "string" || typeof request.workflowId === "string") continue;
      const existing = db.prepare("SELECT id FROM article_practice_tasks WHERE legacy_execution_run_id = ?").get(row.id);
      if (existing) continue;
      const taskId = randomUUID();
      const createdAt = validTimestamp(row.createdAt) ? row.createdAt : new Date().toISOString();
      const updatedAt = validTimestamp(row.finishedAt) ? row.finishedAt : createdAt;
      insertTask.run(taskId, row.projectId, row.id, createdAt, updatedAt);
      insertEvent.run(taskId, 1, "created", JSON.stringify({ source: "legacy_manual" }), createdAt);
      insertEvent.run(taskId, 2, "legacy_execution_linked", JSON.stringify({ executionRunId: row.id }), updatedAt);
    }

    const foreignKeyProblems = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyProblems.length > 0) throw new Error("旧执行记录归并后的外键检查失败。");
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
  })();
}

interface LegacyExecutionRow { id: string; projectId: string; requestJson: string; createdAt: string; finishedAt: string | null }

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function validTimestamp(value: string | null): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

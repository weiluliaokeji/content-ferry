import type Database from "better-sqlite3";

export const ARTICLE_PRACTICE_TASK_MIGRATION_VERSION = 1;

/** The pre-2026 schema has an empty migration ledger. This is its first numbered addition. */
export function migrateArticlePracticeTasks(db: Database.Database): void {
  const applied = db.prepare("SELECT version FROM schema_migrations WHERE version = ?")
    .get(ARTICLE_PRACTICE_TASK_MIGRATION_VERSION);
  if (applied) return;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE article_practice_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN (
          'queued', 'assessing', 'practicing', 'waiting_permission',
          'waiting_feedback', 'waiting_stop_choice', 'drafting',
          'waiting_edit_confirmation', 'waiting_resume_choice',
          'completed', 'completed_with_gaps', 'stopped', 'failed'
        )),
        goal_revision INTEGER NOT NULL DEFAULT 1 CHECK(goal_revision >= 1),
        latest_goal TEXT NOT NULL,
        draft_baseline_hash TEXT,
        waiting_reason TEXT,
        feedback_deadline TEXT,
        resume_status TEXT,
        checkpoint_json TEXT NOT NULL DEFAULT '{}',
        has_gaps INTEGER NOT NULL DEFAULT 0 CHECK(has_gaps IN (0, 1)),
        event_seq INTEGER NOT NULL DEFAULT 0 CHECK(event_seq >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_article_practice_one_active
        ON article_practice_tasks(project_id)
        WHERE status NOT IN ('completed', 'completed_with_gaps', 'stopped', 'failed');
      CREATE INDEX idx_article_practice_project_updated
        ON article_practice_tasks(project_id, updated_at DESC);

      CREATE TABLE article_practice_task_events (
        task_id TEXT NOT NULL REFERENCES article_practice_tasks(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, sequence)
      );
    `);
    const foreignKeyProblems = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyProblems.length > 0) throw new Error("自主实践任务迁移后的外键检查失败。");
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(ARTICLE_PRACTICE_TASK_MIGRATION_VERSION, new Date().toISOString());
  })();
}

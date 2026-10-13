import type Database from "better-sqlite3";

export const ARTICLE_DRAFT_RUN_MIGRATION_VERSION = 10;

export function migrateArticleDraftRuns(db: Database.Database): void {
  const version = ARTICLE_DRAFT_RUN_MIGRATION_VERSION;
  if (db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version)) return;

  db.transaction(() => {
    const briefColumns = db.prepare("PRAGMA table_info(content_briefs)").all() as Array<{ name: string }>;
    if (!briefColumns.some((column) => column.name === "draft_depth_preference")) {
      db.exec("ALTER TABLE content_briefs ADD COLUMN draft_depth_preference TEXT CHECK(draft_depth_preference IS NULL OR draft_depth_preference IN ('concise', 'standard', 'detailed'))");
    }
    db.exec(`
      CREATE TABLE article_draft_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('running', 'waiting_author', 'passed', 'needs_author', 'failed', 'cancelled')),
        stage TEXT NOT NULL CHECK(stage IN ('planning_depth', 'assessing_practice', 'research_needed', 'awaiting_permission', 'practicing', 'drafting', 'curating_images', 'reviewing', 'revising', 'awaiting_scope_decision', 'passed', 'needs_author', 'failed', 'cancelled')),
        depth_preference TEXT CHECK(depth_preference IS NULL OR depth_preference IN ('concise', 'standard', 'detailed')),
        depth_plan_json TEXT NOT NULL DEFAULT '{}',
        scope_json TEXT NOT NULL DEFAULT '{}',
        outline_revision_sha256 TEXT,
        draft_revision_sha256 TEXT,
        checkpoint_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_article_draft_runs_project_updated ON article_draft_runs(project_id, updated_at DESC);
      CREATE UNIQUE INDEX idx_article_draft_runs_one_active ON article_draft_runs(project_id)
        WHERE status IN ('running', 'waiting_author');
      CREATE TABLE article_draft_run_events (
        run_id TEXT NOT NULL REFERENCES article_draft_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        kind TEXT NOT NULL CHECK(kind IN ('progress', 'stage_started', 'stage_completed', 'stage_skipped', 'finding_routed', 'authorization_waiting', 'evidence_attached', 'image_curation', 'review_completed', 'checkpoint_updated', 'scope_decision_required', 'completed', 'stopped', 'failed')),
        stage TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence)
      );
      CREATE INDEX idx_article_draft_run_events_cursor ON article_draft_run_events(run_id, sequence);
    `);
    const foreignKeyProblems = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyProblems.length > 0) throw new Error("正文起草运行迁移后的外键检查失败。");
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
  })();
}

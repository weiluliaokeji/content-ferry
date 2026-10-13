import type Database from "better-sqlite3";

export const CONTENT_GENERATION_REVIEW_MIGRATION_VERSION = 8;

export function migrateContentGenerationReviews(db: Database.Database): void {
  const version = CONTENT_GENERATION_REVIEW_MIGRATION_VERSION;
  if (db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version)) return;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS content_generation_reviews (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
        artifact_type TEXT NOT NULL CHECK(artifact_type IN ('outline', 'draft', 'channel_draft_csdn', 'channel_draft_cnblogs', 'channel_draft_juejin', 'channel_draft_51cto')),
        revision_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('passed', 'needs_author', 'review_failed')),
        repair_rounds INTEGER NOT NULL CHECK(repair_rounds BETWEEN 0 AND 3),
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_content_generation_reviews_project_created
        ON content_generation_reviews(project_id, artifact_type, created_at DESC);
    `);
    const foreignKeyProblems = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyProblems.length > 0) throw new Error("内容评审记录迁移后的外键检查失败。");
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
  })();
}

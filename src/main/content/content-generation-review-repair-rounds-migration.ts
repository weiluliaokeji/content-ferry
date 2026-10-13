import type Database from "better-sqlite3";

export const CONTENT_GENERATION_REVIEW_REPAIR_ROUNDS_MIGRATION_VERSION = 9;

export function migrateContentGenerationReviewRepairRounds(db: Database.Database): void {
  const version = CONTENT_GENERATION_REVIEW_REPAIR_ROUNDS_MIGRATION_VERSION;
  if (db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version)) return;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE content_generation_reviews_v9 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
        artifact_type TEXT NOT NULL CHECK(artifact_type IN ('outline', 'draft', 'channel_draft_csdn', 'channel_draft_cnblogs', 'channel_draft_juejin', 'channel_draft_51cto')),
        revision_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('passed', 'needs_author', 'review_failed')),
        repair_rounds INTEGER NOT NULL CHECK(repair_rounds BETWEEN 0 AND 5),
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO content_generation_reviews_v9
        (id, project_id, artifact_type, revision_sha256, status, repair_rounds, report_json, created_at)
        SELECT id, project_id, artifact_type, revision_sha256, status, repair_rounds, report_json, created_at
        FROM content_generation_reviews;
      DROP TABLE content_generation_reviews;
      ALTER TABLE content_generation_reviews_v9 RENAME TO content_generation_reviews;
      CREATE INDEX idx_content_generation_reviews_project_created
        ON content_generation_reviews(project_id, artifact_type, created_at DESC);
    `);

    const foreignKeyProblems = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyProblems.length > 0) throw new Error("内容评审修订次数迁移后的外键检查失败。");
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
  })();
}

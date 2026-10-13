import type Database from "better-sqlite3";

export const ARTICLE_DRAFT_CANDIDATE_MIGRATION_VERSION = 13;

/** A review candidate is recoverable work, never a saved article. */
export function migrateArticleDraftCandidates(db: Database.Database): void {
  if (db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(ARTICLE_DRAFT_CANDIDATE_MIGRATION_VERSION)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE article_draft_candidates (
        run_id TEXT PRIMARY KEY REFERENCES article_draft_runs(id) ON DELETE CASCADE,
        markdown TEXT NOT NULL,
        revision_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("正文候选恢复迁移后的外键检查失败。");
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(ARTICLE_DRAFT_CANDIDATE_MIGRATION_VERSION, new Date().toISOString());
  })();
}

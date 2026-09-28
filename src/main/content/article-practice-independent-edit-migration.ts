import type Database from "better-sqlite3";

export const ARTICLE_PRACTICE_INDEPENDENT_EDIT_MIGRATION_VERSION = 5;

/** Keeps editorial review open without reserving the article's execution slot. */
export function migrateArticlePracticeIndependentEdits(db: Database.Database): void {
  const version = ARTICLE_PRACTICE_INDEPENDENT_EDIT_MIGRATION_VERSION;
  if (db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version)) return;

  db.transaction(() => {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'article_practice_tasks'").get();
    if (!table) throw new Error("自主实践任务表缺失，无法解除正文审核对实践执行的占用。");
    db.exec(`
      DROP INDEX IF EXISTS idx_article_practice_one_active;
      CREATE UNIQUE INDEX idx_article_practice_one_active
        ON article_practice_tasks(project_id)
        WHERE status NOT IN ('completed', 'completed_with_gaps', 'stopped', 'failed', 'waiting_edit_confirmation');
    `);
    const foreignKeyProblems = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyProblems.length > 0) throw new Error("自主实践独立执行迁移后的外键检查失败。");
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
  })();
}

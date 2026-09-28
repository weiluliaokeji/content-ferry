import type Database from "better-sqlite3";

export const ARTICLE_PRACTICE_GAP_FLAG_MIGRATION_VERSION = 4;

/** Adds the persistent gap flag to databases created by an earlier practice-task schema. */
export function migrateArticlePracticeGapFlag(db: Database.Database): void {
  const version = ARTICLE_PRACTICE_GAP_FLAG_MIGRATION_VERSION;
  if (db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version)) return;

  db.transaction(() => {
    const columns = db.pragma("table_info(article_practice_tasks)") as Array<{ name: string }>;
    if (columns.length === 0) throw new Error("自主实践任务表缺失，无法执行 has_gaps 兼容迁移。");
    if (!columns.some((column) => column.name === "has_gaps")) {
      db.exec("ALTER TABLE article_practice_tasks ADD COLUMN has_gaps INTEGER NOT NULL DEFAULT 0 CHECK(has_gaps IN (0, 1))");
    }
    // Earlier builds encoded gaps only in the status. Preserve that meaning when
    // upgrading rather than silently presenting those tasks as fully verified.
    db.exec("UPDATE article_practice_tasks SET has_gaps = 1 WHERE status = 'completed_with_gaps'");
    const foreignKeyProblems = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyProblems.length > 0) throw new Error("自主实践缺口标记迁移后的外键检查失败。");
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
  })();
}

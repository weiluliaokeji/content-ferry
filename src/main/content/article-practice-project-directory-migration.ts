import type Database from "better-sqlite3";

export const ARTICLE_PRACTICE_PROJECT_DIRECTORY_MIGRATION_VERSION = 2;

/** Adds the optional per-article code workspace without changing existing project records. */
export function migrateArticlePracticeProjectDirectory(db: Database.Database): void {
  const version = ARTICLE_PRACTICE_PROJECT_DIRECTORY_MIGRATION_VERSION;
  if (db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version)) return;

  db.transaction(() => {
    const columns = db.pragma("table_info(content_projects)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "practice_project_directory")) {
      db.exec("ALTER TABLE content_projects ADD COLUMN practice_project_directory TEXT");
    }
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
    const foreignKeyProblems = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyProblems.length > 0) throw new Error("文章实践目录迁移后的外键检查失败。");
  })();
}

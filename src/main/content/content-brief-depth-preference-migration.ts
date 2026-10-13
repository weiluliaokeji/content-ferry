import type Database from "better-sqlite3";

/** Repairs databases where v10 was recorded before its brief column was present. */
export const CONTENT_BRIEF_DEPTH_PREFERENCE_MIGRATION_VERSION = 11;

export function migrateContentBriefDepthPreference(db: Database.Database): void {
  const version = CONTENT_BRIEF_DEPTH_PREFERENCE_MIGRATION_VERSION;
  const applied = Boolean(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version));
  const columns = db.prepare("PRAGMA table_info(content_briefs)").all() as Array<{ name: string }>;
  const hasColumn = columns.some((column) => column.name === "draft_depth_preference");
  if (applied && hasColumn) return;

  db.transaction(() => {
    if (!hasColumn) {
      db.exec("ALTER TABLE content_briefs ADD COLUMN draft_depth_preference TEXT CHECK(draft_depth_preference IS NULL OR draft_depth_preference IN ('concise', 'standard', 'detailed'))");
    }
    if (!applied) {
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(version, new Date().toISOString());
    }
  })();
}

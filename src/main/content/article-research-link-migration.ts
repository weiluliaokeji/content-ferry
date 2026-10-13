import type Database from "better-sqlite3";

export const ARTICLE_RESEARCH_LINK_MIGRATION_VERSION = 12;

/** Keeps candidate source use separate from author adoption of research cards. */
export function migrateArticleResearchLinks(db: Database.Database): void {
  if (db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(ARTICLE_RESEARCH_LINK_MIGRATION_VERSION)) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE article_research_links (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES content_research_sources(id) ON DELETE CASCADE,
        claim_text TEXT NOT NULL,
        paragraph_sha256 TEXT NOT NULL,
        supporting_excerpt TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending_author', 'confirmed', 'rejected', 'needs_recheck')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_article_research_links_project ON article_research_links(project_id, created_at DESC);
    `);
    if ((db.pragma("foreign_key_check") as unknown[]).length) throw new Error("文章来源关联迁移后的外键检查失败。");
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(ARTICLE_RESEARCH_LINK_MIGRATION_VERSION, new Date().toISOString());
  })();
}

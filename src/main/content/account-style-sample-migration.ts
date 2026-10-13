import type Database from "better-sqlite3";

export const ACCOUNT_STYLE_SAMPLE_MIGRATION_VERSION = 6;
export const ACCOUNT_STYLE_PROFILE_MIGRATION_VERSION = 7;

/** Stores author-selected account style samples without changing manual account profile fields. */
export function migrateAccountStyleSamples(db: Database.Database): void {
  const version = ACCOUNT_STYLE_SAMPLE_MIGRATION_VERSION;
  if (db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version)) return;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS account_style_samples (
        account_id TEXT NOT NULL REFERENCES media_accounts(id) ON DELETE CASCADE,
        source_relative_path TEXT NOT NULL,
        attribution_basis TEXT NOT NULL CHECK(attribution_basis IN ('published_record', 'author_confirmed')),
        selected_at TEXT NOT NULL,
        PRIMARY KEY (account_id, source_relative_path)
      );
      CREATE INDEX IF NOT EXISTS idx_account_style_samples_account_selected
        ON account_style_samples(account_id, selected_at DESC);
    `);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
    const foreignKeyProblems = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyProblems.length > 0) throw new Error("账号代表样本迁移后的外键检查失败。");
  })();
}

/** Stores reviewable extraction proposals and immutable, versioned confirmed profiles. */
export function migrateAccountStyleProfiles(db: Database.Database): void {
  const version = ACCOUNT_STYLE_PROFILE_MIGRATION_VERSION;
  if (db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version)) return;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS account_style_profile_proposals (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES media_accounts(id) ON DELETE CASCADE,
        profile_json TEXT NOT NULL,
        sample_sources_json TEXT NOT NULL,
        based_on_version_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'rejected')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_account_style_profile_proposals_pending
        ON account_style_profile_proposals(account_id, status, created_at DESC);
      CREATE TABLE IF NOT EXISTS account_style_profile_versions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES media_accounts(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL CHECK(version_number > 0),
        profile_json TEXT NOT NULL,
        sample_sources_json TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        UNIQUE(account_id, version_number),
        UNIQUE(account_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_account_style_profile_versions_history
        ON account_style_profile_versions(account_id, version_number DESC);
      CREATE TABLE IF NOT EXISTS account_style_profile_active (
        account_id TEXT PRIMARY KEY REFERENCES media_accounts(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL,
        FOREIGN KEY(account_id, version_id) REFERENCES account_style_profile_versions(account_id, id)
      );
    `);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(version, new Date().toISOString());
    const foreignKeyProblems = db.pragma("foreign_key_check") as unknown[];
    if (foreignKeyProblems.length > 0) throw new Error("账号风格档案迁移后的外键检查失败。");
  })();
}

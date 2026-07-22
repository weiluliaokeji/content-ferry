import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface AppDatabase {
  connection: Database.Database;
  close(): void;
}

export function openDatabase(dataDirectory: string): AppDatabase {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const db = new Database(path.join(dataDirectory, "contentferry.db"));

  initialiseDatabase(db);

  return {
    connection: db,
    close: () => db.close()
  };
}

export function openInMemoryDatabase(): AppDatabase {
  const db = new Database(":memory:");
  initialiseDatabase(db);

  return {
    connection: db,
    close: () => db.close()
  };
}

function initialiseDatabase(db: Database.Database): void {

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_accounts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      platform TEXT NOT NULL,
      display_name TEXT NOT NULL,
      external_account_id TEXT,
      capability_level TEXT NOT NULL DEFAULT 'unverified',
      credential_ref TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_id, platform, external_account_id)
    );

    CREATE TABLE IF NOT EXISTS account_profiles (
      account_id TEXT PRIMARY KEY REFERENCES media_accounts(id) ON DELETE CASCADE,
      positioning TEXT NOT NULL DEFAULT '',
      target_audience TEXT NOT NULL DEFAULT '',
      prohibited_topics TEXT NOT NULL DEFAULT '',
      writing_style TEXT NOT NULL DEFAULT '',
      regular_columns TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credential_secrets (
      id TEXT PRIMARY KEY,
      encrypted_value BLOB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_credentials (
      account_id TEXT NOT NULL REFERENCES media_accounts(id) ON DELETE CASCADE,
      credential_kind TEXT NOT NULL,
      secret_id TEXT NOT NULL REFERENCES credential_secrets(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, credential_kind)
    );

    CREATE TABLE IF NOT EXISTS app_credentials (
      credential_kind TEXT PRIMARY KEY,
      secret_id TEXT NOT NULL REFERENCES credential_secrets(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_connections (
      provider TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      model_id TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      proxy_url TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_settings (
      skill_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      provider TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_sources (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      root_path TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_projects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      target_account_id TEXT REFERENCES media_accounts(id),
      topic TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idea',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_briefs (
      project_id TEXT PRIMARY KEY REFERENCES content_projects(id) ON DELETE CASCADE,
      objective TEXT NOT NULL DEFAULT '',
      audience TEXT NOT NULL DEFAULT '',
      angle TEXT NOT NULL DEFAULT '',
      source_notes TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_outlines (
      project_id TEXT PRIMARY KEY REFERENCES content_projects(id) ON DELETE CASCADE,
      markdown TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_drafts (
      project_id TEXT PRIMARY KEY REFERENCES content_projects(id) ON DELETE CASCADE,
      markdown TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS article_settings (
      context_key TEXT PRIMARY KEY,
      author TEXT NOT NULL DEFAULT '',
      digest TEXT NOT NULL DEFAULT '',
      cover_source TEXT NOT NULL DEFAULT '',
      account_id TEXT,
      need_open_comment INTEGER NOT NULL DEFAULT 1,
      only_fans_can_comment INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS article_quality_checks (
      context_key TEXT PRIMARY KEY,
      ai_check_result TEXT NOT NULL DEFAULT '',
      ai_check_report TEXT NOT NULL DEFAULT '',
      override_reason TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_reviews (
      project_id TEXT PRIMARY KEY REFERENCES content_projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      fact_checked INTEGER NOT NULL DEFAULT 0,
      account_fit_checked INTEGER NOT NULL DEFAULT 0,
      ai_check_result TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      job_type TEXT NOT NULL,
      business_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      available_at TEXT NOT NULL,
      lease_until TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_id, job_type, business_key)
    );

    CREATE TABLE IF NOT EXISTS callback_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      account_id TEXT REFERENCES media_accounts(id),
      event_fingerprint TEXT NOT NULL,
      signature_status TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      UNIQUE(workspace_id, event_fingerprint)
    );

    CREATE TABLE IF NOT EXISTS wechat_publish_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      account_id TEXT NOT NULL REFERENCES media_accounts(id),
      project_id TEXT REFERENCES content_projects(id),
      source_relative_path TEXT,
      mode TEXT NOT NULL,
      title TEXT NOT NULL,
      draft_media_id TEXT,
      publish_id TEXT,
      message_id TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      status_source TEXT NOT NULL DEFAULT 'system',
      status_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wechat_publish_jobs_account_updated
      ON wechat_publish_jobs(account_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS wechat_publish_job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES wechat_publish_jobs(id),
      previous_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wechat_publish_job_events_job_created
      ON wechat_publish_job_events(job_id, created_at DESC);
  `);

  const accountColumns = db.prepare("PRAGMA table_info(media_accounts)").all() as Array<{ name: string }>;
  if (!accountColumns.some((column) => column.name === "deleted_at")) {
    db.exec("ALTER TABLE media_accounts ADD COLUMN deleted_at TEXT");
  }

  const projectColumns = db.prepare("PRAGMA table_info(content_projects)").all() as Array<{ name: string }>;
  if (!projectColumns.some((column) => column.name === "source_relative_path")) {
    db.exec("ALTER TABLE content_projects ADD COLUMN source_relative_path TEXT");
  }

  const articleSettingColumns = db.prepare("PRAGMA table_info(article_settings)").all() as Array<{ name: string }>;
  if (!articleSettingColumns.some((column) => column.name === "account_id")) {
    db.exec("ALTER TABLE article_settings ADD COLUMN account_id TEXT");
  }
  if (!articleSettingColumns.some((column) => column.name === "need_open_comment")) {
    db.exec("ALTER TABLE article_settings ADD COLUMN need_open_comment INTEGER NOT NULL DEFAULT 1");
  }
  if (!articleSettingColumns.some((column) => column.name === "only_fans_can_comment")) {
    db.exec("ALTER TABLE article_settings ADD COLUMN only_fans_can_comment INTEGER NOT NULL DEFAULT 0");
  }

  const articleQualityColumns = db.prepare("PRAGMA table_info(article_quality_checks)").all() as Array<{ name: string }>;
  if (!articleQualityColumns.some((column) => column.name === "ai_check_report")) {
    db.exec("ALTER TABLE article_quality_checks ADD COLUMN ai_check_report TEXT NOT NULL DEFAULT ''");
  }

  const publishJobColumns = db.prepare("PRAGMA table_info(wechat_publish_jobs)").all() as Array<{ name: string }>;
  if (!publishJobColumns.some((column) => column.name === "source_relative_path")) {
    db.exec("ALTER TABLE wechat_publish_jobs ADD COLUMN source_relative_path TEXT");
  }
  if (!publishJobColumns.some((column) => column.name === "status_source")) {
    db.exec("ALTER TABLE wechat_publish_jobs ADD COLUMN status_source TEXT NOT NULL DEFAULT 'system'");
  }
  if (!publishJobColumns.some((column) => column.name === "status_note")) {
    db.exec("ALTER TABLE wechat_publish_jobs ADD COLUMN status_note TEXT");
  }

}

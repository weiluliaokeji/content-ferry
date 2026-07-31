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
      built_in_search INTEGER NOT NULL DEFAULT 1,
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
      topic TEXT NOT NULL DEFAULT '',
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

    CREATE TABLE IF NOT EXISTS content_research_plans (
      project_id TEXT PRIMARY KEY REFERENCES content_projects(id) ON DELETE CASCADE,
      plan_markdown TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_research_sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      excerpt TEXT NOT NULL DEFAULT '',
      claims_json TEXT NOT NULL DEFAULT '[]',
      source_type TEXT NOT NULL CHECK(source_type IN ('official', 'public')),
      retrieved_at TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_content_research_sources_project
      ON content_research_sources(project_id, retrieved_at DESC);

    CREATE TABLE IF NOT EXISTS article_settings (
      context_key TEXT PRIMARY KEY,
      author TEXT NOT NULL DEFAULT '',
      digest TEXT NOT NULL DEFAULT '',
      cover_source TEXT NOT NULL DEFAULT '',
      cover_prompt TEXT NOT NULL DEFAULT '',
      account_id TEXT,
      need_open_comment INTEGER NOT NULL DEFAULT 1,
      only_fans_can_comment INTEGER NOT NULL DEFAULT 0,
      declare_original INTEGER NOT NULL DEFAULT 0,
      enable_reward INTEGER NOT NULL DEFAULT 0,
      collection_name TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS article_quality_checks (
      context_key TEXT PRIMARY KEY,
      ai_check_result TEXT NOT NULL DEFAULT '',
      ai_check_report TEXT NOT NULL DEFAULT '',
      override_reason TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS article_chat_threads (
      context_key TEXT PRIMARY KEY,
      memory TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS article_chat_messages (
      id TEXT PRIMARY KEY,
      context_key TEXT NOT NULL REFERENCES article_chat_threads(context_key) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      memory_suggestion TEXT NOT NULL DEFAULT '',
      suggestions_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS writing_memories (
      scope_key TEXT PRIMARY KEY,
      memory TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_article_chat_messages_context_created
      ON article_chat_messages(context_key, created_at ASC);

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
      declare_original INTEGER NOT NULL DEFAULT 0,
      enable_reward INTEGER NOT NULL DEFAULT 0,
      collection_name TEXT NOT NULL DEFAULT '',
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

    CREATE TABLE IF NOT EXISTS channel_drafts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      account_id TEXT NOT NULL REFERENCES media_accounts(id),
      project_id TEXT REFERENCES content_projects(id),
      source_relative_path TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      generation_mode TEXT NOT NULL DEFAULT 'rewrite' CHECK(generation_mode IN ('rewrite', 'source')),
      title TEXT NOT NULL,
      markdown TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      digest TEXT NOT NULL DEFAULT '',
      cover_source TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('draft', 'approved', 'superseded')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_channel_drafts_account_updated
      ON channel_drafts(account_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS csdn_publish_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      account_id TEXT NOT NULL REFERENCES media_accounts(id),
      channel_draft_id TEXT NOT NULL REFERENCES channel_drafts(id),
      rendered_package_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'needs_login', 'filling', 'ready_for_final_confirmation',
        'submitting', 'published', 'needs_manual_reconciliation',
        'needs_user', 'failed_before_submit', 'failed', 'cancelled'
      )),
      remote_url TEXT,
      remote_content_id TEXT,
      status_note TEXT,
      error_message TEXT,
      status_source TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_csdn_publish_jobs_account_updated
      ON csdn_publish_jobs(account_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS csdn_publish_job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES csdn_publish_jobs(id) ON DELETE CASCADE,
      previous_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_csdn_publish_job_events_job_created
      ON csdn_publish_job_events(job_id, created_at DESC);

    -- The public-account web UI is the source of truth. This table is only a
    -- per-account cache of collection names observed by the visible browser,
    -- so the editor can offer real previously-synchronised choices offline.
    CREATE TABLE IF NOT EXISTS wechat_collections (
      account_id TEXT NOT NULL REFERENCES media_accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      wechat_collection_id TEXT,
      observed_at TEXT NOT NULL,
      PRIMARY KEY (account_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_wechat_collections_account_observed
      ON wechat_collections(account_id, observed_at DESC);
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
  if (!articleSettingColumns.some((column) => column.name === "declare_original")) {
    db.exec("ALTER TABLE article_settings ADD COLUMN declare_original INTEGER NOT NULL DEFAULT 0");
  }
  if (!articleSettingColumns.some((column) => column.name === "enable_reward")) {
    db.exec("ALTER TABLE article_settings ADD COLUMN enable_reward INTEGER NOT NULL DEFAULT 0");
  }
  if (!articleSettingColumns.some((column) => column.name === "collection_name")) {
    db.exec("ALTER TABLE article_settings ADD COLUMN collection_name TEXT NOT NULL DEFAULT ''");
  }
  if (!articleSettingColumns.some((column) => column.name === "cover_prompt")) {
    db.exec("ALTER TABLE article_settings ADD COLUMN cover_prompt TEXT NOT NULL DEFAULT ''");
  }

  const articleQualityColumns = db.prepare("PRAGMA table_info(article_quality_checks)").all() as Array<{ name: string }>;
  if (!articleQualityColumns.some((column) => column.name === "ai_check_report")) {
    db.exec("ALTER TABLE article_quality_checks ADD COLUMN ai_check_report TEXT NOT NULL DEFAULT ''");
  }

  const contentBriefColumns = db.prepare("PRAGMA table_info(content_briefs)").all() as Array<{ name: string }>;
  if (!contentBriefColumns.some((column) => column.name === "topic")) {
    db.exec("ALTER TABLE content_briefs ADD COLUMN topic TEXT NOT NULL DEFAULT ''");
  }

  const articleChatColumns = db.prepare("PRAGMA table_info(article_chat_messages)").all() as Array<{ name: string }>;
  if (!articleChatColumns.some((column) => column.name === "suggestions_json")) {
    db.exec("ALTER TABLE article_chat_messages ADD COLUMN suggestions_json TEXT NOT NULL DEFAULT '[]'");
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
  if (!publishJobColumns.some((column) => column.name === "declare_original")) {
    db.exec("ALTER TABLE wechat_publish_jobs ADD COLUMN declare_original INTEGER NOT NULL DEFAULT 0");
  }
  if (!publishJobColumns.some((column) => column.name === "enable_reward")) {
    db.exec("ALTER TABLE wechat_publish_jobs ADD COLUMN enable_reward INTEGER NOT NULL DEFAULT 0");
  }
  if (!publishJobColumns.some((column) => column.name === "collection_name")) {
    db.exec("ALTER TABLE wechat_publish_jobs ADD COLUMN collection_name TEXT NOT NULL DEFAULT ''");
  }

  const channelDraftColumns = db.prepare("PRAGMA table_info(channel_drafts)").all() as Array<{ name: string }>;
  if (!channelDraftColumns.some((column) => column.name === "generation_mode")) {
    db.exec("ALTER TABLE channel_drafts ADD COLUMN generation_mode TEXT NOT NULL DEFAULT 'rewrite'");
  }
  if (!channelDraftColumns.some((column) => column.name === "author")) {
    db.exec("ALTER TABLE channel_drafts ADD COLUMN author TEXT NOT NULL DEFAULT ''");
  }
  if (!channelDraftColumns.some((column) => column.name === "digest")) {
    db.exec("ALTER TABLE channel_drafts ADD COLUMN digest TEXT NOT NULL DEFAULT ''");
  }
  if (!channelDraftColumns.some((column) => column.name === "cover_source")) {
    db.exec("ALTER TABLE channel_drafts ADD COLUMN cover_source TEXT NOT NULL DEFAULT ''");
  }

  // 迁移：放宽 csdn_publish_jobs.status 的 CHECK 约束，容纳 needs_user / failed。
  // 早期版本的约束缺少这两个状态，会导致填充失败回写与人工校正失败。幂等：仅在
  // 现有表的 CHECK 尚未包含 needs_user 时重建，保留任务与事件数据。
  const jobTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='csdn_publish_jobs'").get() as { sql: string } | undefined;
  if (jobTableSql && !/needs_user/.test(jobTableSql.sql)) {
    db.transaction(() => {
      db.exec(`CREATE TABLE csdn_publish_jobs_new (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        account_id TEXT NOT NULL REFERENCES media_accounts(id),
        channel_draft_id TEXT NOT NULL REFERENCES channel_drafts(id),
        rendered_package_hash TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN (
          'queued', 'needs_login', 'filling', 'ready_for_final_confirmation',
          'submitting', 'published', 'needs_manual_reconciliation',
          'needs_user', 'failed_before_submit', 'failed', 'cancelled'
        )),
        remote_url TEXT,
        remote_content_id TEXT,
        status_note TEXT,
        error_message TEXT,
        status_source TEXT NOT NULL DEFAULT 'system',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      db.exec(`INSERT INTO csdn_publish_jobs_new (id, workspace_id, account_id, channel_draft_id, rendered_package_hash, idempotency_key, status, remote_url, remote_content_id, status_note, error_message, status_source, created_at, updated_at)
        SELECT id, workspace_id, account_id, channel_draft_id, rendered_package_hash, idempotency_key, status, remote_url, remote_content_id, status_note, error_message, COALESCE(status_source, 'system'), created_at, updated_at FROM csdn_publish_jobs`);
      db.exec(`CREATE TABLE csdn_publish_job_events_backup AS SELECT * FROM csdn_publish_job_events`);
      db.exec(`DROP TABLE csdn_publish_job_events`);
      db.exec(`DROP TABLE csdn_publish_jobs`);
      db.exec(`ALTER TABLE csdn_publish_jobs_new RENAME TO csdn_publish_jobs`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_csdn_publish_jobs_account_updated ON csdn_publish_jobs(account_id, updated_at DESC)`);
      db.exec(`CREATE TABLE csdn_publish_job_events (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES csdn_publish_jobs(id) ON DELETE CASCADE,
        previous_status TEXT NOT NULL,
        new_status TEXT NOT NULL,
        source TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      db.exec(`INSERT INTO csdn_publish_job_events SELECT * FROM csdn_publish_job_events_backup`);
      db.exec(`DROP TABLE csdn_publish_job_events_backup`);
    })();
  }

}

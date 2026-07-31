import { afterEach, describe, expect, it } from "vitest";
import { openInMemoryDatabase, initialiseDatabase, type AppDatabase } from "./database";

describe("article settings schema", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("stores the confirmed cover prompt with article settings", () => {
    database = openInMemoryDatabase();
    const columns = database.connection.prepare("PRAGMA table_info(article_settings)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("cover_prompt");
  });
});

describe("csdn_publish_jobs migration (old schema without status_source)", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("migrates an old-schema table (strict CHECK, no status_source) without crashing", () => {
    // 先用完整当前 schema 建库，父表都是真实结构，避免 FK 约束问题。
    database = openInMemoryDatabase();
    const conn = database.connection;

    // 卸下当前的 csdn 相关表，替换为“旧 schema”形态：
    // status 的 CHECK 不含 needs_user / failed，且没有 status_source 列。
    // 这正是 0291d00 之前的线上数据库形态，会触发放宽 CHECK 的重建迁移。
    conn.exec("DROP TABLE IF EXISTS csdn_publish_job_events");
    conn.exec("DROP TABLE IF EXISTS csdn_publish_jobs");
    conn.exec(`CREATE TABLE csdn_publish_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      account_id TEXT NOT NULL REFERENCES media_accounts(id),
      channel_draft_id TEXT NOT NULL REFERENCES channel_drafts(id),
      rendered_package_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN (
        'queued', 'needs_login', 'filling', 'ready_for_final_confirmation',
        'submitting', 'published', 'needs_manual_reconciliation',
        'failed_before_submit', 'cancelled'
      )),
      remote_url TEXT,
      remote_content_id TEXT,
      status_note TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    conn.exec(`CREATE TABLE csdn_publish_job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES csdn_publish_jobs(id) ON DELETE CASCADE,
      previous_status TEXT NOT NULL,
      new_status TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);

    // 合法父行，确保 FK 通过（current schema 下 foreign_keys 开启）
    conn.exec("INSERT INTO workspaces (id, display_name, timezone, created_at) VALUES ('w1', 'w', 'Asia/Shanghai', '2026-01-01T00:00:00Z')");
    conn.exec("INSERT INTO media_accounts (id, workspace_id, platform, display_name, created_at) VALUES ('a1', 'w1', 'csdn', 'a', '2026-01-01T00:00:00Z')");
    conn.exec("INSERT INTO channel_drafts (id, workspace_id, account_id, source_relative_path, source_hash, title, markdown, status, created_at, updated_at) VALUES ('d1', 'w1', 'a1', 'p', 'h', 't', 'm', 'draft', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
    conn.exec(`INSERT INTO csdn_publish_jobs
      (id, workspace_id, account_id, channel_draft_id, rendered_package_hash, idempotency_key, status, remote_url, remote_content_id, status_note, error_message, created_at, updated_at)
      VALUES ('j1', 'w1', 'a1', 'd1', 'h1', 'k1', 'filling', NULL, NULL, 'note', 'err', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);

    // 重新触发迁移（createInitialTables 对 csdn 表走 IF NOT EXISTS 跳过，
    // 但会检测到旧 CHECK 并执行重建迁移）
    initialiseDatabase(conn);

    const row = conn.prepare(
      "SELECT id, status, status_source FROM csdn_publish_jobs WHERE id = ?"
    ).get("j1") as { id: string; status: string; status_source: string };
    expect(row.id).toBe("j1");
    expect(row.status).toBe("filling");
    // 旧表没有 status_source，迁移必须以字面量 'system' 填充，不能从旧表 SELECT
    expect(row.status_source).toBe("system");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, openInMemoryDatabase, initialiseDatabase, type AppDatabase } from "./database";
import { AccountRepository } from "../accounts/account-repository";
import { CONTENT_GENERATION_REVIEW_MIGRATION_VERSION } from "../content/content-generation-review-migration";
import { CONTENT_GENERATION_REVIEW_REPAIR_ROUNDS_MIGRATION_VERSION } from "../content/content-generation-review-repair-rounds-migration";
import { ARTICLE_DRAFT_RUN_MIGRATION_VERSION } from "../content/article-draft-run-migration";
import { CONTENT_BRIEF_DEPTH_PREFERENCE_MIGRATION_VERSION } from "../content/content-brief-depth-preference-migration";
import { ContentGenerationReviewRepository } from "../content/content-generation-review-repository";
import { ContentBriefRepository } from "../content/content-brief-repository";
import { ContentProjectRepository } from "../content/content-project-repository";

describe("article settings schema", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("stores the confirmed cover prompt with article settings", () => {
    database = openInMemoryDatabase();
    const columns = database.connection.prepare("PRAGMA table_info(article_settings)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("cover_prompt");
    expect(columns.map((column) => column.name)).toContain("is_ai_generated");
  });
});

describe("independent practice while article suggestions await saving", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("upgrades the v4 active-task index without changing an existing pending edit", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;
    conn.exec("INSERT INTO workspaces (id, display_name, created_at) VALUES ('w1', 'w', '2026-01-01T00:00:00Z')");
    conn.exec("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES ('p1', 'w1', 'article', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
    conn.exec(`INSERT INTO article_practice_tasks (id, project_id, status, latest_goal, created_at, updated_at)
      VALUES ('review-task', 'p1', 'waiting_edit_confirmation', 'Scoop suggestion', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    conn.exec("DROP INDEX idx_article_practice_one_active");
    conn.exec(`CREATE UNIQUE INDEX idx_article_practice_one_active ON article_practice_tasks(project_id)
      WHERE status NOT IN ('completed', 'completed_with_gaps', 'stopped', 'failed')`);
    conn.exec("DELETE FROM schema_migrations WHERE version = 5");

    initialiseDatabase(conn);

    conn.exec(`INSERT INTO article_practice_tasks (id, project_id, status, latest_goal, created_at, updated_at)
      VALUES ('nvm-task', 'p1', 'queued', 'Node.js versions', '2026-01-01T00:01:00Z', '2026-01-01T00:01:00Z')`);
    expect((conn.prepare("SELECT status FROM article_practice_tasks WHERE id = 'review-task'").get() as { status: string }).status)
      .toBe("waiting_edit_confirmation");
    expect(conn.pragma("foreign_key_check")).toEqual([]);
    expect(conn.prepare("SELECT version FROM schema_migrations WHERE version = 5").get()).toBeTruthy();
  });
});

describe("account style sample migration", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("upgrades a v5 database without changing account writing style or existing account data", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;
    const accounts = new AccountRepository(conn);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const account = accounts.createAccount({ workspaceId: workspace.id, platform: "wechat_official", displayName: "迁移测试账号" });
    accounts.updateProfile(account.id, { ...account.profile, writingStyle: "作者手动风格" });
    conn.exec("DROP TABLE account_style_samples; DELETE FROM schema_migrations WHERE version = 6;");

    initialiseDatabase(conn);

    expect(conn.prepare("SELECT version FROM schema_migrations WHERE version = 6").get()).toBeTruthy();
    expect(accounts.requireAccount(account.id).profile.writingStyle).toBe("作者手动风格");
    expect(conn.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("account style profile migration", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("adds proposal and version storage without changing selected samples or manual writing style", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;
    const accounts = new AccountRepository(conn);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const account = accounts.createAccount({ workspaceId: workspace.id, platform: "wechat_official", displayName: "风格迁移账号" });
    accounts.updateProfile(account.id, { ...account.profile, writingStyle: "保持我的手动风格" });
    conn.prepare(`INSERT INTO account_style_samples (account_id, source_relative_path, attribution_basis, selected_at)
      VALUES (?, ?, 'author_confirmed', ?)`).run(account.id, "posts/old/index.md", "2026-01-01T00:00:00Z");
    conn.exec("DROP TABLE account_style_profile_active; DROP TABLE account_style_profile_versions; DROP TABLE account_style_profile_proposals; DELETE FROM schema_migrations WHERE version = 7;");

    initialiseDatabase(conn);

    expect(conn.prepare("SELECT version FROM schema_migrations WHERE version = 7").get()).toBeTruthy();
    expect(conn.prepare("SELECT source_relative_path FROM account_style_samples WHERE account_id = ?").get(account.id))
      .toEqual({ source_relative_path: "posts/old/index.md" });
    expect(accounts.requireAccount(account.id).profile.writingStyle).toBe("保持我的手动风格");
    expect(conn.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("content generation review migration", () => {
  let database: AppDatabase | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(() => {
    database?.close();
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("adds append-only review records to a v7 database and can reopen it", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;
    const accounts = new AccountRepository(conn);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    conn.prepare("DELETE FROM schema_migrations WHERE version = ?").run(CONTENT_GENERATION_REVIEW_MIGRATION_VERSION);
    conn.prepare("DELETE FROM schema_migrations WHERE version = ?").run(CONTENT_GENERATION_REVIEW_REPAIR_ROUNDS_MIGRATION_VERSION);
    conn.exec("DROP TABLE content_generation_reviews");
    conn.prepare("DELETE FROM schema_migrations WHERE version = ?").run(ARTICLE_DRAFT_RUN_MIGRATION_VERSION);
    conn.prepare("DELETE FROM schema_migrations WHERE version = ?").run(CONTENT_BRIEF_DEPTH_PREFERENCE_MIGRATION_VERSION);
    conn.exec("DROP TABLE article_draft_run_events; DROP TABLE article_draft_runs; ALTER TABLE content_briefs DROP COLUMN draft_depth_preference");

    initialiseDatabase(conn);

    expect(conn.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(CONTENT_GENERATION_REVIEW_MIGRATION_VERSION)).toBeTruthy();
    expect(conn.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(CONTENT_GENERATION_REVIEW_REPAIR_ROUNDS_MIGRATION_VERSION)).toBeTruthy();
    const table = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'content_generation_reviews'").get();
    expect(table).toBeTruthy();
    expect(conn.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspace.id)).toBeTruthy();
    expect(conn.pragma("foreign_key_check")).toEqual([]);
  });

  it("backs up and upgrades an on-disk v7 database while preserving existing article data", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;
    const accounts = new AccountRepository(conn);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const account = accounts.createAccount({ workspaceId: workspace.id, platform: "wechat_official", displayName: "评审迁移账号" });
    accounts.updateProfile(account.id, { ...account.profile, writingStyle: "保留手动风格" });
    conn.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("review-project", workspace.id, "保留的文章项目", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    conn.exec("DROP TABLE content_generation_reviews; DROP TABLE article_draft_run_events; DROP TABLE article_draft_runs; ALTER TABLE content_briefs DROP COLUMN draft_depth_preference; DELETE FROM schema_migrations WHERE version IN (8, 9, 10, 11);");
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-review-migration-"));
    const databasePath = path.join(temporaryDirectory, "contentferry.db");
    conn.prepare("VACUUM INTO ?").run(databasePath);
    database.close();
    database = openDatabase(temporaryDirectory);

    const upgraded = database.connection;
    expect(upgraded.prepare("SELECT version FROM schema_migrations WHERE version = 8").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT version FROM schema_migrations WHERE version = 9").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT version FROM schema_migrations WHERE version = 10").get()).toBeTruthy();
    expect(upgraded.prepare("SELECT topic FROM content_projects WHERE id = 'review-project'").get()).toEqual({ topic: "保留的文章项目" });
    expect(new AccountRepository(upgraded).requireAccount(account.id).profile.writingStyle).toBe("保留手动风格");
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    expect(fs.readdirSync(path.join(temporaryDirectory, "backups")).some((name) => name.endsWith(".db"))).toBe(true);
  });

  it("upgrades a v8 review table to accept five repair rounds and preserves prior reports", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;
    const workspace = new AccountRepository(conn).getOrCreateDefaultWorkspace();
    const project = new ContentProjectRepository(conn).create({ workspaceId: workspace.id, topic: "提纲迁移" });
    const reviews = new ContentGenerationReviewRepository(conn);
    reviews.save(project.id, "outline", {
      status: "needs_author", markdown: "# 原提纲", findings: [], evidenceUsed: [], summary: "旧评审记录", repairRounds: 3
    });

    conn.exec(`
      DROP INDEX idx_content_generation_reviews_project_created;
      CREATE TABLE content_generation_reviews_v8 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES content_projects(id) ON DELETE CASCADE,
        artifact_type TEXT NOT NULL CHECK(artifact_type IN ('outline', 'draft', 'channel_draft_csdn', 'channel_draft_cnblogs', 'channel_draft_juejin', 'channel_draft_51cto')),
        revision_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('passed', 'needs_author', 'review_failed')),
        repair_rounds INTEGER NOT NULL CHECK(repair_rounds BETWEEN 0 AND 3),
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO content_generation_reviews_v8 SELECT * FROM content_generation_reviews;
      DROP TABLE content_generation_reviews;
      ALTER TABLE content_generation_reviews_v8 RENAME TO content_generation_reviews;
    `);
    conn.prepare("DELETE FROM schema_migrations WHERE version = ?").run(CONTENT_GENERATION_REVIEW_REPAIR_ROUNDS_MIGRATION_VERSION);

    initialiseDatabase(conn);

    expect(reviews.latest(project.id, "outline", "# 原提纲")).toMatchObject({ status: "needs_author", repairRounds: 3, report: { summary: "旧评审记录" } });
    const latest = reviews.save(project.id, "outline", {
      status: "needs_author", markdown: "# 新提纲", findings: [], evidenceUsed: [], summary: "第五轮后保留", repairRounds: 5
    });
    expect(latest.repairRounds).toBe(5);
    expect(conn.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("content brief depth preference repair migration", () => {
  let database: AppDatabase | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(() => {
    database?.close();
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("repairs a v10 database whose ledger is current but whose brief column is missing", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;
    const workspace = new AccountRepository(conn).getOrCreateDefaultWorkspace();
    const project = new ContentProjectRepository(conn).create({ workspaceId: workspace.id, topic: "旧版开发库提纲" });
    conn.prepare("INSERT INTO content_briefs (project_id, topic, objective, audience, angle, source_notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(project.id, "旧版开发库提纲", "生成提纲", "开发者", "实用", "", "2026-10-01T00:00:00.000Z");
    conn.exec("ALTER TABLE content_briefs DROP COLUMN draft_depth_preference");
    conn.prepare("DELETE FROM schema_migrations WHERE version = ?").run(CONTENT_BRIEF_DEPTH_PREFERENCE_MIGRATION_VERSION);

    initialiseDatabase(conn);

    const briefColumns = conn.prepare("PRAGMA table_info(content_briefs)").all() as Array<{ name: string }>;
    expect(briefColumns.map((column) => column.name)).toContain("draft_depth_preference");
    expect(conn.prepare("SELECT topic, objective FROM content_briefs WHERE project_id = ?").get(project.id))
      .toEqual({ topic: "旧版开发库提纲", objective: "生成提纲" });
    expect(new ContentBriefRepository(conn).get(project.id).draftDepthPreference).toBeNull();
    expect(conn.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(CONTENT_BRIEF_DEPTH_PREFERENCE_MIGRATION_VERSION)).toBeTruthy();
    expect(conn.pragma("foreign_key_check")).toEqual([]);
  });

  it("backs up the database before repairing the recorded v10 schema on disk", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;
    const workspace = new AccountRepository(conn).getOrCreateDefaultWorkspace();
    const project = new ContentProjectRepository(conn).create({ workspaceId: workspace.id, topic: "需备份的旧库" });
    conn.prepare("INSERT INTO content_briefs (project_id, topic, objective, audience, angle, source_notes, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(project.id, "需备份的旧库", "保留内容", "开发者", "实用", "", "2026-10-01T00:00:00.000Z");
    conn.exec("ALTER TABLE content_briefs DROP COLUMN draft_depth_preference");
    // Keep v11 recorded to cover structural repair when the migration ledger
    // says current but the column is missing.
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-brief-depth-repair-"));
    conn.prepare("VACUUM INTO ?").run(path.join(temporaryDirectory, "contentferry.db"));
    database.close();

    database = openDatabase(temporaryDirectory);

    expect(new ContentBriefRepository(database.connection).get(project.id).objective).toBe("保留内容");
    expect(fs.readdirSync(path.join(temporaryDirectory, "backups")).some((name) => name.endsWith(".db"))).toBe(true);
  });
});

describe("content_research_sources migration", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("adds evidence_json to an existing research-source table", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;
    conn.exec("DROP TABLE content_research_sources");
    conn.exec(`CREATE TABLE content_research_sources (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      excerpt TEXT NOT NULL DEFAULT '',
      claims_json TEXT NOT NULL DEFAULT '[]',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      source_type TEXT NOT NULL,
      retrieved_at TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 1
    )`);
    initialiseDatabase(conn);
    const columns = conn.prepare("PRAGMA table_info(content_research_sources)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("evidence_json");
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

describe("cnblogs_publish_jobs migration (old schema without queued)", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("rebuilds the old table without losing existing jobs or events", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;
    conn.exec("DROP TABLE IF EXISTS cnblogs_publish_job_events");
    conn.exec("DROP TABLE IF EXISTS cnblogs_publish_jobs");
    conn.exec(`CREATE TABLE cnblogs_publish_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      account_id TEXT NOT NULL REFERENCES media_accounts(id),
      channel_draft_id TEXT NOT NULL REFERENCES channel_drafts(id),
      rendered_package_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('draft_creating', 'draft_created', 'confirming', 'published', 'failed', 'needs_manual_reconciliation', 'cancelled', 'needs_credentials')),
      remote_url TEXT,
      remote_content_id TEXT,
      status_note TEXT,
      error_message TEXT,
      status_source TEXT NOT NULL DEFAULT 'system' CHECK (status_source IN ('system', 'manual')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    conn.exec(`CREATE TABLE cnblogs_publish_job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES cnblogs_publish_jobs(id) ON DELETE CASCADE,
      previous_status TEXT,
      new_status TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    )`);
    conn.exec("INSERT INTO workspaces (id, display_name, timezone, created_at) VALUES ('w1', 'w', 'Asia/Shanghai', '2026-01-01T00:00:00Z')");
    conn.exec("INSERT INTO media_accounts (id, workspace_id, platform, display_name, created_at) VALUES ('a1', 'w1', 'cnblogs', 'a', '2026-01-01T00:00:00Z')");
    conn.exec("INSERT INTO channel_drafts (id, workspace_id, account_id, source_relative_path, source_hash, title, markdown, status, created_at, updated_at) VALUES ('d1', 'w1', 'a1', 'p', 'h', 't', 'm', 'approved', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
    conn.exec(`INSERT INTO cnblogs_publish_jobs
      (id, workspace_id, account_id, channel_draft_id, rendered_package_hash, idempotency_key, status, status_note, created_at, updated_at)
      VALUES ('j1', 'w1', 'a1', 'd1', 'h1', 'k1', 'draft_creating', '正在创建', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    conn.exec(`INSERT INTO cnblogs_publish_job_events
      (id, job_id, previous_status, new_status, source, reason, created_at)
      VALUES ('e1', 'j1', '', 'draft_creating', 'system', '创建', '2026-01-01T00:00:00Z')`);

    initialiseDatabase(conn);

    const tableSql = conn.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='cnblogs_publish_jobs'").get() as { sql: string };
    expect(tableSql.sql).toContain("'queued'");
    expect(conn.prepare("SELECT status FROM cnblogs_publish_jobs WHERE id = 'j1'").get()).toEqual({ status: "draft_creating" });
    expect(conn.prepare("SELECT id FROM cnblogs_publish_job_events WHERE id = 'e1'").get()).toEqual({ id: "e1" });
  });
});

describe("juejin_publish_jobs migration (old schema without queued)", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("rebuilds the old table without losing existing jobs or events", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;
    conn.exec("DROP TABLE IF EXISTS juejin_publish_job_events");
    conn.exec("DROP TABLE IF EXISTS juejin_publish_jobs");
    conn.exec(`CREATE TABLE juejin_publish_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      account_id TEXT NOT NULL REFERENCES media_accounts(id),
      channel_draft_id TEXT NOT NULL REFERENCES channel_drafts(id),
      rendered_package_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('draft_creating', 'draft_created', 'confirming', 'published', 'failed', 'needs_manual_reconciliation', 'cancelled', 'needs_credentials')),
      remote_url TEXT,
      remote_content_id TEXT,
      status_note TEXT,
      error_message TEXT,
      status_source TEXT NOT NULL DEFAULT 'system' CHECK (status_source IN ('system', 'manual')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    conn.exec(`CREATE TABLE juejin_publish_job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES juejin_publish_jobs(id) ON DELETE CASCADE,
      previous_status TEXT,
      new_status TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    )`);
    conn.exec("INSERT INTO workspaces (id, display_name, timezone, created_at) VALUES ('w1', 'w', 'Asia/Shanghai', '2026-01-01T00:00:00Z')");
    conn.exec("INSERT INTO media_accounts (id, workspace_id, platform, display_name, created_at) VALUES ('a1', 'w1', 'juejin', 'a', '2026-01-01T00:00:00Z')");
    conn.exec("INSERT INTO channel_drafts (id, workspace_id, account_id, source_relative_path, source_hash, title, markdown, status, created_at, updated_at) VALUES ('d1', 'w1', 'a1', 'p', 'h', 't', 'm', 'approved', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
    conn.exec(`INSERT INTO juejin_publish_jobs
      (id, workspace_id, account_id, channel_draft_id, rendered_package_hash, idempotency_key, status, status_note, created_at, updated_at)
      VALUES ('j1', 'w1', 'a1', 'd1', 'h1', 'k1', 'draft_creating', '正在创建', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    conn.exec(`INSERT INTO juejin_publish_job_events
      (id, job_id, previous_status, new_status, source, reason, created_at)
      VALUES ('e1', 'j1', '', 'draft_creating', 'system', '创建', '2026-01-01T00:00:00Z')`);

    initialiseDatabase(conn);

    const tableSql = conn.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='juejin_publish_jobs'").get() as { sql: string };
    expect(tableSql.sql).toContain("'queued'");
    expect(conn.prepare("SELECT status FROM juejin_publish_jobs WHERE id = 'j1'").get()).toEqual({ status: "draft_creating" });
    expect(conn.prepare("SELECT id FROM juejin_publish_job_events WHERE id = 'e1'").get()).toEqual({ id: "e1" });
  });
});

describe("fiftyone_cto_publish_jobs migration (old schema without pid/cate_id/tags/blog_type)", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("adds the four publish-option columns to a legacy table without losing rows", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;

    // 卸下当前表，替换为「旧 schema」形态：没有 pid / cate_id / tags / blog_type。
    conn.exec("DROP TABLE IF EXISTS fiftyone_cto_publish_job_events");
    conn.exec("DROP TABLE IF EXISTS fiftyone_cto_publish_jobs");
    conn.exec(`CREATE TABLE fiftyone_cto_publish_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      account_id TEXT NOT NULL REFERENCES media_accounts(id),
      channel_draft_id TEXT NOT NULL REFERENCES channel_drafts(id),
      rendered_package_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      remote_url TEXT,
      remote_content_id TEXT,
      status_note TEXT,
      error_message TEXT,
      status_source TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    conn.exec(`CREATE TABLE fiftyone_cto_publish_job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES fiftyone_cto_publish_jobs(id) ON DELETE CASCADE,
      previous_status TEXT,
      new_status TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    )`);

    // 合法父行 + 一条已发布的旧任务。
    conn.exec("INSERT INTO workspaces (id, display_name, timezone, created_at) VALUES ('w1', 'w', 'Asia/Shanghai', '2026-01-01T00:00:00Z')");
    conn.exec("INSERT INTO media_accounts (id, workspace_id, platform, display_name, created_at) VALUES ('a1', 'w1', '51cto', 'a', '2026-01-01T00:00:00Z')");
    conn.exec("INSERT INTO channel_drafts (id, workspace_id, account_id, source_relative_path, source_hash, title, markdown, status, created_at, updated_at) VALUES ('d1', 'w1', 'a1', 'p', 'h', 't', 'm', 'approved', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
    conn.exec(`INSERT INTO fiftyone_cto_publish_jobs
      (id, workspace_id, account_id, channel_draft_id, rendered_package_hash, idempotency_key, status, status_note, created_at, updated_at)
      VALUES ('j1', 'w1', 'a1', 'd1', 'h1', 'k1', 'published', '已发布', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);

    // 重新触发迁移（createInitialTables 走 IF NOT EXISTS 跳过，ALTER 补列）。
    initialiseDatabase(conn);

    const columns = conn.prepare("PRAGMA table_info(fiftyone_cto_publish_jobs)").all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    expect(names).toContain("pid");
    expect(names).toContain("cate_id");
    expect(names).toContain("tags");
    expect(names).toContain("blog_type");

    // 旧行未填新列，迁移后应为 NULL（mapJob 会把 NULL 回退成 "" / [] / "1"）。
    const row = conn.prepare(
      "SELECT id, status, pid, cate_id, tags, blog_type FROM fiftyone_cto_publish_jobs WHERE id = ?"
    ).get("j1") as { id: string; status: string; pid: string | null; cate_id: string | null; tags: string | null; blog_type: string | null };
    expect(row.id).toBe("j1");
    expect(row.status).toBe("published");
    expect(row.pid).toBeNull();
    expect(row.cate_id).toBeNull();
    expect(row.tags).toBeNull();
    expect(row.blog_type).toBeNull();
  });
});

describe("account_profiles migration (old schema without fiftyone_cto_cate_options_by_pid)", () => {
  let database: AppDatabase | undefined;

  afterEach(() => database?.close());

  it("adds the pid-grouped category column without losing existing category options", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;

    // 老库形态：有未分组的 pid/cate 选项，但没有按 pid 分组的列（二级分类联动是后加的）。
    conn.exec("DROP TABLE IF EXISTS account_profiles");
    conn.exec(`CREATE TABLE account_profiles (
      account_id TEXT PRIMARY KEY REFERENCES media_accounts(id) ON DELETE CASCADE,
      positioning TEXT NOT NULL DEFAULT '',
      target_audience TEXT NOT NULL DEFAULT '',
      prohibited_topics TEXT NOT NULL DEFAULT '',
      writing_style TEXT NOT NULL DEFAULT '',
      regular_columns TEXT NOT NULL DEFAULT '',
      article_signature TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      fiftyone_cto_pid_options TEXT NOT NULL DEFAULT '',
      fiftyone_cto_cate_options TEXT NOT NULL DEFAULT ''
    )`);

    conn.exec("INSERT INTO workspaces (id, display_name, timezone, created_at) VALUES ('w1', 'w', 'Asia/Shanghai', '2026-01-01T00:00:00Z')");
    conn.exec("INSERT INTO media_accounts (id, workspace_id, platform, display_name, created_at) VALUES ('a1', 'w1', '51cto', 'a', '2026-01-01T00:00:00Z')");
    conn.exec(`INSERT INTO account_profiles
      (account_id, fiftyone_cto_pid_options, fiftyone_cto_cate_options, updated_at)
      VALUES ('a1', '[{"value":"176","label":"后端"}]', '[{"value":"200","label":"Java"}]', '2026-01-01T00:00:00Z')`);

    initialiseDatabase(conn);

    const columns = conn.prepare("PRAGMA table_info(account_profiles)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("fiftyone_cto_cate_options_by_pid");

    // 旧数据不能丢：未分组选项原样保留，新列为空（渲染层据此降级到未分组选项）。
    const row = conn.prepare(
      "SELECT fiftyone_cto_pid_options, fiftyone_cto_cate_options, fiftyone_cto_cate_options_by_pid FROM account_profiles WHERE account_id = ?"
    ).get("a1") as { fiftyone_cto_pid_options: string; fiftyone_cto_cate_options: string; fiftyone_cto_cate_options_by_pid: string };
    expect(JSON.parse(row.fiftyone_cto_pid_options)).toEqual([{ value: "176", label: "后端" }]);
    expect(JSON.parse(row.fiftyone_cto_cate_options)).toEqual([{ value: "200", label: "Java" }]);
    expect(row.fiftyone_cto_cate_options_by_pid).toBe("");
  });
});

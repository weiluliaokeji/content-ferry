import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, openInMemoryDatabase } from "../db/database";
import { ARTICLE_PRACTICE_TASK_MIGRATION_VERSION, migrateArticlePracticeTasks } from "./article-practice-task-migration";
import { ARTICLE_PRACTICE_PROJECT_DIRECTORY_MIGRATION_VERSION } from "./article-practice-project-directory-migration";
import { migrateArticlePracticeProjectDirectory } from "./article-practice-project-directory-migration";
import { ARTICLE_PRACTICE_LEGACY_EXECUTION_MIGRATION_VERSION } from "./article-practice-legacy-execution-migration";
import { ARTICLE_PRACTICE_GAP_FLAG_MIGRATION_VERSION, migrateArticlePracticeGapFlag } from "./article-practice-gap-flag-migration";
import { ARTICLE_PRACTICE_INDEPENDENT_EDIT_MIGRATION_VERSION, migrateArticlePracticeIndependentEdits } from "./article-practice-independent-edit-migration";

describe("article practice task migration", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("creates current tables through the numbered migration and can reopen them", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-practice-schema-"));
    directories.push(directory);
    const first = openDatabase(directory);
    expect(first.connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: ARTICLE_PRACTICE_TASK_MIGRATION_VERSION },
      { version: ARTICLE_PRACTICE_PROJECT_DIRECTORY_MIGRATION_VERSION },
      { version: ARTICLE_PRACTICE_LEGACY_EXECUTION_MIGRATION_VERSION },
      { version: ARTICLE_PRACTICE_GAP_FLAG_MIGRATION_VERSION },
      { version: ARTICLE_PRACTICE_INDEPENDENT_EDIT_MIGRATION_VERSION }
    ]);
    first.close();
    const reopened = openDatabase(directory);
    expect(reopened.connection.prepare("SELECT name FROM sqlite_master WHERE name = 'article_practice_tasks'").get()).toEqual({ name: "article_practice_tasks" });
    expect(reopened.connection.pragma("foreign_key_check")).toEqual([]);
    reopened.close();
  });

  it("backs up an older file database before migration and preserves its project", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-practice-upgrade-"));
    directories.push(directory);
    const first = openDatabase(directory);
    first.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)")
      .run("workspace", "旧数据", "2026-09-01T00:00:00Z");
    first.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("project", "workspace", "保留文章", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
    first.connection.exec("ALTER TABLE content_projects DROP COLUMN practice_project_directory");
    first.connection.exec("DROP INDEX idx_article_practice_legacy_execution; ALTER TABLE article_practice_tasks DROP COLUMN legacy_execution_run_id; ALTER TABLE article_practice_tasks DROP COLUMN source_type; ALTER TABLE article_practice_tasks DROP COLUMN has_gaps");
    first.connection.prepare("DELETE FROM schema_migrations WHERE version = ?").run(ARTICLE_PRACTICE_PROJECT_DIRECTORY_MIGRATION_VERSION);
    first.connection.prepare("DELETE FROM schema_migrations WHERE version = ?").run(ARTICLE_PRACTICE_LEGACY_EXECUTION_MIGRATION_VERSION);
    first.connection.prepare("DELETE FROM schema_migrations WHERE version = ?").run(ARTICLE_PRACTICE_GAP_FLAG_MIGRATION_VERSION);
    first.connection.prepare("DELETE FROM schema_migrations WHERE version = ?").run(ARTICLE_PRACTICE_INDEPENDENT_EDIT_MIGRATION_VERSION);
    first.close();

    const upgraded = openDatabase(directory);
    expect(upgraded.connection.prepare("SELECT topic FROM content_projects WHERE id = 'project'").get()).toEqual({ topic: "保留文章" });
    expect(upgraded.connection.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get()).toEqual({ version: ARTICLE_PRACTICE_INDEPENDENT_EDIT_MIGRATION_VERSION });
    upgraded.close();
    const backups = fs.readdirSync(path.join(directory, "backups"));
    expect(backups).toHaveLength(1);
    const backup = new Database(path.join(directory, "backups", backups[0]!));
    expect(backup.prepare("SELECT topic FROM content_projects WHERE id = 'project'").get()).toEqual({ topic: "保留文章" });
    expect(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'article_practice_tasks'").get()).toEqual({ name: "article_practice_tasks" });
    expect((backup.pragma("table_info(content_projects)") as Array<{ name: string }>).some((column) => column.name === "practice_project_directory")).toBe(false);
    backup.close();
  });

  it("repairs a v3 practice table missing has_gaps, preserves old gap status, and backs up before migration", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-practice-gap-upgrade-"));
    directories.push(directory);
    const old = openDatabase(directory);
    const db = old.connection;
    db.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("workspace", "旧数据", "2026-09-01T00:00:00Z");
    db.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("project", "workspace", "保留任务", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z");
    db.prepare(`INSERT INTO article_practice_tasks
      (id, project_id, status, goal_revision, latest_goal, checkpoint_json, event_seq, created_at, updated_at, source_type)
      VALUES (?, ?, 'completed_with_gaps', 1, ?, '{}', 0, ?, ?, 'awen')`)
      .run("task-with-gaps", "project", "旧任务", "2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z");
    db.exec("ALTER TABLE article_practice_tasks DROP COLUMN has_gaps");
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(ARTICLE_PRACTICE_GAP_FLAG_MIGRATION_VERSION);
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(ARTICLE_PRACTICE_INDEPENDENT_EDIT_MIGRATION_VERSION);
    old.close();

    const upgraded = openDatabase(directory);
    expect(upgraded.connection.prepare("SELECT status, has_gaps FROM article_practice_tasks WHERE id = ?").get("task-with-gaps"))
      .toEqual({ status: "completed_with_gaps", has_gaps: 1 });
    expect(upgraded.connection.pragma("foreign_key_check")).toEqual([]);
    upgraded.close();

    const backups = fs.readdirSync(path.join(directory, "backups"));
    expect(backups).toHaveLength(1);
    const backup = new Database(path.join(directory, "backups", backups[0]!));
    expect((backup.pragma("table_info(article_practice_tasks)") as Array<{ name: string }>).some((column) => column.name === "has_gaps")).toBe(false);
    expect(backup.prepare("SELECT id FROM article_practice_tasks WHERE id = ?").get("task-with-gaps")).toEqual({ id: "task-with-gaps" });
    backup.close();
  });

  it("rejects a database from a newer program before changing it", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-practice-future-"));
    directories.push(directory);
    const first = openDatabase(directory);
    first.connection.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(999, "2026-09-25T00:00:00Z");
    first.close();
    expect(() => openDatabase(directory)).toThrow("比当前程序支持的版本更新");
    const raw = new Database(path.join(directory, "contentferry.db"));
    expect(raw.prepare("SELECT version FROM schema_migrations WHERE version = 999").get()).toEqual({ version: 999 });
    raw.close();
  });

  it("rolls back a failed migration without recording its version", () => {
    const database = openInMemoryDatabase();
    const db = database.connection;
    db.exec("DROP TABLE article_practice_task_events; DROP TABLE article_practice_tasks; DELETE FROM schema_migrations WHERE version = 1");
    db.exec("CREATE TABLE article_practice_task_events (blocking_column TEXT)");
    expect(() => migrateArticlePracticeTasks(db)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'article_practice_tasks'").get()).toBeUndefined();
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get()).toBeUndefined();
    database.close();
  });

  it("rolls back the project-directory column when its migration record cannot be written", () => {
    const database = openInMemoryDatabase();
    const db = database.connection;
    db.exec("ALTER TABLE content_projects DROP COLUMN practice_project_directory");
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(ARTICLE_PRACTICE_PROJECT_DIRECTORY_MIGRATION_VERSION);
    db.exec(`CREATE TRIGGER reject_practice_directory_migration BEFORE INSERT ON schema_migrations
      WHEN NEW.version = ${ARTICLE_PRACTICE_PROJECT_DIRECTORY_MIGRATION_VERSION}
      BEGIN SELECT RAISE(ABORT, 'migration ledger unavailable'); END`);

    expect(() => migrateArticlePracticeProjectDirectory(db)).toThrow("migration ledger unavailable");
    expect((db.pragma("table_info(content_projects)") as Array<{ name: string }>).some((column) => column.name === "practice_project_directory")).toBe(false);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(ARTICLE_PRACTICE_PROJECT_DIRECTORY_MIGRATION_VERSION)).toBeUndefined();
    database.close();
  });

  it("rolls back the gap flag column when its migration record cannot be written", () => {
    const database = openInMemoryDatabase();
    const db = database.connection;
    db.exec("ALTER TABLE article_practice_tasks DROP COLUMN has_gaps");
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(ARTICLE_PRACTICE_GAP_FLAG_MIGRATION_VERSION);
    db.exec(`CREATE TRIGGER reject_gap_flag_migration BEFORE INSERT ON schema_migrations
      WHEN NEW.version = ${ARTICLE_PRACTICE_GAP_FLAG_MIGRATION_VERSION}
      BEGIN SELECT RAISE(ABORT, 'migration ledger unavailable'); END`);

    expect(() => migrateArticlePracticeGapFlag(db)).toThrow("migration ledger unavailable");
    expect((db.pragma("table_info(article_practice_tasks)") as Array<{ name: string }>).some((column) => column.name === "has_gaps")).toBe(false);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(ARTICLE_PRACTICE_GAP_FLAG_MIGRATION_VERSION)).toBeUndefined();
    database.close();
  });

  it("rolls back the active-task index change when its migration record cannot be written", () => {
    const database = openInMemoryDatabase();
    const db = database.connection;
    db.exec("DROP INDEX idx_article_practice_one_active");
    db.exec(`CREATE UNIQUE INDEX idx_article_practice_one_active ON article_practice_tasks(project_id)
      WHERE status NOT IN ('completed', 'completed_with_gaps', 'stopped', 'failed')`);
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(ARTICLE_PRACTICE_INDEPENDENT_EDIT_MIGRATION_VERSION);
    db.exec(`CREATE TRIGGER reject_independent_edit_migration BEFORE INSERT ON schema_migrations
      WHEN NEW.version = ${ARTICLE_PRACTICE_INDEPENDENT_EDIT_MIGRATION_VERSION}
      BEGIN SELECT RAISE(ABORT, 'migration ledger unavailable'); END`);

    expect(() => migrateArticlePracticeIndependentEdits(db)).toThrow("migration ledger unavailable");
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_article_practice_one_active'").get() as { sql: string };
    expect(index.sql).not.toContain("waiting_edit_confirmation");
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(ARTICLE_PRACTICE_INDEPENDENT_EDIT_MIGRATION_VERSION)).toBeUndefined();
    database.close();
  });
});

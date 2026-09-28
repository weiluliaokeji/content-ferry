import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database";
import { ARTICLE_PRACTICE_LEGACY_EXECUTION_MIGRATION_VERSION } from "./article-practice-legacy-execution-migration";
import { ARTICLE_PRACTICE_GAP_FLAG_MIGRATION_VERSION } from "./article-practice-gap-flag-migration";
import { ARTICLE_PRACTICE_INDEPENDENT_EDIT_MIGRATION_VERSION } from "./article-practice-independent-edit-migration";
import { ArticlePracticeTaskRepository } from "./article-practice-task-repository";

describe("legacy execution practice migration", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("backs up an older database, links only retired manual runs, and leaves raw execution records untouched", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-legacy-practice-upgrade-"));
    directories.push(directory);
    const opened = openDatabase(directory);
    const db = opened.connection;
    db.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)")
      .run("workspace", "旧执行迁移", "2026-09-01T00:00:00.000Z");
    db.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("project", "workspace", "保留文章", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    const insertRun = db.prepare(`INSERT INTO execution_runs
      (id, project_id, request_json, preflight_json, status, stdout, created_at, finished_at)
      VALUES (?, ?, ?, '{}', 'completed', ?, ?, ?)`);
    insertRun.run("manual-run", "project", JSON.stringify({ runtime: "node", cwd: "C:/private/project", args: ["secret-script.js"] }),
      "private output", "2026-09-20T10:00:00.000Z", "2026-09-20T10:00:01.000Z");
    insertRun.run("awen-run", "project", JSON.stringify({ runtime: "node", practiceTaskId: "existing-task" }),
      "awen output", "2026-09-20T10:01:00.000Z", "2026-09-20T10:01:01.000Z");
    insertRun.run("workflow-run", "project", JSON.stringify({ runtime: "node", workflowId: "old-workflow" }),
      "workflow output", "2026-09-20T10:02:00.000Z", "2026-09-20T10:02:01.000Z");
    insertRun.run("unlinked-run", null, JSON.stringify({ runtime: "node" }),
      "unlinked output", "2026-09-20T10:03:00.000Z", "2026-09-20T10:03:01.000Z");
    opened.close();

    // Recreate the supported v2 schema so opening the app runs the v3 migration.
    const old = new Database(path.join(directory, "contentferry.db"));
    old.pragma("foreign_keys = OFF");
    old.exec("DROP INDEX idx_article_practice_legacy_execution; ALTER TABLE article_practice_tasks DROP COLUMN legacy_execution_run_id; ALTER TABLE article_practice_tasks DROP COLUMN source_type;");
    old.prepare("DELETE FROM schema_migrations WHERE version = ?").run(ARTICLE_PRACTICE_LEGACY_EXECUTION_MIGRATION_VERSION);
    old.prepare("DELETE FROM schema_migrations WHERE version = ?").run(ARTICLE_PRACTICE_GAP_FLAG_MIGRATION_VERSION);
    old.prepare("DELETE FROM schema_migrations WHERE version = ?").run(ARTICLE_PRACTICE_INDEPENDENT_EDIT_MIGRATION_VERSION);
    old.close();

    const upgraded = openDatabase(directory);
    const repository = new ArticlePracticeTaskRepository(upgraded.connection);
    const tasks = repository.listRecent("project", 10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      sourceType: "legacy_manual", legacyExecutionRunId: "manual-run", status: "completed_with_gaps", hasGaps: true,
      latestGoal: "旧版本机执行记录", createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-20T10:00:01.000Z"
    });
    expect(repository.listEvents(tasks[0]!.id).map((event) => event.kind)).toEqual(["created", "legacy_execution_linked"]);
    expect(JSON.stringify(repository.listEvents(tasks[0]!.id))).not.toMatch(/private|secret-script|private output/iu);
    expect(upgraded.connection.prepare("SELECT stdout FROM execution_runs WHERE id = 'manual-run'").get()).toEqual({ stdout: "private output" });
    expect(upgraded.connection.prepare("SELECT id FROM article_practice_tasks WHERE legacy_execution_run_id IN ('awen-run', 'workflow-run')").all()).toEqual([]);
    expect(upgraded.connection.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(ARTICLE_PRACTICE_LEGACY_EXECUTION_MIGRATION_VERSION)).toBeTruthy();
    expect(upgraded.connection.pragma("foreign_key_check")).toEqual([]);
    upgraded.close();

    const backupPath = path.join(directory, "backups", fs.readdirSync(path.join(directory, "backups"))[0]!);
    const backup = new Database(backupPath);
    expect(backup.prepare("SELECT id FROM execution_runs WHERE id = 'manual-run'").get()).toEqual({ id: "manual-run" });
    expect((backup.pragma("table_info(article_practice_tasks)") as Array<{ name: string }>).some((column) => column.name === "source_type")).toBe(false);
    backup.close();

    const reopened = openDatabase(directory);
    expect(reopened.connection.prepare("SELECT COUNT(*) AS count FROM article_practice_tasks WHERE legacy_execution_run_id = 'manual-run'").get()).toEqual({ count: 1 });
    reopened.close();
  });
});

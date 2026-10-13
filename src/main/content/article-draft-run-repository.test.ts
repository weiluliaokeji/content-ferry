import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, openInMemoryDatabase, type AppDatabase } from "../db/database";
import { AccountRepository } from "../accounts/account-repository";
import { ContentProjectRepository } from "./content-project-repository";
import { ArticleDraftRunRepository } from "./article-draft-run-repository";
import { ARTICLE_DRAFT_RUN_MIGRATION_VERSION, migrateArticleDraftRuns } from "./article-draft-run-migration";
import { ContentGenerationReviewRepository } from "./content-generation-review-repository";
import { ContentBriefRepository } from "./content-brief-repository";

describe("article draft run persistence", () => {
  let database: AppDatabase | undefined;
  afterEach(() => database?.close());

  it("persists checkpoints and append-only ordered events with cursor reads", () => {
    database = openInMemoryDatabase();
    const workspace = new AccountRepository(database.connection).getOrCreateDefaultWorkspace();
    const project = new ContentProjectRepository(database.connection).create({ workspaceId: workspace.id, topic: "Scoop 指南" });
    const runs = new ArticleDraftRunRepository(database.connection);
    const run = runs.create(project.id, "detailed", { scope: "guide" }, new Date("2026-10-01T00:00:00Z"));

    runs.appendEvent(run.id, "progress", "assessing_practice", "正在评估是否需要实践。", { useful: true });
    runs.updateCheckpoint(run.id, { evidenceWorkRounds: 1 }, {
      stage: "drafting", depthPlan: { targetReadingMinutes: 10 }, draftRevisionSha256: "abc"
    });
    runs.updateCheckpoint(run.id, { proseRevisionRounds: 2 });

    expect(runs.getActive(project.id)).toMatchObject({ id: run.id, status: "running", stage: "drafting", depthPreference: "detailed" });
    expect(runs.listEvents(run.id).map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(runs.listEvents(run.id, 1).map((event) => event.kind)).toEqual(["progress", "checkpoint_updated", "checkpoint_updated"]);
    expect(runs.require(run.id).checkpoint).toEqual({ evidenceWorkRounds: 1, proseRevisionRounds: 2 });
  });

  it("retains the final status and prevents appending after completion", () => {
    database = openInMemoryDatabase();
    const workspace = new AccountRepository(database.connection).getOrCreateDefaultWorkspace();
    const project = new ContentProjectRepository(database.connection).create({ workspaceId: workspace.id, topic: "Scoop 指南" });
    const runs = new ArticleDraftRunRepository(database.connection);
    const run = runs.create(project.id);

    expect(runs.finish(run.id, "needs_author", "needs_author", "仍有实践缺口待处理。").status).toBe("needs_author");
    expect(() => runs.appendEvent(run.id, "progress", "needs_author", "重复事件")).toThrow("已结束");
    expect(runs.listEvents(run.id).at(-1)).toMatchObject({ kind: "stopped", summary: "仍有实践缺口待处理。" });
  });

  it("marks an interrupted run for author review without replaying side effects", () => {
    database = openInMemoryDatabase();
    const workspace = new AccountRepository(database.connection).getOrCreateDefaultWorkspace();
    const project = new ContentProjectRepository(database.connection).create({ workspaceId: workspace.id, topic: "恢复中的指南" });
    const runs = new ArticleDraftRunRepository(database.connection);
    const run = runs.create(project.id);
    runs.updateCheckpoint(run.id, { sourceArticleRevisionSha256: "original-hash" }, { draftRevisionSha256: "candidate-hash" });
    runs.updateCheckpoint(run.id, {}, { outlineRevisionSha256: "original-outline-hash" });
    runs.appendEvent(run.id, "progress", "practicing", "已完成一次授权实践观察。");

    const recovered = runs.reconcileInterrupted(run.id, {
      currentArticleRevisionSha256: "current-hash",
      currentOutlineRevisionSha256: "current-outline-hash",
      adoptedResearchCardIds: ["accepted-card-1", "accepted-card-2"],
      practiceTask: {
        id: "practice-task-1", status: "waiting_resume_choice", workflowStatus: "interrupted",
        authorizationState: "requires_reconfirmation"
      }
    });

    expect(recovered).toMatchObject({ status: "needs_author", stage: "needs_author", draftRevisionSha256: "candidate-hash",
      checkpoint: {
        sourceArticleRevisionSha256: "original-hash", recoveredArticleRevisionSha256: "current-hash",
        recoveredOutlineRevisionSha256: "current-outline-hash", recoveredResearchCardIds: ["accepted-card-1", "accepted-card-2"],
        recoveredPracticeTaskId: "practice-task-1", recoveredPracticeTaskStatus: "waiting_resume_choice",
        recoveredPracticeWorkflowStatus: "interrupted", recoveredAuthorizationState: "requires_reconfirmation"
      } });
    expect(recovered.checkpoint.stoppingReason).toContain("不会重放");
    expect(runs.listInterrupted()).toEqual([]);
    expect(runs.listEvents(run.id).at(-1)).toMatchObject({ kind: "stopped", payload: {
      recoveredAfterRestart: true, candidateNeedsRevalidation: true, sourceArticleChanged: true, outlineChanged: true,
      adoptedResearchCardCount: 2, practiceTaskStatus: "waiting_resume_choice", practiceWorkflowStatus: "interrupted",
      authorizationState: "requires_reconfirmation"
    } });
  });

  it("backs up and upgrades a historical on-disk schema while preserving article and review data", () => {
    database = openInMemoryDatabase();
    const conn = database.connection;
    const workspace = new AccountRepository(conn).getOrCreateDefaultWorkspace();
    const project = new ContentProjectRepository(conn).create({ workspaceId: workspace.id, topic: "保留的正文指南" });
    conn.prepare(`INSERT INTO content_briefs (project_id, topic, objective, audience, angle, source_notes, updated_at)
      VALUES (?, ?, '', '', '', '', ?)`).run(project.id, project.topic, "2026-01-01T00:00:00Z");
    new ContentGenerationReviewRepository(conn).save(project.id, "draft", {
      status: "needs_author", markdown: "# 保留内容", findings: [], evidenceUsed: [], summary: "旧评审快照", repairRounds: 1
    });
    conn.exec(`DROP TABLE article_draft_run_events; DROP TABLE article_draft_runs; DELETE FROM schema_migrations WHERE version IN (10, 11);
      DROP TABLE content_briefs;
      CREATE TABLE content_briefs (project_id TEXT PRIMARY KEY REFERENCES content_projects(id) ON DELETE CASCADE,
        topic TEXT NOT NULL DEFAULT '', objective TEXT NOT NULL DEFAULT '', audience TEXT NOT NULL DEFAULT '', angle TEXT NOT NULL DEFAULT '',
        source_notes TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);`);
    conn.prepare(`INSERT INTO content_briefs (project_id, topic, objective, audience, angle, source_notes, updated_at)
      VALUES (?, '保留的主题', '', '', '', '', '2026-01-01T00:00:00Z')`).run(project.id);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-draft-run-v9-"));
    try {
      const file = path.join(directory, "contentferry.db");
      conn.prepare("VACUUM INTO ?").run(file);
      database.close();
      database = openDatabase(directory);
      const upgraded = database.connection;
      expect(upgraded.prepare("SELECT topic FROM content_briefs WHERE project_id = ?").get(project.id)).toEqual({ topic: "保留的主题" });
      expect(upgraded.prepare("SELECT status FROM content_generation_reviews WHERE project_id = ?").get(project.id)).toEqual({ status: "needs_author" });
      expect((upgraded.prepare("PRAGMA table_info(content_briefs)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("draft_depth_preference");
      expect(upgraded.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(ARTICLE_DRAFT_RUN_MIGRATION_VERSION)).toBeTruthy();
      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
      expect(fs.readdirSync(path.join(directory, "backups")).some((name) => name.endsWith(".db"))).toBe(true);
      expect(() => migrateArticleDraftRuns(upgraded)).not.toThrow();
      expect(upgraded.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?").get(ARTICLE_DRAFT_RUN_MIGRATION_VERSION)).toEqual({ count: 1 });
    } finally {
      database.close();
      database = undefined;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back an incomplete v9-to-v10 schema migration and can retry after repair", () => {
    database = openInMemoryDatabase();
    const db = database.connection;
    db.exec("DROP TABLE article_draft_run_events; DROP TABLE article_draft_runs; DELETE FROM schema_migrations WHERE version IN (10, 11);");
    db.exec("CREATE TABLE article_draft_runs (id TEXT PRIMARY KEY)");

    expect(() => migrateArticleDraftRuns(db)).toThrow();
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(ARTICLE_DRAFT_RUN_MIGRATION_VERSION)).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'article_draft_run_events'").get()).toBeUndefined();

    db.exec("DROP TABLE article_draft_runs");
    migrateArticleDraftRuns(db);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(ARTICLE_DRAFT_RUN_MIGRATION_VERSION)).toBeTruthy();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("draft depth preference persistence", () => {
  let database: AppDatabase | undefined;
  afterEach(() => database?.close());

  it("keeps the existing adaptive default and round-trips an explicit depth selection", () => {
    database = openInMemoryDatabase();
    const workspace = new AccountRepository(database.connection).getOrCreateDefaultWorkspace();
    const project = new ContentProjectRepository(database.connection).create({ workspaceId: workspace.id, topic: "Scoop 指南" });
    const briefs = new ContentBriefRepository(database.connection);
    const initial = briefs.save(project.id, { topic: project.topic, objective: "", audience: "", angle: "", sourceNotes: "" });
    expect(initial.draftDepthPreference).toBeNull();
    const selected = briefs.save(project.id, { ...initial, draftDepthPreference: "concise" });
    expect(selected.draftDepthPreference).toBe("concise");
    const updateWithoutPreference = briefs.save(project.id, { topic: project.topic, objective: "目标已更新", audience: "", angle: "", sourceNotes: "" });
    expect(updateWithoutPreference.draftDepthPreference).toBe("concise");
    expect(briefs.get(project.id).draftDepthPreference).toBe("concise");
  });
});

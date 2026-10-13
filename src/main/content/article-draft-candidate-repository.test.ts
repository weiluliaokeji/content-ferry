import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initialiseDatabase, openDatabase, openInMemoryDatabase } from "../db/database";
import { ARTICLE_DRAFT_CANDIDATE_MIGRATION_VERSION, migrateArticleDraftCandidates } from "./article-draft-candidate-migration";
import { ArticleDraftCandidateRepository } from "./article-draft-candidate-repository";
import { ArticleDraftRunRepository } from "./article-draft-run-repository";

function seedProject(db: Database.Database): void {
  const at = "2026-01-01T00:00:00.000Z";
  db.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("w", "测试", at);
  db.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("p", "w", "文章", at, at);
}

describe("ArticleDraftCandidateRepository", () => {
  it("keeps an interrupted candidate recoverable without marking the formal draft ready", () => {
    const database = openInMemoryDatabase();
    try {
      seedProject(database.connection);
      const run = new ArticleDraftRunRepository(database.connection).create("p");
      const candidates = new ArticleDraftCandidateRepository(database.connection);
      const first = candidates.save(run.id, "# 候选\n\n待实践。", new Date("2026-01-02T00:00:00Z"));
      expect(candidates.require(run.id)).toEqual(first);
      expect(first.revisionSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(candidates.save(run.id, "# 候选\n\n已修订。", new Date("2026-01-03T00:00:00Z")).createdAt).toBe(first.createdAt);
      expect(candidates.require(run.id).markdown).toContain("已修订");
      expect(database.connection.prepare("SELECT 1 FROM content_drafts WHERE project_id = 'p'").get()).toBeUndefined();
      expect(database.connection.prepare("SELECT 1 FROM article_draft_candidates WHERE run_id = ?").get(run.id)).toBeTruthy();
      expect(database.connection.pragma("foreign_key_check")).toEqual([]);
    } finally { database.close(); }
  });

  it("backs up a v12 database before v13 and preserves project and run records", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-draft-candidate-"));
    try {
      const first = openDatabase(directory);
      seedProject(first.connection);
      const run = new ArticleDraftRunRepository(first.connection).create("p");
      first.connection.exec(`DROP TABLE article_draft_candidates; DELETE FROM schema_migrations WHERE version = ${ARTICLE_DRAFT_CANDIDATE_MIGRATION_VERSION}`);
      first.close();
      const upgraded = openDatabase(directory);
      expect(upgraded.connection.prepare("SELECT topic FROM content_projects WHERE id = 'p'").get()).toEqual({ topic: "文章" });
      expect(upgraded.connection.prepare("SELECT id FROM article_draft_runs WHERE id = ?").get(run.id)).toEqual({ id: run.id });
      expect(new ArticleDraftCandidateRepository(upgraded.connection).save(run.id, "# 仍可继续").markdown).toBe("# 仍可继续");
      expect(upgraded.connection.pragma("foreign_key_check")).toEqual([]);
      upgraded.close();
      const backups = fs.readdirSync(path.join(directory, "backups"));
      expect(backups).toHaveLength(1);
      const backup = new Database(path.join(directory, "backups", backups[0]!));
      expect(backup.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(ARTICLE_DRAFT_CANDIDATE_MIGRATION_VERSION)).toBeUndefined();
      expect(backup.prepare("SELECT id FROM article_draft_runs WHERE id = ?").get(run.id)).toEqual({ id: run.id });
      backup.close();
      const reopened = openDatabase(directory);
      expect(new ArticleDraftCandidateRepository(reopened.connection).require(run.id).markdown).toBe("# 仍可继续");
      reopened.close();
      expect(fs.readdirSync(path.join(directory, "backups"))).toHaveLength(1);
    } finally {
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith("contentferry-draft-candidate-")) {
        throw new Error("Refusing to remove an unexpected test directory.");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  it("rolls back the migration ledger on a schema failure", () => {
    const database = openInMemoryDatabase();
    try {
      database.connection.exec(`DROP TABLE article_draft_candidates; DELETE FROM schema_migrations WHERE version = ${ARTICLE_DRAFT_CANDIDATE_MIGRATION_VERSION}`);
      database.connection.exec("CREATE TABLE article_draft_candidates (broken TEXT)");
      expect(() => migrateArticleDraftCandidates(database.connection)).toThrow();
      expect(database.connection.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(ARTICLE_DRAFT_CANDIDATE_MIGRATION_VERSION)).toBeUndefined();
      expect(() => initialiseDatabase(database.connection)).toThrow();
    } finally { database.close(); }
  });
});

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase, openInMemoryDatabase, initialiseDatabase } from "../db/database";
import { ContentResearchRepository } from "./content-research-repository";
import { ARTICLE_RESEARCH_LINK_MIGRATION_VERSION } from "./article-research-link-migration";
import { ARTICLE_DRAFT_CANDIDATE_MIGRATION_VERSION } from "./article-draft-candidate-migration";
import { ArticleResearchLinkRepository } from "./article-research-link-repository";

const excerpt = "官方安装文档写明，先在 PowerShell 中检查执行策略，再运行当前安装命令。";
const claim = "安装前应核对 PowerShell 执行策略。";
const markdown = `# 安装指南\n\n${claim}还应对照官方页面确认命令。`;

function fixture() {
  const database = openInMemoryDatabase();
  const db = database.connection;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES (?, ?, ?)").run("w", "测试", now);
  db.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run("p", "w", "安装指南", now, now);
  const research = new ContentResearchRepository(db);
  const saved = research.save("p", { planMarkdown: "", sources: [{
    title: "官方安装文档", url: "https://example.com/install", excerpt, keyClaims: [claim], sourceType: "official",
    evidence: { kind: "official", claim, recommendation: "", qualityReason: "", freshness: "", boundary: "",
      sourceUrls: ["https://example.com/install"], snapshots: [{ url: "https://example.com/install", excerpt,
        capturedAt: now, sha256: createHash("sha256").update(`${excerpt}网页后续内容`).digest("hex") }] }
  }] });
  return { database, db, sourceId: saved.sources[0].id, links: new ArticleResearchLinkRepository(db) };
}

describe("ArticleResearchLinkRepository", () => {
  it("backs up a v11 file database before upgrading it to v12", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-research-links-"));
    try {
      const first = openDatabase(directory);
      first.connection.prepare("INSERT INTO workspaces (id, display_name, created_at) VALUES ('w', '测试', '2026-01-01T00:00:00Z')").run();
      first.connection.prepare("INSERT INTO content_projects (id, workspace_id, topic, created_at, updated_at) VALUES ('p', 'w', '保留正文', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
      first.connection.exec(`DROP TABLE article_draft_candidates; DROP TABLE article_research_links; DELETE FROM schema_migrations WHERE version IN (${ARTICLE_RESEARCH_LINK_MIGRATION_VERSION}, ${ARTICLE_DRAFT_CANDIDATE_MIGRATION_VERSION})`);
      first.close();

      const upgraded = openDatabase(directory);
      expect(upgraded.connection.prepare("SELECT topic FROM content_projects WHERE id = 'p'").get()).toEqual({ topic: "保留正文" });
      expect(upgraded.connection.pragma("foreign_key_check")).toEqual([]);
      upgraded.close();
      const backups = fs.readdirSync(path.join(directory, "backups"));
      expect(backups).toHaveLength(1);
      const backup = new Database(path.join(directory, "backups", backups[0]!));
      expect(backup.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(ARTICLE_RESEARCH_LINK_MIGRATION_VERSION)).toBeUndefined();
      expect(backup.prepare("SELECT topic FROM content_projects WHERE id = 'p'").get()).toEqual({ topic: "保留正文" });
      backup.close();
      const reopened = openDatabase(directory);
      expect(reopened.connection.prepare("SELECT name FROM sqlite_master WHERE name = 'article_research_links'").get())
        .toEqual({ name: "article_research_links" });
      reopened.close();
      expect(fs.readdirSync(path.join(directory, "backups"))).toHaveLength(1);
    } finally {
      const resolved = fs.realpathSync(directory);
      if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith("contentferry-research-links-")) {
        throw new Error("Refusing to remove an unexpected test directory.");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  it("does not record a migration version when its schema transaction fails", () => {
    const database = openInMemoryDatabase();
    try {
      const db = database.connection;
      db.exec(`DROP TABLE article_research_links; DELETE FROM schema_migrations WHERE version = ${ARTICLE_RESEARCH_LINK_MIGRATION_VERSION}`);
      db.exec("CREATE TABLE article_research_links (broken TEXT)");
      expect(() => initialiseDatabase(db)).toThrow();
      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(ARTICLE_RESEARCH_LINK_MIGRATION_VERSION)).toBeUndefined();
    } finally { database.close(); }
  });

  it("migrates an older database without changing its research card and survives repeat startup", () => {
    const { database, db, sourceId } = fixture();
    try {
      db.exec(`DROP TABLE article_research_links; DELETE FROM schema_migrations WHERE version = ${ARTICLE_RESEARCH_LINK_MIGRATION_VERSION}`);
      initialiseDatabase(db);
      initialiseDatabase(db);
      expect(db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(ARTICLE_RESEARCH_LINK_MIGRATION_VERSION)).toBeTruthy();
      expect(db.prepare("SELECT id FROM content_research_sources WHERE id = ?").get(sourceId)).toBeTruthy();
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { database.close(); }
  });

  it("retains a checked claim link separately from adoption and invalidates it after editing", () => {
    const { database, sourceId, links } = fixture();
    try {
      const association = { sourceId, claimText: claim, supportingExcerpt: excerpt.slice(0, 20) };
      expect(links.saveCandidateLinks("p", markdown, [association])).toEqual({ saved: 1, rejected: 0 });
      expect(links.saveCandidateLinks("p", markdown, [association])).toEqual({ saved: 0, rejected: 0 });
      const link = links.list("p", markdown)[0];
      expect(link.status).toBe("pending_author");
      const edited = markdown.replace("确认命令", "核实安装入口");
      expect(links.list("p", edited)[0].status).toBe("needs_recheck");
      expect(links.decide("p", link.id, edited, "confirmed").status).toBe("confirmed");
      expect(links.list("p", edited)[0].status).toBe("confirmed");
      expect(links.list("p", edited.replace(claim, "删除这处事实"))).toHaveLength(0);
    } finally { database.close(); }
  });

  it("retains an author's rejected-source decision for the matching draft claim", () => {
    const { database, sourceId, links } = fixture();
    try {
      links.saveCandidateLinks("p", markdown, [{ sourceId, claimText: claim, supportingExcerpt: excerpt.slice(0, 20) }]);
      const link = links.list("p", markdown)[0];
      expect(links.decide("p", link.id, markdown, "rejected").status).toBe("rejected");
      expect(links.list("p", markdown)[0].status).toBe("rejected");
      expect(links.list("p", markdown.replace(claim, "删去未证实内容"))).toHaveLength(0);
    } finally { database.close(); }
  });

  it("rejects unsupported quotes and unverified snapshots", () => {
    const { database, db, sourceId, links } = fixture();
    try {
      expect(links.saveCandidateLinks("p", markdown, [{ sourceId, claimText: claim, supportingExcerpt: "网页没有写到的结论" }]))
        .toEqual({ saved: 0, rejected: 1 });
      db.prepare("UPDATE content_research_sources SET evidence_json = ? WHERE id = ?")
        .run(JSON.stringify({ kind: "official", snapshots: [{ url: "https://example.com/install", excerpt, sha256: "invalid" }] }), sourceId);
      expect(links.saveCandidateLinks("p", markdown, [{ sourceId, claimText: claim, supportingExcerpt: excerpt.slice(0, 20) }]))
        .toEqual({ saved: 0, rejected: 1 });
      db.prepare("UPDATE content_research_sources SET evidence_json = ? WHERE id = ?")
        .run(JSON.stringify({ kind: "manual", snapshots: [{ url: "https://example.com/install", excerpt, sha256: "a".repeat(64) }] }), sourceId);
      expect(links.saveCandidateLinks("p", markdown, [{ sourceId, claimText: claim, supportingExcerpt: excerpt.slice(0, 20) }]))
        .toEqual({ saved: 0, rejected: 1 });
    } finally { database.close(); }
  });

  it("does not reconfirm a link after its captured source fingerprint changes", () => {
    const { database, db, sourceId, links } = fixture();
    try {
      links.saveCandidateLinks("p", markdown, [{ sourceId, claimText: claim, supportingExcerpt: excerpt.slice(0, 20) }]);
      const link = links.list("p", markdown)[0];
      db.prepare("UPDATE content_research_sources SET evidence_json = ? WHERE id = ?")
        .run(JSON.stringify({ kind: "official", snapshots: [{ url: "https://example.com/install", excerpt, sha256: "b".repeat(64) }] }), sourceId);
      expect(links.list("p", markdown)[0].status).toBe("needs_recheck");
      expect(() => links.decide("p", link.id, markdown, "confirmed")).toThrow("无法直接确认");
    } finally { database.close(); }
  });
});

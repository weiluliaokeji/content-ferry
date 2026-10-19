import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase, type AppDatabase } from "./database";

const fixtureSql = fs.readFileSync(path.resolve("scripts/fixtures/rollback-v12.sql"), "utf8");
function hash(file: string): string { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function schema(db: Database.Database): number {
  return (db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version;
}
function legacyRows(db: Database.Database): unknown[] {
  return db.prepare("SELECT id, project_id, status, checkpoint_json FROM article_draft_runs ORDER BY id").all();
}
function fixture(): { root: string; data: string; db: Database.Database } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-rollback-drill-"));
  const data = path.join(root, "live");
  fs.mkdirSync(data);
  const db = new Database(path.join(data, "contentferry.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.pragma("foreign_keys = ON");
  db.exec(fixtureSql);
  // Leave a committed record in WAL while a second connection opens the upgrade.
  db.prepare("UPDATE article_draft_runs SET checkpoint_json = ? WHERE id = ?").run('{"fixtureWal":true}', "fixture-run");
  return { root, data, db };
}
function cleanup(root: string): void {
  const absolute = fs.realpathSync(root);
  if (path.dirname(absolute) !== fs.realpathSync(os.tmpdir()) || !path.basename(absolute).startsWith("contentferry-rollback-drill-")) throw new Error("拒绝删除非演练目录。");
  fs.rmSync(absolute, { recursive: true, force: true });
}

describe("isolated data upgrade and rollback rehearsal", () => {
  it("upgrades v12, preserves post-upgrade work, and restores the WAL-consistent v12 backup into a fresh directory", async () => {
    const { root, data, db: oldConnection } = fixture();
    let upgraded: AppDatabase | undefined;
    const handles: Database.Database[] = [];
    try {
      const beforeRows = legacyRows(oldConnection);
      const library = path.join(root, "library");
      fs.mkdirSync(library);
      const article = path.join(library, "fixture.md");
      fs.writeFileSync(article, "# Fixture before upgrade\n");
      const originalArticle = path.join(root, "before-article.md");
      fs.copyFileSync(article, originalArticle);

      upgraded = openDatabase(data); // Real production migration and VACUUM INTO backup.
      expect(schema(upgraded.connection)).toBeGreaterThan(12);
      expect(legacyRows(upgraded.connection)).toEqual(beforeRows);
      expect(upgraded.connection.pragma("foreign_key_check")).toEqual([]);
      const backupNames = fs.readdirSync(path.join(data, "backups")).filter((name) => name.endsWith(".db"));
      expect(backupNames).toHaveLength(1);
      const backupPath = path.join(data, "backups", backupNames[0]!);
      const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
      handles.push(backup);
      expect(schema(backup)).toBe(12);
      expect(legacyRows(backup)).toEqual(beforeRows); // Includes the WAL-only checkpoint.
      expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");

      upgraded.connection.prepare("UPDATE content_projects SET topic = ? WHERE id = ?").run("Post-upgrade work", "fixture-project");
      fs.writeFileSync(article, "# Fixture after upgrade\n");
      const retained = path.join(root, "retained-upgraded");
      fs.mkdirSync(retained);
      await upgraded.connection.backup(path.join(retained, "contentferry.db"));
      fs.copyFileSync(article, path.join(retained, "fixture.md"));
      const upgradedVersion = schema(upgraded.connection);
      upgraded.close(); upgraded = undefined; oldConnection.close();

      const restored = path.join(root, "restored-v12");
      fs.mkdirSync(restored); // Never overwrite the upgraded directory or a real profile.
      fs.copyFileSync(backupPath, path.join(restored, "contentferry.db"));
      fs.copyFileSync(originalArticle, path.join(restored, "fixture.md"));
      const restoredDb = new Database(path.join(restored, "contentferry.db"), { readonly: true, fileMustExist: true });
      handles.push(restoredDb);
      expect(schema(restoredDb)).toBe(12);
      expect(legacyRows(restoredDb)).toEqual(beforeRows);
      expect(restoredDb.pragma("foreign_key_check")).toEqual([]);
      expect(restoredDb.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(restoredDb.prepare("SELECT name FROM sqlite_master WHERE name = 'article_draft_candidates'").get()).toBeUndefined();
      expect(hash(path.join(restored, "fixture.md"))).toBe(hash(originalArticle));
      const retainedDb = new Database(path.join(retained, "contentferry.db"), { readonly: true, fileMustExist: true });
      handles.push(retainedDb);
      expect(retainedDb.prepare("SELECT topic FROM content_projects WHERE id = ?").get("fixture-project")).toEqual({ topic: "Post-upgrade work" });
      expect(hash(path.join(retained, "fixture.md"))).toBe(hash(article));

      const reports = path.resolve(".cache/rollback-rehearsal");
      fs.mkdirSync(reports, { recursive: true });
      const report = { status: "passed", fixture: "synthetic-v12", restoredSchema: 12, upgradedSchema: upgradedVersion,
        walRecordPreserved: true, postUpgradeWorkRetainedSeparately: true, postUpgradeWorkAutomaticallyMerged: false,
        restoredArticleSha256: hash(originalArticle), oldExecutableVerified: false, realUserDataTouched: false };
      const reportPath = path.resolve(process.env.CONTENTFERRY_ROLLBACK_REPORT ?? path.join(reports, `${randomUUID()}.json`));
      const cacheRoot = path.resolve(".cache");
      if (!reportPath.startsWith(`${cacheRoot}${path.sep}`)) throw new Error("演练报告只允许写入本仓库 .cache。");
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: "wx" });
      console.log(`Rollback data rehearsal report: ${reportPath}`);
    } finally {
      for (const handle of handles) if (handle.open) handle.close();
      upgraded?.close(); if (oldConnection.open) oldConnection.close(); cleanup(root);
    }
  });

  it("keeps a usable pre-migration backup when an upgrade fails", () => {
    const { root, data, db } = fixture();
    try {
      db.exec("CREATE TABLE article_draft_candidates (conflicting_fixture_column TEXT)");
      const before = legacyRows(db);
      expect(() => openDatabase(data)).toThrow();
      expect(schema(db)).toBe(12);
      const backupPath = path.join(data, "backups", fs.readdirSync(path.join(data, "backups"))[0]!);
      const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
      try { expect(schema(backup)).toBe(12); expect(legacyRows(backup)).toEqual(before); }
      finally { backup.close(); }
    } finally { db.close(); cleanup(root); }
  });
});

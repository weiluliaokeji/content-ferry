import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openInMemoryDatabase } from "../db/database";
import { PublishTaskModule, type PublishTaskAdapter } from "./publish-task-module";

function seedTask(module: PublishTaskModule, db: Database.Database, status: "queued" | "preparing" = "queued", platform = "cnblogs"): void {
  db.exec("INSERT INTO workspaces (id, display_name, created_at) VALUES ('workspace-1', '测试', '2026-01-01')");
  db.exec("INSERT INTO media_accounts (id, workspace_id, platform, display_name, created_at) VALUES ('account-1', 'workspace-1', 'cnblogs', '账号', '2026-01-01')");
  db.exec("INSERT INTO channel_drafts (id, workspace_id, account_id, source_relative_path, source_hash, title, markdown, status, created_at, updated_at) VALUES ('draft-1', 'workspace-1', 'account-1', 'posts/a/index.md', 'hash', '标题', '# 标题', 'approved', '2026-01-01', '2026-01-01')");
  module.create({
    id: "job-1",
    platform,
    workspaceId: "workspace-1",
    accountId: "account-1",
    channelDraftId: "draft-1",
    renderedPackageHash: "snapshot-1",
    idempotencyKey: "cnblogs:job-1",
    status
  });
}

describe("PublishTaskModule", () => {
  it("persists first and lets the runner prepare an auto-running adapter", async () => {
    const app = openInMemoryDatabase();
    const module = new PublishTaskModule(app.connection);
    let prepareCalls = 0;
    const adapter: PublishTaskAdapter = {
      platform: "cnblogs",
      autoPrepare: true,
      prepare: async () => {
        prepareCalls += 1;
        return { outcome: "confirmed", completedPhase: "prepare", remoteContentId: "remote-1" };
      },
      reconcile: async () => ({ outcome: "uncertain" })
    };
    module.registerAdapter(adapter);
    seedTask(module, app.connection);

    expect(module.get("job-1")?.status).toBe("queued");
    module.scheduleAutoPreparation("job-1");
    await module.prepare("job-1");

    expect(prepareCalls).toBe(1);
    expect(module.get("job-1")).toMatchObject({ status: "ready", remoteContentId: "remote-1" });
    expect((app.connection.prepare("SELECT COUNT(*) AS count FROM publish_lifecycle_events WHERE job_id = ?").get("job-1") as { count: number }).count).toBe(3);
    await module.stop();
    app.close();
  });

  it("reconciles work left in an uncertain phase after restart", async () => {
    const app = openInMemoryDatabase();
    const module = new PublishTaskModule(app.connection);
    let reconcileCalls = 0;
    module.registerAdapter({
      platform: "cnblogs",
      autoPrepare: true,
      prepare: async () => ({ outcome: "confirmed" }),
      reconcile: async () => {
        reconcileCalls += 1;
        return { outcome: "uncertain", statusNote: "等待人工核对" };
      }
    });
    seedTask(module, app.connection, "preparing");

    const result = await module.recover();

    expect(result).toEqual({ scheduled: 0, reconciled: 1 });
    expect(reconcileCalls).toBe(1);
    expect(module.get("job-1")?.status).toBe("needs_manual_reconciliation");
    await module.stop();
    app.close();
  });

  it("does not automatically prepare a user-driven adapter", async () => {
    const app = openInMemoryDatabase();
    const module = new PublishTaskModule(app.connection);
    let prepareCalls = 0;
    module.registerAdapter({
      platform: "csdn",
      autoPrepare: false,
      prepare: async () => {
        prepareCalls += 1;
        return { outcome: "confirmed" };
      },
      reconcile: async () => ({ outcome: "uncertain" })
    });
    seedTask(module, app.connection, "queued", "csdn");

    module.scheduleAutoPreparation("job-1");
    await Promise.resolve();

    expect(prepareCalls).toBe(0);
    expect(module.get("job-1")?.status).toBe("queued");
    await module.stop();
    app.close();
  });
});

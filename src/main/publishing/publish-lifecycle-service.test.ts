import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../db/database";
import { PublishLifecycleService } from "./publish-lifecycle-service";

describe("PublishLifecycleService", () => {
  it("persists canonical transitions and events", () => {
    const app = openInMemoryDatabase();
    const db = app.connection;
    db.exec("INSERT INTO workspaces (id, display_name, created_at) VALUES ('w', '测试', '2026-01-01')");
    db.exec("INSERT INTO media_accounts (id, workspace_id, platform, display_name, created_at) VALUES ('a', 'w', 'csdn', '账号', '2026-01-01')");
    db.exec("INSERT INTO channel_drafts (id, workspace_id, account_id, source_relative_path, source_hash, title, markdown, status, created_at, updated_at) VALUES ('d', 'w', 'a', 'posts/a/index.md', 'h', '标题', '# 标题', 'approved', '2026-01-01', '2026-01-01')");
    const service = new PublishLifecycleService(db);
    service.create({ id: "j", platform: "csdn", workspaceId: "w", accountId: "a", channelDraftId: "d", renderedPackageHash: "h", idempotencyKey: "k", status: "queued" });
    const updated = service.transition("j", "preparing", { statusNote: "准备中" }, "开始准备");
    expect(updated.status).toBe("preparing");
    expect((db.prepare("SELECT COUNT(*) AS count FROM publish_lifecycle_events WHERE job_id = 'j'").get() as { count: number }).count).toBe(2);
    app.close();
  });

  it("does not overwrite an existing canonical state during legacy backfill", () => {
    const app = openInMemoryDatabase();
    const db = app.connection;
    db.exec("INSERT INTO workspaces (id, display_name, created_at) VALUES ('w', '测试', '2026-01-01')");
    db.exec("INSERT INTO media_accounts (id, workspace_id, platform, display_name, created_at) VALUES ('a', 'w', 'csdn', '账号', '2026-01-01')");
    db.exec("INSERT INTO channel_drafts (id, workspace_id, account_id, source_relative_path, source_hash, title, markdown, status, created_at, updated_at) VALUES ('d', 'w', 'a', 'posts/a/index.md', 'h', '标题', '# 标题', 'approved', '2026-01-01', '2026-01-01')");
    const service = new PublishLifecycleService(db);
    service.create({ id: "j", platform: "csdn", workspaceId: "w", accountId: "a", channelDraftId: "d", renderedPackageHash: "h", idempotencyKey: "k", status: "published" });
    expect(service.ensure({ id: "j", platform: "csdn", workspaceId: "w", accountId: "a", channelDraftId: "d", renderedPackageHash: "old", idempotencyKey: "old", status: "failed" }).status).toBe("published");
    app.close();
  });
});

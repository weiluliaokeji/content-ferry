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
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_publish_lifecycle_jobs_snapshot'").get()).toEqual({ name: "idx_publish_lifecycle_jobs_snapshot" });
    service.create({ id: "j", platform: "csdn", workspaceId: "w", accountId: "a", channelDraftId: "d", renderedPackageHash: "h", idempotencyKey: "k", status: "queued" });
    const updated = service.transition("j", "preparing", { statusNote: "准备中" }, "开始准备");
    expect(updated.status).toBe("preparing");
    expect((db.prepare("SELECT COUNT(*) AS count FROM publish_lifecycle_events WHERE job_id = 'j'").get() as { count: number }).count).toBe(2);
    app.close();
  });

  it("lists lifecycle events newest first with canonical statuses", () => {
    const app = openInMemoryDatabase();
    const db = app.connection;
    db.exec("INSERT INTO workspaces (id, display_name, created_at) VALUES ('w', '测试', '2026-01-01')");
    db.exec("INSERT INTO media_accounts (id, workspace_id, platform, display_name, created_at) VALUES ('a', 'w', 'cnblogs', '账号', '2026-01-01')");
    db.exec("INSERT INTO channel_drafts (id, workspace_id, account_id, source_relative_path, source_hash, title, markdown, status, created_at, updated_at) VALUES ('d', 'w', 'a', 'posts/a/index.md', 'h', '标题', '# 标题', 'approved', '2026-01-01', '2026-01-01')");
    const service = new PublishLifecycleService(db);
    service.create({ id: "j", platform: "cnblogs", workspaceId: "w", accountId: "a", channelDraftId: "d", renderedPackageHash: "h", idempotencyKey: "k", status: "queued" });
    service.transition("j", "preparing", { statusNote: "准备中" }, "开始准备");
    service.transition("j", "ready", { statusNote: "草稿已就绪" }, "准备完成");

    expect(service.listEvents("j")).toMatchObject([
      { previousStatus: "preparing", newStatus: "ready", source: "system", reason: "准备完成" },
      { previousStatus: "queued", newStatus: "preparing", source: "system", reason: "开始准备" },
      { previousStatus: "", newStatus: "queued", source: "system" }
    ]);
    expect(service.listEvents("j", 2)).toHaveLength(2);
    expect(() => service.listEvents("missing")).toThrow();
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

  it("clears nullable fields when a transition explicitly passes null", () => {
    const app = openInMemoryDatabase();
    const db = app.connection;
    db.exec("INSERT INTO workspaces (id, display_name, created_at) VALUES ('w', '娴嬭瘯', '2026-01-01')");
    db.exec("INSERT INTO media_accounts (id, workspace_id, platform, display_name, created_at) VALUES ('a', 'w', 'cnblogs', '璐﹀彿', '2026-01-01')");
    db.exec("INSERT INTO channel_drafts (id, workspace_id, account_id, source_relative_path, source_hash, title, markdown, status, created_at, updated_at) VALUES ('d', 'w', 'a', 'posts/a/index.md', 'h', '鏍囬', '# 鏍囬', 'approved', '2026-01-01', '2026-01-01')");
    const service = new PublishLifecycleService(db);
    service.create({
      id: "j",
      platform: "cnblogs",
      workspaceId: "w",
      accountId: "a",
      channelDraftId: "d",
      renderedPackageHash: "h",
      idempotencyKey: "k",
      status: "failed",
      statusNote: "澶辫触",
      errorMessage: "old error",
      remoteUrl: "https://example.invalid/old",
      remoteContentId: "old"
    });

    const updated = service.transition("j", "ready", {
      statusNote: "ready",
      errorMessage: null,
      remoteUrl: null,
      remoteContentId: null
    }, "retry succeeded");

    expect(updated).toMatchObject({
      status: "ready",
      statusNote: "ready",
      errorMessage: null,
      remoteUrl: null,
      remoteContentId: null
    });
    app.close();
  });

  it("reuses the active task for the same frozen snapshot even with a new idempotency key", () => {
    const app = openInMemoryDatabase();
    const db = app.connection;
    db.exec("INSERT INTO workspaces (id, display_name, created_at) VALUES ('w', '测试', '2026-01-01')");
    db.exec("INSERT INTO media_accounts (id, workspace_id, platform, display_name, created_at) VALUES ('a', 'w', 'cnblogs', '账号', '2026-01-01')");
    db.exec("INSERT INTO channel_drafts (id, workspace_id, account_id, source_relative_path, source_hash, title, markdown, status, created_at, updated_at) VALUES ('d', 'w', 'a', 'posts/a/index.md', 'h', '标题', '# 标题', 'approved', '2026-01-01', '2026-01-01')");
    const service = new PublishLifecycleService(db);
    const first = service.create({
      id: "j1", platform: "cnblogs", workspaceId: "w", accountId: "a", channelDraftId: "d",
      renderedPackageHash: "snapshot", idempotencyKey: "key-1", status: "failed"
    });

    const duplicate = service.create({
      id: "j2", platform: "cnblogs", workspaceId: "w", accountId: "a", channelDraftId: "d",
      renderedPackageHash: "snapshot", idempotencyKey: "key-2", status: "queued"
    });
    expect(duplicate.id).toBe(first.id);

    service.transition(first.id, "published", {}, "人工确认已发布");
    const newAttempt = service.create({
      id: "j3", platform: "cnblogs", workspaceId: "w", accountId: "a", channelDraftId: "d",
      renderedPackageHash: "snapshot", idempotencyKey: "key-3", status: "queued"
    });
    expect(newAttempt.id).toBe("j3");
    app.close();
  });
});

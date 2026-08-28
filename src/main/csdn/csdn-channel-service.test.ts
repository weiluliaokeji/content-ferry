import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountRepository } from "../accounts/account-repository";
import { ContentSourceService } from "../content/content-source-service";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import type { GenerateStructuredRequest, ModelProvider } from "../ai/model-provider";
import { CsdnChannelError, CsdnChannelService } from "./csdn-channel-service";

describe("CsdnChannelService", () => {
  let database: AppDatabase | undefined;
  let sourceDirectory: string | undefined;

  afterEach(() => {
    database?.close();
    if (sourceDirectory) fs.rmSync(sourceDirectory, { recursive: true, force: true });
    database = undefined;
    sourceDirectory = undefined;
  });

  it("creates an independent CSDN draft, freezes it, and creates one idempotent job", async () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-csdn-"));
    fs.mkdirSync(path.join(sourceDirectory, "posts", "source", "assets"), { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, "posts", "source", "index.md"), `---
title: 主稿标题
created: '2026-07-29 10:00:00'
tags: []
publish: false
---

# 主稿标题

这是一段可验证的正文。`, "utf8");
    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);
    const account = accounts.createAccount({ workspaceId: workspace.id, platform: "csdn", displayName: "测试 CSDN" });
    const provider: ModelProvider = {
      id: "test",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        expect(request.skillId).toBe("platform-rewrite");
        return {
          value: request.parse({ title: "适配后的 CSDN 标题", markdown: "# 适配后的 CSDN 标题\n\n适配后的独立正文。" }),
          provider: "test",
          model: "test-model",
          usage: null
        };
      },
      async webResearch() {
        throw new Error("not used");
      }
    };
    const service = new CsdnChannelService(database.connection, accounts, contentSources, provider);

    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "rewrite" });
    expect(draft).toMatchObject({ title: "适配后的 CSDN 标题", status: "draft" });
    expect(draft.markdown).toContain("# 适配后的 CSDN 标题");
    expect(draft.markdown).not.toContain("微信公众号");

    const sameDraft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "rewrite" });
    expect(sameDraft.id).toBe(draft.id);

    const approved = service.approveDraft(draft.id);
    expect(approved.status).toBe("approved");
    const job = service.createPublishJob(draft.id);
    expect(job).toMatchObject({ channelDraftId: draft.id, status: "queued" });
    expect(service.createPublishJob(draft.id).id).toBe(job.id);
    expect(service.capabilities(account.id)).toMatchObject({ canCreateRemoteDraft: true, canSubmitAfterConfirmation: true, supportsScheduledPublish: false });
  });

  it("does not reuse a job stuck in a terminal state; creates a fresh one instead", async () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-csdn-"));
    fs.mkdirSync(path.join(sourceDirectory, "posts", "source", "assets"), { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, "posts", "source", "index.md"), `---\ntitle: 主稿标题\n---\n\n# 主稿标题\n\n正文。`, "utf8");
    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);
    const account = accounts.createAccount({ workspaceId: workspace.id, platform: "csdn", displayName: "测试 CSDN" });
    const provider: ModelProvider = {
      id: "test",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        return { value: request.parse({ title: "适配后的 CSDN 标题", markdown: "# 适配后的 CSDN 标题\n\n正文。" }), provider: "test", usage: null };
      },
      async webResearch() { throw new Error("not used"); }
    };
    const service = new CsdnChannelService(database.connection, accounts, contentSources, provider);

    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md" });
    service.approveDraft(draft.id);
    const stuck = service.createPublishJob(draft.id);
    expect(stuck.status).toBe("queued");
    // 模拟上次提交超时后进入的终态：filling → 填充成功 → 提交中 → 无法读取回执 → 人工核对
    service.startBrowserAssist(stuck.id);
    service.recordFill(stuck.id, { verifiedFields: ["title", "content"], state: "ready_for_final_confirmation" });
    service.beginSubmit(stuck.id);
    service.recordSubmission(stuck.id, { remoteUrl: null, remoteContentId: null, state: "needs_manual_reconciliation" });
    expect(service.getJob(stuck.id).status).toBe("needs_manual_reconciliation");

    // 再次点击“发布到 CSDN”不应命中这个卡死的旧任务，而应新建一个 queued 任务，
    // 否则 startBrowserAssist 会抛“任务已结束”，浏览器永远打不开。
    const fresh = service.createPublishJob(draft.id);
    expect(fresh.id).not.toBe(stuck.id);
    expect(fresh.status).toBe("queued");
  });

  it("creates a CSDN channel draft directly from the source without calling a model", async () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-csdn-"));
    fs.mkdirSync(path.join(sourceDirectory, "posts", "source", "assets"), { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, "posts", "source", "index.md"), "---\ntitle: 直接使用的主稿\n---\n\n# 直接使用的主稿\n\n保留这段正文。", "utf8");
    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);
    const account = accounts.createAccount({ workspaceId: workspace.id, platform: "csdn", displayName: "测试 CSDN" });
    const provider: ModelProvider = {
      id: "test",
      async generateStructured() { throw new Error("直接使用主稿不应调用模型"); },
      async webResearch() { throw new Error("not used"); }
    };
    const service = new CsdnChannelService(database.connection, accounts, contentSources, provider);

    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });

    expect(draft).toMatchObject({ title: "直接使用的主稿", generationMode: "source", status: "draft" });
    expect(draft.markdown).toBe("# 直接使用的主稿\n\n保留这段正文。");
  });

  it("rejects a generated CSDN draft containing a WeChat soft-promotion link", async () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-csdn-"));
    fs.mkdirSync(path.join(sourceDirectory, "posts", "source", "assets"), { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, "posts", "source", "index.md"), "---\ntitle: 主稿\n---\n\n# 主稿\n\n正文", "utf8");
    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);
    const account = accounts.createAccount({ workspaceId: workspace.id, platform: "csdn", displayName: "测试 CSDN" });
    const provider: ModelProvider = {
      id: "test",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        return {
          value: request.parse({ title: "标题", markdown: "# 标题\n\n[公众号原文](https://mp.weixin.qq.com/s/example)" }),
          provider: "test",
          model: "test-model",
          usage: null
        };
      },
      async webResearch() {
        throw new Error("not used");
      }
    };
    const service = new CsdnChannelService(database.connection, accounts, contentSources, provider);

    await expect(service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "rewrite" }))
      .rejects.toBeInstanceOf(CsdnChannelError);
  });

  it("drives the publish job state machine from queued to published and rejects illegal transitions", async () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-csdn-"));
    fs.mkdirSync(path.join(sourceDirectory, "posts", "source", "assets"), { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, "posts", "source", "index.md"), "---\ntitle: 主稿\n---\n\n# 主稿\n\n正文", "utf8");
    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);
    const account = accounts.createAccount({ workspaceId: workspace.id, platform: "csdn", displayName: "测试 CSDN" });
    const provider: ModelProvider = {
      id: "test",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        return { value: request.parse({ title: "标题", markdown: "# 标题\n\n正文" }), provider: "test", model: "test-model", usage: null };
      },
      async webResearch() { throw new Error("not used"); }
    };
    const service = new CsdnChannelService(database.connection, accounts, contentSources, provider);
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);
    expect(job.status).toBe("queued");

    // 浏览器辅助只能从可重启状态进入 filling。
    const filling = service.startBrowserAssist(job.id);
    expect(filling.status).toBe("filling");

    // 未登录回写。
    const needsLogin = service.recordNeedsLogin(job.id, "未登录");
    expect(needsLogin.status).toBe("needs_login");

    // 重新进入浏览器辅助。
    const fillingAgain = service.startBrowserAssist(job.id);
    expect(fillingAgain.status).toBe("filling");

    // 填充成功 → 等待最终确认。
    const ready = service.recordFill(job.id, { verifiedFields: ["title", "content"], state: "ready_for_final_confirmation" });
    expect(ready.status).toBe("ready_for_final_confirmation");

    // 最终确认（用户点击“我已在 CSDN 发布”）→ 提交中。
    const submitting = service.beginSubmit(job.id);
    expect(submitting.status).toBe("submitting");

    // 读到回执 → 已发布，并回写链接。
    const published = service.recordSubmission(job.id, { remoteUrl: "https://blog.csdn.net/abc/article/details/123456", remoteContentId: "123456", state: "published" });
    expect(published.status).toBe("published");
    expect(published.remoteUrl).toBe("https://blog.csdn.net/abc/article/details/123456");
    expect(published.remoteContentId).toBe("123456");

    // 已发布任务不可再进入浏览器辅助（同步方法，直接抛错）。
    expect(() => service.startBrowserAssist(job.id)).toThrow(CsdnChannelError);
  });

  it("falls back to manual reconciliation and supports correction when the receipt cannot be read", async () => {
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-csdn-"));
    fs.mkdirSync(path.join(sourceDirectory, "posts", "source", "assets"), { recursive: true });
    fs.writeFileSync(path.join(sourceDirectory, "posts", "source", "index.md"), "---\ntitle: 主稿\n---\n\n# 主稿\n\n正文", "utf8");
    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);
    const account = accounts.createAccount({ workspaceId: workspace.id, platform: "csdn", displayName: "测试 CSDN" });
    const provider: ModelProvider = {
      id: "test",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        return { value: request.parse({ title: "标题", markdown: "# 标题\n\n正文" }), provider: "test", model: "test-model", usage: null };
      },
      async webResearch() { throw new Error("not used"); }
    };
    const service = new CsdnChannelService(database.connection, accounts, contentSources, provider);
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md" });
    const job = service.createPublishJob(service.approveDraft(draft.id).id);

    service.startBrowserAssist(job.id);
    service.recordFill(job.id, { verifiedFields: ["title"], state: "needs_user", reason: "摘要未填充" });
    service.beginSubmit(job.id);
    const reconciled = service.recordSubmission(job.id, { remoteUrl: null, remoteContentId: null, state: "needs_manual_reconciliation", reason: "读不到链接" });
    expect(reconciled.status).toBe("needs_manual_reconciliation");

    // 人工校正为已发布。
    const corrected = service.correctStatus(job.id, "published", "在 CSDN 后台确认已发布");
    expect(corrected.status).toBe("published");
    const sourceRow = database!.connection.prepare("SELECT status_source FROM csdn_publish_jobs WHERE id = ?").get(job.id) as { status_source: string };
    expect(sourceRow.status_source).toBe("manual");

    // 已结束任务不可再次校正为失败（同步方法，直接抛错）。
    expect(() => service.correctStatus(job.id, "failed", "x")).toThrow(CsdnChannelError);
  });
});

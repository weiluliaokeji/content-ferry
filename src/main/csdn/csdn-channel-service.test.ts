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

    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md" });
    expect(draft).toMatchObject({ title: "适配后的 CSDN 标题", status: "draft" });
    expect(draft.markdown).toContain("# 适配后的 CSDN 标题");
    expect(draft.markdown).not.toContain("微信公众号");

    const sameDraft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md" });
    expect(sameDraft.id).toBe(draft.id);

    const approved = service.approveDraft(draft.id);
    expect(approved.status).toBe("approved");
    const job = service.createPublishJob(draft.id);
    expect(job).toMatchObject({ channelDraftId: draft.id, status: "queued" });
    expect(service.createPublishJob(draft.id).id).toBe(job.id);
    expect(service.capabilities(account.id)).toMatchObject({ canSubmitAfterConfirmation: false, supportsScheduledPublish: false });
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

    await expect(service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md" }))
      .rejects.toBeInstanceOf(CsdnChannelError);
  });
});

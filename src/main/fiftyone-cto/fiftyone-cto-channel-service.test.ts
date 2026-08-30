import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountRepository } from "../accounts/account-repository";
import type { ModelProvider } from "../ai/model-provider";
import { ContentSourceService } from "../content/content-source-service";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import type { CredentialVault } from "../security/credential-vault";
import { FiftyoneCtoChannelService, type FiftyoneCtoPublishJob } from "./fiftyone-cto-channel-service";
import { CTOClient } from "./fiftyone-cto-client";

const testVault: CredentialVault = {
  encrypt: (value) => Buffer.from(`encrypted:${value}`),
  decrypt: (value) => value.toString().replace("encrypted:", "")
};

interface PublishCall {
  url: string;
  method: string;
  body?: string;
}

function createFiftyoneCtoFetcher(publishBlogId = "999999"): { fetcher: typeof fetch; calls: PublishCall[] } {
  const calls: PublishCall[] = [];
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = init?.method ?? "GET";
    const body = init?.body !== undefined ? String(init.body) : undefined;
    calls.push({ url, method, body });
    if (url.includes("old=1")) {
      // 发布页：返回包含 CSRF token 的 HTML。
      return new Response(
        '<html><head><meta name="csrf-token" content="TOKEN123"></head>' +
        "<body><script>pid: '176'</script><script>cate_id: '200'</script></body></html>",
        { status: 200, headers: { "content-type": "text/html" } }
      );
    }
    // 发布接口：返回成功 JSON。
    return new Response(JSON.stringify({ status: 1, data: { blog_id: publishBlogId } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

async function waitForJob(
  service: FiftyoneCtoChannelService,
  jobId: string,
  status: string,
  timeoutMs = 4000
): Promise<FiftyoneCtoPublishJob> {
  const deadline = Date.now() + timeoutMs;
  let last = service.getJob(jobId);
  while (Date.now() < deadline) {
    last = service.getJob(jobId);
    if (last.status === status) return last;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待 ${status} 超时；当前 ${last.status}；note=${last.statusNote}；error=${last.errorMessage}`);
}

describe("FiftyoneCtoChannelService", () => {
  let database: AppDatabase | undefined;
  let sourceDirectory: string | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    database?.close();
    if (sourceDirectory) {
      try { fs.rmSync(sourceDirectory, { recursive: true, force: true }); }
      catch { /* ignore */ }
    }
    database = undefined;
    sourceDirectory = undefined;
  });

  function setupHarness(withCookie = true) {
    const { fetcher, calls } = createFiftyoneCtoFetcher();
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-51cto-svc-"));
    const articleDirectory = path.join(sourceDirectory, "posts", "source");
    fs.mkdirSync(path.join(articleDirectory, "assets"), { recursive: true });
    fs.writeFileSync(path.join(articleDirectory, "index.md"), [
      "---",
      "title: 主稿标题",
      "created: '2026-08-01 10:00:00'",
      "tags: []",
      "publish: false",
      "---",
      "",
      "# 主稿标题",
      "",
      "主稿正文内容。"
    ].join("\n"), "utf8");
    const contentSources = new ContentSourceService(database.connection);
    contentSources.setSource(workspace.id, sourceDirectory);
    const account = accounts.createAccount({
      workspaceId: workspace.id,
      platform: "51cto",
      displayName: "51CTO 测试号",
      externalAccountId: "51cto-test"
    });
    if (withCookie) {
      accounts.saveCredential(account.id, "fiftyone_cto_cookie", "sess=abc123", testVault);
    }
    const provider = {
      generateStructured: async () => ({
        value: { title: "适配后的标题", markdown: "# 适配后的标题\n\n适配后的独立正文。" }
      })
    } as unknown as ModelProvider;
    const service = new FiftyoneCtoChannelService(database.connection, accounts, testVault, contentSources, provider, undefined, fetcher);
    return { database, accounts, workspace, sourceDirectory, contentSources, account, provider, service, calls };
  }

  it("creates a channel draft, saves edits and freezes it for publishing", async () => {
    const { account, service } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });

    expect(draft.title).toBe("主稿标题");
    expect(draft.status).toBe("draft");
    expect(draft.accountId).toBe(account.id);

    const saved = service.saveDraft(draft.id, {
      title: "改写后的标题",
      markdown: "# 改写后的标题\n\n改写后的正文。",
      author: "文渡",
      digest: "一句摘要",
      coverSource: "./assets/cover.png"
    });
    expect(saved.title).toBe("改写后的标题");
    expect(saved.markdown).toContain("改写后的正文");
    expect(saved.author).toBe("文渡");
    expect(saved.digest).toBe("一句摘要");
    expect(saved.coverSource).toBe("./assets/cover.png");

    const approved = service.approveDraft(saved.id);
    expect(approved.status).toBe("approved");
  });

  it("rejects drafts containing WeChat promotion", async () => {
    const { account, service } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    expect(() => service.saveDraft(draft.id, {
      title: "违规标题",
      markdown: "# 违规标题\n\n关注公众号获取更多。"
    })).toThrow(/公众号引流/);
  });

  it("single-shot publish creates a job then reaches published with remote URL", async () => {
    const { account, service, calls } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);

    const job = service.createPublishJob(approved.id);
    expect(job.status).toBe("draft_creating");

    const published = await waitForJob(service, job.id, "published");
    expect(published.remoteUrl).toBe(`https://blog.51cto.com/${"999999"}`);
    expect(published.remoteContentId).toBe("999999");
    expect(published.errorMessage).toBeNull();

    // 单步发布：先抓发布页（CSRF），再 POST 发布接口。
    const pageCalls = calls.filter((call) => call.url.includes("old=1"));
    const publishCalls = calls.filter((call) => call.url === CTOClient.PUBLISH_URL);
    expect(pageCalls).toHaveLength(1);
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].method).toBe("POST");
  });

  it("falls back to needs_credentials when the 51CTO cookie is missing", async () => {
    const { account, service } = setupHarness(false);
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);

    const job = service.createPublishJob(approved.id);
    const settled = await waitForJob(service, job.id, "needs_credentials");
    expect(settled.statusNote).toContain("Cookie");
    expect(settled.errorMessage).toContain("Cookie");
  });

  it("uploads local images (falling back to inline) during single-shot publish", async () => {
    const { account, service, calls } = setupHarness();
    // 准备带本地图片的主稿与资源文件。
    const articleDir = path.join(sourceDirectory!, "posts", "source", "with-image");
    fs.mkdirSync(path.join(articleDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(articleDir, "index.md"), [
      "---",
      "title: 带图文章",
      "created: '2026-08-01 10:00:00'",
      "tags: []",
      "publish: false",
      "---",
      "",
      "# 带图文章",
      "",
      "![图](./assets/x.png)"
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(articleDir, "assets", "x.png"), Buffer.from("fake-png-bytes"), "utf8");

    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/with-image/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);
    const published = await waitForJob(service, job.id, "published");

    expect(published.remoteUrl).toBe(`https://blog.51cto.com/${"999999"}`);
    // 图床端点在本测试未真正配置，本地图片应回退为 base64 内联进入发布正文。
    const publishCall = calls.find((call) => call.url === CTOClient.PUBLISH_URL);
    expect(publishCall?.body).toBeDefined();
    expect(decodeURIComponent(publishCall!.body!)).toContain("data:image/png;base64,");
  });
});

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountRepository } from "../accounts/account-repository";
import type { ModelProvider } from "../ai/model-provider";
import { ContentSourceService } from "../content/content-source-service";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import type { CredentialVault } from "../security/credential-vault";
import { JuejinChannelService, type JuejinPublishJob } from "./juejin-channel-service";

const testVault: CredentialVault = {
  encrypt: (value) => Buffer.from(`encrypted:${value}`),
  decrypt: (value) => value.toString().replace("encrypted:", "")
};

interface ApiCall {
  endpoint: string;
  url: string;
  body: string;
}

function apiResponse(data: unknown, errNo = 0, errMsg = ""): Response {
  return new Response(JSON.stringify({ err_no: errNo, err_msg: errMsg, data }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function createApiFetcher(handlers: Record<string, (call: ApiCall) => Response | Error>): { fetcher: typeof fetch; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const fetcher = (async (input: unknown, init: RequestInit | undefined) => {
    const body = String(init?.body ?? "");
    const url = String(input);
    const endpoint = /\/content_api\/v1\/([^?]+)/.exec(url)?.[1] ?? "";
    const call = { endpoint, url, body };
    calls.push(call);
    const handler = handlers[endpoint];
    if (!handler) throw new Error(`Unexpected Juejin endpoint: ${endpoint}`);
    const result = handler(call);
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function defaultHandlers(overrides: Partial<Record<string, (call: ApiCall) => Response | Error>> = {}) {
  return {
    "article_draft/create": () => apiResponse({ id: "draft-123", article_id: "article-123" }),
    "article/publish": () => apiResponse({ article_id: "article-123", draft_id: "draft-123" }),
    "article_draft/detail": () => apiResponse({
      article_draft: {
        article_info: { article_id: "article-123", title: "标题", draft_id: "draft-123" }
      }
    }),
    "article/list_by_user": () => apiResponse([]),
    ...overrides
  };
}

async function waitForJob(
  service: JuejinChannelService,
  jobId: string,
  status: string,
  timeoutMs = 4000
): Promise<JuejinPublishJob> {
  const deadline = Date.now() + timeoutMs;
  let last = service.getJob(jobId);
  while (Date.now() < deadline) {
    last = service.getJob(jobId);
    if (last.status === status) return last;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待 ${status} 超时；当前 ${last.status}；note=${last.statusNote}；error=${last.errorMessage}`);
}

describe("JuejinChannelService", () => {
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

  function setupHarness(handlers: Record<string, (call: ApiCall) => Response | Error> = defaultHandlers()) {
    const { fetcher, calls } = createApiFetcher(handlers);
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-juejin-svc-"));
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
      platform: "juejin",
      displayName: "掘金测试号",
      externalAccountId: "juejin-user"
    });
    accounts.saveCredential(account.id, "juejin_cookie", "sessionid=abc; passport_csrf_token=xyz", testVault);
    accounts.saveCredential(account.id, "juejin_aid", "2608", testVault);
    accounts.saveCredential(account.id, "juejin_uuid", "uuid-123", testVault);
    const provider = {
      generateStructured: async () => ({
        value: { title: "适配后的标题", markdown: "# 适配后的标题\n\n适配后的独立正文。" }
      })
    } as unknown as ModelProvider;
    const service = new JuejinChannelService(database.connection, accounts, testVault, contentSources, provider, undefined, fetcher);
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
      digest: "一句摘要",
      coverSource: "https://example.com/cover.png"
    });
    expect(saved.title).toBe("改写后的标题");
    expect(saved.markdown).toContain("改写后的正文");
    expect(saved.digest).toBe("一句摘要");
    expect(saved.coverSource).toBe("https://example.com/cover.png");

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

  it("creates an idempotent publish job that reaches draft_created", async () => {
    const { account, service, calls } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);

    const first = service.createPublishJob(approved.id);
    expect(first.status).toBe("draft_creating");

    await waitForJob(service, first.id, "draft_created");

    // 同一渠道稿、同一内容再次创建任务：返回同一个任务（幂等）。
    const again = service.createPublishJob(approved.id);
    expect(again.id).toBe(first.id);

    const job = await waitForJob(service, first.id, "draft_created");
    expect(job.remoteContentId).toBe("draft-123");
    expect(job.remoteUrl).toContain("https://juejin.cn/editor/drafts?id=draft-123");
    expect(job.errorMessage).toBeNull();

    // 幂等：后台只调用了一次 article_draft/create（没有重复创建掘金草稿）。
    const creates = calls.filter((call) => call.endpoint === "article_draft/create");
    expect(creates).toHaveLength(1);
  });

  it("does not reuse a terminal job and generates a retry idempotency key", async () => {
    const { account, service, calls } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);

    const first = service.createPublishJob(approved.id);
    await waitForJob(service, first.id, "draft_created");
    await service.confirmPublish(first.id);
    const published = service.getJob(first.id);
    expect(published.status).toBe("published");

    // 已发布任务不再复用；新任务使用带 retry 后缀的幂等键重新走两段式。
    const retry = service.createPublishJob(approved.id);
    expect(retry.id).not.toBe(first.id);
    expect(retry.idempotencyKey).toContain(":retry:");
    const retryJob = await waitForJob(service, retry.id, "draft_created");
    expect(retryJob.id).not.toBe(first.id);
    expect(calls.filter((call) => call.endpoint === "article_draft/create")).toHaveLength(2);
  });

  it("enforces the UNIQUE constraint on idempotency_key at the database level", async () => {
    const { account, service, database: db } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);

    expect(() => {
      db.connection.prepare(`INSERT INTO juejin_publish_jobs
        (id, workspace_id, account_id, channel_draft_id, rendered_package_hash, idempotency_key, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'draft_creating', ?, ?)`)
        .run(randomUUID(), job.workspaceId, job.accountId, job.channelDraftId, job.renderedPackageHash,
          job.idempotencyKey, new Date().toISOString(), new Date().toISOString());
    }).toThrow(/UNIQUE/);
  });

  it("drives the full lifecycle draft_creating → draft_created → confirming → published", async () => {
    const { account, service, calls } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);
    await waitForJob(service, job.id, "draft_created");

    const confirming = await service.confirmPublish(job.id);
    expect(confirming.status).toBe("published");

    const published = service.getJob(job.id);
    expect(published.status).toBe("published");
    expect(published.remoteUrl).toBe("https://juejin.cn/post/article-123");
    expect(published.remoteContentId).toBe("draft-123");

    const endpoints = calls.map((call) => call.endpoint);
    expect(endpoints.indexOf("article_draft/create")).toBeLessThan(endpoints.indexOf("article/publish"));
  });

  it("sends the juejin draft payload with string category, string-array tags and external cover", async () => {
    const { account, service, calls } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const saved = service.saveDraft(draft.id, {
      title: "掘金分类测试",
      markdown: "# 掘金分类测试\n\n正文",
      digest: "掘金摘要"
    });
    const approved = service.approveDraft(saved.id);
    const job = service.createPublishJob(approved.id, {
      categoryId: "6809637771511070734", // 开发工具
      tagIds: ["7467857238494020000", "6809641073527226000"] // AI编程 / OpenAI
    });
    await waitForJob(service, job.id, "draft_created");

    const create = calls.find((call) => call.endpoint === "article_draft/create")!;
    const body = JSON.parse(create.body) as Record<string, unknown>;
    expect(body.title).toBe("掘金分类测试");
    // 掘金 title 已单独提交，正文不再重复携带首行 "# 标题"。
    expect(body.mark_content).not.toContain("掘金分类测试");
    expect(body.mark_content).toContain("正文");
    expect(body.brief_content).toBe("掘金摘要");
    expect(body.category_id).toBe("6809637771511070734");
    expect(body.tag_ids).toEqual(["7467857238494020000", "6809641073527226000"]);
    expect(body.cover_image).toBe("");
    expect(body.edit_type).toBe(10);
    expect(body.html_content).toBe("deprecated");
  });

  it("moves to needs_credentials when credentials are missing and recovers after configuration", async () => {
    const { account, service, accounts } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    // 重建一个未配置凭据的账号。
    const unconfigured = accounts.createAccount({
      workspaceId: approved.workspaceId,
      platform: "juejin",
      displayName: "未配置掘金"
    });
    const secondDraft = await service.createFromSource({ accountId: unconfigured.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const secondApproved = service.approveDraft(secondDraft.id);
    const job = service.createPublishJob(secondApproved.id);
    const blocked = await waitForJob(service, job.id, "needs_credentials");
    expect(blocked.errorMessage).toContain("尚未配置 Cookie");

    // 用户补上凭据后重新触发：同一任务恢复执行。
    accounts.saveCredential(unconfigured.id, "juejin_cookie", "sessionid=abc; passport_csrf_token=xyz", testVault);
    accounts.saveCredential(unconfigured.id, "juejin_aid", "2608", testVault);
    accounts.saveCredential(unconfigured.id, "juejin_uuid", "uuid-123", testVault);
    const retried = service.createPublishJob(secondApproved.id);
    expect(retried.id).toBe(job.id);
    await waitForJob(service, job.id, "draft_created");
  });

  it("moves to failed when the API rejects the draft creation (err_no != 0)", async () => {
    const { account, service } = setupHarness(defaultHandlers({
      "article_draft/create": () => apiResponse(null, 2, "参数错误")
    }));
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);
    const failed = await waitForJob(service, job.id, "failed");
    expect(failed.errorMessage).toContain("参数错误");
  });

  it("moves to failed on network errors and retries with the same job", async () => {
    let createFails = true;
    const { account, service, calls } = setupHarness(defaultHandlers({
      "article_draft/create": () => {
        if (createFails) throw new Error("ECONNREFUSED");
        return apiResponse({ id: "draft-456", article_id: "article-456" });
      }
    }));
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);

    const job = service.createPublishJob(approved.id);
    const failed = await waitForJob(service, job.id, "failed");
    expect(failed.errorMessage).toContain("ECONNREFUSED");

    // 网络恢复后重试：同一任务重新走草稿创建。
    createFails = false;
    const retried = service.createPublishJob(approved.id);
    expect(retried.id).toBe(job.id);
    await waitForJob(service, job.id, "draft_created");
    expect(calls.filter((call) => call.endpoint === "article_draft/create")).toHaveLength(2);
  });

  it("moves to needs_manual_reconciliation when publish fails after the draft exists", async () => {
    const { account, service, calls } = setupHarness(defaultHandlers({
      "article/publish": () => apiResponse(null, 500, "publish internal error")
    }));
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);
    await waitForJob(service, job.id, "draft_created");

    const result = await service.confirmPublish(job.id);
    expect(result.status).toBe("needs_manual_reconciliation");
    expect(result.statusNote).toContain("草稿已创建，但公开失败");
    expect(result.remoteContentId).toBe("draft-123"); // 草稿仍保留，可人工校正
    expect(calls.some((call) => call.endpoint === "article/publish")).toBe(true);
  });

  it("records a manual submission receipt for a reconciled publish", async () => {
    const { account, service } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);
    await waitForJob(service, job.id, "draft_created");

    const recorded = service.recordSubmission(job.id, {
      remoteUrl: "https://juejin.cn/post/article-999",
      remoteContentId: "draft-999",
      state: "published"
    });
    expect(recorded.status).toBe("published");
    expect(recorded.remoteUrl).toBe("https://juejin.cn/post/article-999");
    expect(recorded.statusNote).toContain("已发布");
  });

  it("supports manual correction that only updates the local record", async () => {
    const { account, service, calls } = setupHarness(defaultHandlers({
      "article/publish": () => apiResponse(null, 500, "publish internal error")
    }));
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);
    await waitForJob(service, job.id, "draft_created");
    await service.confirmPublish(job.id);

    const beforeCalls = calls.length;
    const corrected = service.correctStatus(job.id, "published", "已在掘金后台核实发布成功");
    expect(corrected.status).toBe("published");
    expect(corrected.statusNote).toBeNull();
    expect(corrected.errorMessage).toBeNull();
    expect(calls.length).toBe(beforeCalls);
  });

  it("keeps external image URLs untouched (external-link strategy, no upload endpoint)", async () => {
    const { account, service, calls } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const saved = service.saveDraft(draft.id, {
      title: "外链图测试",
      markdown: "# 外链图测试\n\n![远程图](https://img.example.com/diagram.png)",
      coverSource: "https://img.example.com/cover.png"
    });
    const approved = service.approveDraft(saved.id);
    const job = service.createPublishJob(approved.id);
    await waitForJob(service, job.id, "draft_created");

    const create = calls.find((call) => call.endpoint === "article_draft/create")!;
    const body = JSON.parse(create.body) as Record<string, unknown>;
    expect(body.mark_content).toContain("https://img.example.com/diagram.png");
    expect(body.cover_image).toBe("https://img.example.com/cover.png");
    // 掘金写端点不需要签名，也不调用任何上传端点。
    expect(calls.some((call) => /upload|image/i.test(call.endpoint))).toBe(false);
  });

  it("inlines local asset images to data URIs before creating the draft", async () => {
    const { account, service, calls, sourceDirectory } = setupHarness();
    const assetsDir = path.join(sourceDirectory, "posts", "source", "assets");
    fs.writeFileSync(path.join(assetsDir, "local.png"), Buffer.from("local-png-bytes", "utf8"));
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const saved = service.saveDraft(draft.id, {
      title: "本地图测试",
      markdown: "# 本地图测试\n\n![本地图](./assets/local.png)\n",
      coverSource: ""
    });
    const approved = service.approveDraft(saved.id);
    const job = service.createPublishJob(approved.id);
    await waitForJob(service, job.id, "draft_created");

    const create = calls.find((call) => call.endpoint === "article_draft/create")!;
    const body = JSON.parse(create.body) as Record<string, unknown>;
    expect(body.mark_content).toContain("data:image/png;base64,");
    expect(body.mark_content).toContain(Buffer.from("local-png-bytes", "utf8").toString("base64"));
    expect(body.mark_content).not.toContain("./assets/local.png");
    // 仍不调用任何上传端点（本地图直接内联，不上传图床）。
    expect(calls.some((call) => /upload|image/i.test(call.endpoint))).toBe(false);
  });

  it("moves the job to failed when the inlined markdown exceeds the content length limit", async () => {
    const { account, service, calls } = setupHarness();
    const assetsDir = path.join(sourceDirectory!, "posts", "source", "assets");
    fs.writeFileSync(path.join(assetsDir, "local.png"), Buffer.from("local-png-bytes", "utf8"));
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    // 正文接近本地上限（100000），内联一张本地图后必然超过掘金字数限制。
    const longBody = `${"内容".repeat(49_980)}\n\n![本地图](./assets/local.png)\n`;
    const saved = service.saveDraft(draft.id, {
      title: "超长正文测试",
      markdown: longBody,
      coverSource: ""
    });
    const approved = service.approveDraft(saved.id);

    const job = service.createPublishJob(approved.id);
    const failed = await waitForJob(service, job.id, "failed");
    expect(failed.errorMessage).toContain("超过掘金最大字数限制");
    expect(failed.errorMessage).toContain("本地图片已内联");
    // 本地侧拦截，不应向掘金发起 create 请求。
    expect(calls.some((call) => call.endpoint === "article_draft/create")).toBe(false);
  });
});

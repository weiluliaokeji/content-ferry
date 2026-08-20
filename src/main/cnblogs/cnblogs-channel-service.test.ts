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
import { CnblogsChannelService, type CnblogsPublishJob } from "./cnblogs-channel-service";

const testVault: CredentialVault = {
  encrypt: (value) => Buffer.from(`encrypted:${value}`),
  decrypt: (value) => value.toString().replace("encrypted:", "")
};

interface RpcCall {
  methodName: string;
  url: string;
  body: string;
}

function rpcResponse(valueXml: string): Response {
  return new Response(
    `<?xml version="1.0"?><methodResponse><params><param><value>${valueXml}</value></param></params></methodResponse>`,
    { status: 200, headers: { "content-type": "text/xml" } }
  );
}

function rpcFault(faultCode: number, faultString: string): Response {
  return new Response(
    `<?xml version="1.0"?><methodResponse><fault><value><struct>` +
      `<member><name>faultCode</name><value><int>${faultCode}</int></value></member>` +
      `<member><name>faultString</name><value><string>${faultString}</string></value></member>` +
      `</struct></value></fault></methodResponse>`,
    { status: 200, headers: { "content-type": "text/xml" } }
  );
}

function createRpcFetcher(handlers: Record<string, (call: RpcCall) => Response | Error>): { fetcher: typeof fetch; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const fetcher = (async (input: unknown, init: RequestInit | undefined) => {
    const body = String(init?.body ?? "");
    const methodName = /<methodName>([^<]+)<\/methodName>/.exec(body)?.[1] ?? "";
    const call = { methodName, url: String(input), body };
    calls.push(call);
    const handler = handlers[methodName];
    if (!handler) throw new Error(`Unexpected XML-RPC method: ${methodName}`);
    const result = handler(call);
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function defaultHandlers(overrides: Partial<Record<string, (call: RpcCall) => Response | Error>> = {}) {
  return {
    "blogger.getUsersBlogs": () => rpcResponse(
      "<array><data><value><struct>" +
        "<member><name>blogid</name><value><string>blog-1</string></value></member>" +
        "<member><name>blogName</name><value><string>weiluliaokeji</string></value></member>" +
        "<member><name>url</name><value><string>https://www.cnblogs.com/weiluliaokeji</string></value></member>" +
        "</struct></value></data></array>"
    ),
    "metaWeblog.newPost": () => rpcResponse("<string>post-123</string>"),
    "metaWeblog.editPost": () => rpcResponse("<boolean>1</boolean>"),
    "metaWeblog.newMediaObject": (call) => {
      const name = /<name>name<\/name><value><string>([^<]*)<\/string>/.exec(call.body)?.[1] ?? "img.png";
      return rpcResponse(`<struct><member><name>url</name><value><string>https://img.cnblogs.com/uploads/${name}</string></value></member></struct>`);
    },
    ...overrides
  };
}

function extractMemberXml(body: string, member: string): string {
  return new RegExp(`<member><name>${member}</name>([\\s\\S]*?)<\\/member>`).exec(body)?.[1] ?? "";
}

function extractStringMember(body: string, member: string): string {
  return /<string>([\s\S]*?)<\/string>/.exec(extractMemberXml(body, member))?.[1] ?? "";
}

/** 提取 XML-RPC post struct 的所有 member 序列（排除 publish），用于完整对象传递断言。 */
function extractPostMembers(body: string): string[] {
  const params = [...body.matchAll(/<param>([\s\S]*?)<\/param>/g)];
  const post = params[3]?.[1] ?? "";
  const members = [...post.matchAll(/<member><name>([^<]+)<\/name>([\s\S]*?)<\/member>/g)];
  return members.filter((m) => m[1] !== "publish").map((m) => `${m[1]}::${m[2]}`);
}

async function waitForJob(
  service: CnblogsChannelService,
  jobId: string,
  status: string,
  timeoutMs = 4000
): Promise<CnblogsPublishJob> {
  const deadline = Date.now() + timeoutMs;
  let last = service.getJob(jobId);
  while (Date.now() < deadline) {
    last = service.getJob(jobId);
    if (last.status === status) return last;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待 ${status} 超时；当前 ${last.status}；note=${last.statusNote}；error=${last.errorMessage}`);
}

describe("CnblogsChannelService", () => {
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

  function setupHarness(handlers: Record<string, (call: RpcCall) => Response | Error> = defaultHandlers()) {
    const { fetcher, calls } = createRpcFetcher(handlers);
    database = openInMemoryDatabase();
    const accounts = new AccountRepository(database.connection);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-cnblogs-svc-"));
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
      platform: "cnblogs",
      displayName: "博客园测试号",
      externalAccountId: "weiluliaokeji"
    });
    accounts.saveCredential(account.id, "username", "cnblogs-user", testVault);
    accounts.saveCredential(account.id, "api_key", "metaweblog-key", testVault);
    const provider = {
      generateStructured: async () => ({
        value: { title: "适配后的标题", markdown: "# 适配后的标题\n\n适配后的独立正文。" }
      })
    } as unknown as ModelProvider;
    const service = new CnblogsChannelService(database.connection, accounts, testVault, contentSources, provider, undefined, fetcher);
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
      coverSource: "./assets/cover.png"
    });
    expect(saved.title).toBe("改写后的标题");
    expect(saved.markdown).toContain("改写后的正文");
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

  it("creates an idempotent publish job that reaches draft_created", async () => {
    const { account, service, calls } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);

    const first = service.createPublishJob(approved.id);
    expect(first.status).toBe("draft_creating");

    // 等待后台草稿创建完成后再验证幂等：draft_created 是已创建态，再次调用不会重启草稿创建。
    await waitForJob(service, first.id, "draft_created");

    // 同一渠道稿、同一内容再次创建任务：返回同一个任务（幂等）。
    const again = service.createPublishJob(approved.id);
    expect(again.id).toBe(first.id);

    const job = await waitForJob(service, first.id, "draft_created");
    expect(job.remoteContentId).toBe("post-123");
    expect(job.remoteUrl).toContain("EditPosts.aspx?postid=post-123");
    expect(job.errorMessage).toBeNull();

    // 幂等：后台只调用了一次 newPost（没有重复创建博客园草稿）。
    const newPosts = calls.filter((call) => call.methodName === "metaWeblog.newPost");
    expect(newPosts).toHaveLength(1);
    // publish=false 作为第 5 个独立参数（boolean 0），不是 post struct 的 member。
    expect(newPosts[0].body).toContain("<param><value><boolean>0</boolean></value></param>");
    expect(newPosts[0].body).not.toContain("<name>publish</name>");
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
    expect(calls.filter((call) => call.methodName === "metaWeblog.newPost")).toHaveLength(2);
  });

  it("enforces the UNIQUE constraint on idempotency_key at the database level", async () => {
    const { account, service, database: db } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);

    expect(() => {
      db.connection.prepare(`INSERT INTO cnblogs_publish_jobs
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
    expect(published.remoteUrl).toBe("https://www.cnblogs.com/weiluliaokeji/p/post-123.html");
    expect(published.remoteContentId).toBe("post-123");

    const methods = calls.map((call) => call.methodName);
    expect(methods.indexOf("blogger.getUsersBlogs")).toBeLessThan(methods.indexOf("metaWeblog.newPost"));
    expect(methods.indexOf("metaWeblog.newPost")).toBeLessThan(methods.indexOf("metaWeblog.editPost"));
    const editPost = calls.find((call) => call.methodName === "metaWeblog.editPost")!;
    // publish=true 是 editPost 的第 5 个独立参数（boolean 1），不是 post struct 的 member。
    expect(editPost.body).toContain("<param><value><boolean>1</boolean></value></param>");
    expect(editPost.body).not.toContain("<name>publish</name>");
  });

  it("moves to needs_credentials when credentials are missing and recovers after configuration", async () => {
    // mock 的 getUsersBlogs 必须返回与账号 externalAccountId 一致的博客名，
    // 否则 resolveBlog 会在补配凭据后回写博客名并触发 media_accounts 唯一键冲突。
    const { account, service, accounts } = setupHarness(defaultHandlers({
      "blogger.getUsersBlogs": () => rpcResponse(
        "<array><data><value><struct>" +
          "<member><name>blogid</name><value><string>blog-1</string></value></member>" +
          "<member><name>blogName</name><value><string>weiluliaokeji-unconfigured</string></value></member>" +
          "<member><name>url</name><value><string>https://www.cnblogs.com/weiluliaokeji-unconfigured</string></value></member>" +
          "</struct></value></data></array>"
      )
    }));
    // 清掉凭据，模拟未配置。
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    // 删除凭据行，直接模拟未配置（用一条不存在的账号触发不了，因此改走更新为空串不可行；
    // 这里重建一个未配置凭据的账号）。
    const unconfigured = accounts.createAccount({
      workspaceId: approved.workspaceId,
      platform: "cnblogs",
      displayName: "未配置博客园",
      externalAccountId: "weiluliaokeji-unconfigured"
    });
    const secondDraft = await service.createFromSource({ accountId: unconfigured.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const secondApproved = service.approveDraft(secondDraft.id);
    const job = service.createPublishJob(secondApproved.id);
    const blocked = await waitForJob(service, job.id, "needs_credentials");
    expect(blocked.errorMessage).toContain("尚未配置用户名或 MetaWeblog API Key");

    // 用户补上凭据后重新触发：同一任务恢复执行。
    accounts.saveCredential(unconfigured.id, "username", "cnblogs-user", testVault);
    accounts.saveCredential(unconfigured.id, "api_key", "metaweblog-key", testVault);
    const retried = service.createPublishJob(secondApproved.id);
    expect(retried.id).toBe(job.id);
    await waitForJob(service, job.id, "draft_created");
  });

  it("moves to needs_credentials when the blog name is missing and recovers after it is filled", async () => {
    const { account, service, accounts } = setupHarness(defaultHandlers({
      "blogger.getUsersBlogs": () => rpcResponse(
        "<array><data><value><struct>" +
          "<member><name>blogid</name><value><string>blog-1</string></value></member>" +
          "<member><name>blogName</name><value><string>weiluliaokeji</string></value></member>" +
          "<member><name>url</name><value><string>https://www.cnblogs.com/weiluliaokeji</string></value></member>" +
          "</struct></value></data></array>"
      )
    }));
    // 创建未填写博客地址/博客名的账号（external_account_id 为空），模拟本次修复前的卡点。
    const missingBlog = accounts.createAccount({
      workspaceId: account.workspaceId,
      platform: "cnblogs",
      displayName: "缺少博客名",
    });
    accounts.saveCredential(missingBlog.id, "username", "cnblogs-user", testVault);
    accounts.saveCredential(missingBlog.id, "api_key", "metaweblog-key", testVault);
    const draft = await service.createFromSource({ accountId: missingBlog.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);
    const blocked = await waitForJob(service, job.id, "needs_credentials");
    expect(blocked.errorMessage).toContain("缺少博客名");

    // 用户在账号管理中补填博客地址/博客名（走 AccountRepository.updateExternalAccountId，即 PUT 路由的落库路径）。
    accounts.updateExternalAccountId(missingBlog.id, "https://www.cnblogs.com/weiluliaokeji/");
    const retried = service.createPublishJob(approved.id);
    expect(retried.id).toBe(job.id);
    await waitForJob(service, job.id, "draft_created");
  });

  it("moves to needs_credentials when getUsersBlogs reports a fault", async () => {
    const { account, service } = setupHarness(defaultHandlers({
      "blogger.getUsersBlogs": () => rpcFault(403, "Invalid username or password")
    }));
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);
    const blocked = await waitForJob(service, job.id, "needs_credentials");
    expect(blocked.errorMessage).toContain("用户名或 API Key 无效");
  });

  it("moves to failed on network errors and retries with the same job", async () => {
    let newPostFails = true;
    const { account, service, calls } = setupHarness(defaultHandlers({
      "metaWeblog.newPost": () => {
        if (newPostFails) throw new Error("ECONNREFUSED");
        return rpcResponse("<string>post-456</string>");
      }
    }));
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);

    const job = service.createPublishJob(approved.id);
    const failed = await waitForJob(service, job.id, "failed");
    expect(failed.errorMessage).toContain("ECONNREFUSED");

    // 网络恢复后重试：同一任务重新走草稿创建。
    newPostFails = false;
    const retried = service.createPublishJob(approved.id);
    expect(retried.id).toBe(job.id);
    await waitForJob(service, job.id, "draft_created");
    expect(calls.filter((call) => call.methodName === "metaWeblog.newPost")).toHaveLength(2);
  });

  it("moves to failed when an image upload fails and surfaces the failed asset", async () => {
    const { account, service, calls } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const saved = service.saveDraft(draft.id, {
      title: "带图标题",
      markdown: "# 带图标题\n\n![缺失图](./assets/missing.png)"
    });
    const approved = service.approveDraft(saved.id);
    const job = service.createPublishJob(approved.id);
    const failed = await waitForJob(service, job.id, "failed");
    expect(failed.errorMessage).toContain("图片上传失败");
    expect(failed.errorMessage).toContain("missing.png");
    expect(calls.some((call) => call.methodName === "metaWeblog.newPost")).toBe(false);
  });

  it("moves to needs_manual_reconciliation when editPost fails after the draft exists", async () => {
    const { account, service, calls } = setupHarness(defaultHandlers({
      "metaWeblog.editPost": () => rpcFault(500, "Internal blog error")
    }));
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);
    await waitForJob(service, job.id, "draft_created");

    const result = await service.confirmPublish(job.id);
    expect(result.status).toBe("needs_manual_reconciliation");
    expect(result.statusNote).toContain("草稿已创建，但公开失败");
    expect(result.remoteContentId).toBe("post-123"); // 草稿仍保留，可人工校正
    expect(calls.some((call) => call.methodName === "metaWeblog.editPost")).toBe(true);
  });

  it("records a manual submission receipt for a reconciled publish", async () => {
    const { account, service } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);
    await waitForJob(service, job.id, "draft_created");

    const recorded = service.recordSubmission(job.id, {
      remoteUrl: "https://www.cnblogs.com/weiluliaokeji/p/post-999.html",
      remoteContentId: "post-999",
      state: "published"
    });
    expect(recorded.status).toBe("published");
    expect(recorded.remoteUrl).toBe("https://www.cnblogs.com/weiluliaokeji/p/post-999.html");
    expect(recorded.statusNote).toContain("已发布");
  });

  it("supports manual correction that only updates the local record", async () => {
    const { account, service, calls } = setupHarness(defaultHandlers({
      "metaWeblog.editPost": () => rpcFault(500, "Internal blog error")
    }));
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const approved = service.approveDraft(draft.id);
    const job = service.createPublishJob(approved.id);
    await waitForJob(service, job.id, "draft_created");
    await service.confirmPublish(job.id);

    const beforeCalls = calls.length;
    const corrected = service.correctStatus(job.id, "published", "已在博客园后台核实发布成功");
    expect(corrected.status).toBe("published");
    // published 状态只更新本地记录：statusNote/errorMessage 为 null，且不再触发任何 XML-RPC。
    expect(corrected.statusNote).toBeNull();
    expect(corrected.errorMessage).toBeNull();
    expect(calls.length).toBe(beforeCalls);
  });

  it("injects the [Markdown] category, tags and digest into the XML-RPC post object", async () => {
    const { account, service, calls } = setupHarness();
    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const saved = service.saveDraft(draft.id, {
      title: "分类测试",
      markdown: "# 分类测试\n\n正文",
      digest: "这是一段摘要。"
    });
    const approved = service.approveDraft(saved.id);
    const job = service.createPublishJob(approved.id, {
      categories: ["后端"],
      tags: ["TypeScript", "Node"]
    });
    await waitForJob(service, job.id, "draft_created");

    const newPost = calls.find((call) => call.methodName === "metaWeblog.newPost")!;
    const categoriesXml = extractMemberXml(newPost.body, "categories");
    expect(categoriesXml).toContain("[Markdown]");
    expect(categoriesXml).toContain("后端");
    // [Markdown] 排在最前，且自定义分类去重后追加。
    expect(categoriesXml.indexOf("[Markdown]")).toBeLessThan(categoriesXml.indexOf("后端"));
    expect(extractStringMember(newPost.body, "mt_keywords")).toBe("TypeScript,Node");
    expect(extractStringMember(newPost.body, "mt_excerpt")).toBe("这是一段摘要。");
    expect(extractMemberXml(newPost.body, "mt_allow_comments")).toContain("<int>1</int>");
    expect(extractStringMember(newPost.body, "title")).toBe("分类测试");
  });

  it("integration: mock XML-RPC server validates the newPost → editPost chain and the complete post object is passed to editPost (full-replacement guard)", async () => {
    const { account, service, calls, sourceDirectory } = setupHarness();
    const articleDirectory = path.join(sourceDirectory!, "posts", "source");
    fs.writeFileSync(path.join(articleDirectory, "assets", "diagram.png"), Buffer.from("fake-png", "utf8"));
    fs.writeFileSync(path.join(articleDirectory, "assets", "cover.png"), Buffer.from("cover-bytes", "utf8"));

    const draft = await service.createFromSource({ accountId: account.id, relativePath: "posts/source/index.md", generationMode: "source" });
    const saved = service.saveDraft(draft.id, {
      title: "集成测试标题",
      markdown: "# 集成测试标题\n\n正文包含一张本地图。\n\n![示意图](./assets/diagram.png)",
      digest: "集成测试摘要",
      coverSource: "./assets/cover.png"
    });
    const approved = service.approveDraft(saved.id);
    const job = service.createPublishJob(approved.id);
    await waitForJob(service, job.id, "draft_created");
    await service.confirmPublish(job.id);

    const published = service.getJob(job.id);
    expect(published.status).toBe("published");

    const newPost = calls.find((call) => call.methodName === "metaWeblog.newPost")!;
    const editPost = calls.find((call) => call.methodName === "metaWeblog.editPost")!;
    const uploads = calls.filter((call) => call.methodName === "metaWeblog.newMediaObject");

    // 两段式：newPost publish=false 创建草稿 → editPost publish=true 公开（均作为独立 param）。
    expect(newPost.body).toContain("<param><value><boolean>0</boolean></value></param>");
    expect(newPost.body).not.toContain("<name>publish</name>");
    expect(editPost.body).toContain("<param><value><boolean>1</boolean></value></param>");
    expect(editPost.body).not.toContain("<name>publish</name>");
    // 本地图片 + 封面在公开前都经 newMediaObject 上传。
    expect(uploads.length).toBeGreaterThanOrEqual(2);
    expect(uploads.some((call) => call.body.includes("diagram.png"))).toBe(true);
    expect(uploads.some((call) => call.body.includes("cover.png"))).toBe(true);

    // 完整 post 对象传递：editPost 收到的 post struct 与 newPost 完全一致（除 publish），
    // 防止"只传 postId 触发完全替换为空文章"的陷阱。
    expect(extractPostMembers(editPost.body)).toEqual(extractPostMembers(newPost.body));

    // 封面插入文首，图片引用已替换为图床永久 URL。
    const description = extractStringMember(newPost.body, "description");
    expect(description.startsWith("![封面](https://img.cnblogs.com/uploads/cover.png)")).toBe(true);
    expect(description).toContain("![示意图](https://img.cnblogs.com/uploads/diagram.png)");
    expect(description).not.toContain("./assets/");
  });
});

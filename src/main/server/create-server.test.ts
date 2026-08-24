import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildServer } from "./create-server";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import type { CredentialVault } from "../security/credential-vault";
import type { GenerateStructuredRequest, GenerateStructuredResult, ModelProvider, WebResearchOptions } from "../ai/model-provider";
import type { ResearchCard, WebResearchContext } from "../ai/research-prompts";
import { LocalAssetStore } from "../content/local-asset-store";
import { stageDirectoryDeletion } from "../content/content-source-service";

// Under `ELECTRON_RUN_AS_NODE=1` the real electron `app` is not initialised,
// so `app.getPath("userData")` is undefined and any code path that reads app
// settings during a test would throw. Provide a minimal stand-in so the local
// API tests can construct the server. This only affects the test process;
// production still uses the real electron module.
vi.mock("electron", async (importOriginal) => {
  const nodeFs = await import("node:fs");
  const nodeOs = await import("node:os");
  const actual = (await importOriginal()) as Record<string, unknown>;
  const originalApp = (actual.app ?? {}) as Record<string, unknown>;
  const tmp = process.env.CONTENTFERRY_TEST_USERDATA ?? `${nodeOs.tmpdir()}/contentferry-test-userdata`;
  nodeFs.mkdirSync(tmp, { recursive: true });
  const originalGetPath = originalApp.getPath as ((name: string) => string) | undefined;
  return {
    ...actual,
    app: {
      ...originalApp,
      getPath: (name: string) => (name === "userData" ? tmp : (originalGetPath ? originalGetPath(name) : tmp)),
      getAppPath: () => tmp
    }
  } as Record<string, unknown>;
});

const testVault: CredentialVault = {
  encrypt: (value) => Buffer.from(`encrypted:${value}`),
  decrypt: (value) => value.toString().replace("encrypted:", "")
};

// The research generation endpoints stream Server-Sent Events. Extract the
// final `complete` event payload so assertions can read the structured result.
function parseSseCompleteEvent(body: string): Record<string, unknown> {
  for (const block of body.split("\n\n")) {
    const eventMatch = /^event: (.+)$/m.exec(block);
    const dataMatch = /^data: (.+)$/ms.exec(block);
    if (eventMatch?.[1] === "complete" && dataMatch) {
      return JSON.parse(dataMatch[1]) as Record<string, unknown>;
    }
  }
  throw new Error(`SSE stream did not contain a 'complete' event. Body head: ${body.slice(0, 600)}`);
}

describe("local API scaffold", () => {
  let server: FastifyInstance | undefined;
  let database: AppDatabase | undefined;
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await server?.close();
    database?.close();
    server = undefined;
    database = undefined;
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  function createTestServer(modelProvider?: ModelProvider, assetStore?: LocalAssetStore): FastifyInstance {
    database = openInMemoryDatabase();
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-library-"));
    temporaryDirectories.push(sourceDirectory);
    const now = new Date().toISOString();
    database.connection.prepare("INSERT INTO workspaces (id, display_name, timezone, created_at) VALUES (?, ?, ?, ?)")
      .run("local-default", "本地工作区", "Asia/Shanghai", now);
    database.connection.prepare("INSERT INTO content_sources (workspace_id, root_path, updated_at) VALUES (?, ?, ?)")
      .run("local-default", sourceDirectory, now);
    return buildServer("2026-07-19T00:00:00.000Z", database, testVault, modelProvider, assetStore);
  }

  it("manages editable skills and model connections separately", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-skills-"));
    temporaryDirectories.push(skillsDirectory);
    server = buildServer(
      "2026-07-19T00:00:00.000Z",
      database,
      testVault,
      undefined,
      undefined,
      { skillsDirectory }
    );

    const listed = await server.inject({ method: "GET", url: "/api/skills" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(11);
    expect(listed.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "awen-assistant", name: "阿文 · 文章顾问" }),
      expect.objectContaining({ id: "article-summary", name: "文章摘要生成" }),
      expect.objectContaining({ id: "web-research", name: "联网资料补研" }),
      expect.objectContaining({ id: "cover-prompt-generation", name: "封面提示词生成" })
    ]));
    const connections = await server.inject({ method: "GET", url: "/api/model-connections" });
    expect(connections.statusCode).toBe(200);
    expect(connections.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "openai_codex",
        displayName: "OpenAI Codex"
      }),
      expect.objectContaining({
        provider: "modelscope",
        displayName: "ModelScope"
      }),
      expect.objectContaining({
        provider: "agnes",
        displayName: "Agnes AI"
      })
    ]));
    const humanize = listed.json().items.find((item: { id: string }) => item.id === "humanize-selection");
    expect(humanize.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "SKILL.md" }),
      expect.objectContaining({ relativePath: "references/protected-spans.md" })
    ]));
    const reference = await server.inject({
      method: "GET",
      url: "/api/skills/humanize-selection/file?path=references%2Fprotected-spans.md"
    });
    expect(reference.statusCode).toBe(200);
    expect(reference.json().content).toContain("# 保护项");
    const savedReference = await server.inject({
      method: "PUT",
      url: "/api/skills/humanize-selection/file",
      payload: { path: "references/protected-spans.md", content: `${reference.json().content}\n用户补充的保护规则。` }
    });
    expect(savedReference.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(skillsDirectory, "humanize-selection", "references", "protected-spans.md"), "utf8"))
      .toContain("用户补充的保护规则");

    const connection = await server.inject({
      method: "PUT",
      url: "/api/model-connections/agnes",
      payload: {
        displayName: "Agnes AI",
        modelId: "agnes-image-2.1-flash",
        baseUrl: "https://apihub.agnes-ai.com/v1",
        proxyUrl: "http://127.0.0.1:7890",
        enabled: true,
        credential: "secret-key"
      }
    });
    expect(connection.statusCode).toBe(200);
    expect(connection.json()).toMatchObject({ provider: "agnes", credentialConfigured: true });

    const cover = listed.json().items.find((item: { id: string }) => item.id === "cover-generation");
    const updated = await server.inject({
      method: "PUT",
      url: "/api/skills/cover-generation",
      payload: { markdown: `${cover.markdown}\n用户自定义要求。`, enabled: true, provider: "agnes" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ provider: "agnes" });
    expect(fs.readFileSync(path.join(skillsDirectory, "cover-generation", "SKILL.md"), "utf8"))
      .toContain("用户自定义要求");
  });

  it("stores Tavily configuration locally and can test or remove it", async () => {
    server = createTestServer();
    const before = await server.inject({ method: "GET", url: "/api/web-search/settings" });
    expect(before.json()).toMatchObject({ tavilyConfigured: false, tavilyCredentialSource: "none" });

    const saved = await server.inject({
      method: "PUT",
      url: "/api/web-search/tavily",
      payload: { apiKey: "tvly-test-key" }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ tavilyConfigured: true, tavilyCredentialSource: "local" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: "Tavily result", url: "https://example.com", content: "Search result" }]
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const tested = await server.inject({ method: "POST", url: "/api/web-search/tavily/test", payload: {} });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({ ok: true, resultCount: 1 });

    const removed = await server.inject({ method: "DELETE", url: "/api/web-search/tavily" });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ tavilyConfigured: false, tavilyCredentialSource: "none" });
  });

  it("persists the handled status of an Awen suggestion", async () => {
    server = createTestServer();
    const contextKey = "source:posts/example/index.md";
    const messageId = "11111111-1111-4111-8111-111111111111";
    const now = new Date().toISOString();
    database!.connection.prepare("INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, '', ?)")
      .run(contextKey, now);
    database!.connection.prepare(`INSERT INTO article_chat_messages
      (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
      VALUES (?, ?, 'assistant', ?, '', ?, ?)`)
      .run(
        messageId,
        contextKey,
        "A suggestion that has already been handled.",
        JSON.stringify([{ original: "unique original paragraph", replacement: "updated paragraph", reason: "Clearer wording" }]),
        now
      );

    const before = await server.inject({ method: "GET", url: `/api/article-chat?contextKey=${encodeURIComponent(contextKey)}` });
    expect(before.statusCode).toBe(200);
    expect(before.json().messages[0].suggestions).toHaveLength(1);

    const handled = await server.inject({ method: "PATCH", url: `/api/article-chat/messages/${messageId}/suggestions/0`, payload: { status: "rejected" } });
    expect(handled.statusCode).toBe(200);
    expect(handled.json().suggestions).toEqual([expect.objectContaining({ status: "rejected" })]);

    const after = await server.inject({ method: "GET", url: `/api/article-chat?contextKey=${encodeURIComponent(contextKey)}` });
    expect(after.statusCode).toBe(200);
    expect(after.json().messages[0].suggestions).toEqual([expect.objectContaining({ status: "rejected" })]);
  });

  it("reuses a client Awen message id when a failed message is sent again", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-skills-"));
    temporaryDirectories.push(skillsDirectory);
    const fakeProvider: ModelProvider = {
      id: "test-awen-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        return {
          value: request.parse({ reply: "已收到。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [] }),
          provider: "test-awen-ai",
          model: "test-model",
          usage: null
        };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const payload = {
      contextKey: "source:posts/retry/index.md",
      clientMessageId: "22222222-2222-4222-8222-222222222222",
      title: "Retry test",
      markdown: "A unique article paragraph for the retry test.",
      message: "Please improve this paragraph."
    };
    expect((await server.inject({ method: "POST", url: "/api/article-chat/messages", payload })).statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url: "/api/article-chat/messages", payload })).statusCode).toBe(200);
    const userMessageCount = database.connection.prepare("SELECT COUNT(*) AS count FROM article_chat_messages WHERE id = ?")
      .get(payload.clientMessageId) as { count: number };
    expect(userMessageCount.count).toBe(1);
  });

  it("generates a platform-aware article summary through the managed summary skill", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-summary-skills-"));
    temporaryDirectories.push(skillsDirectory);
    const prompts: string[] = [];
    const fakeProvider: ModelProvider = {
      id: "test-summary-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        prompts.push(request.prompt);
        return {
          value: request.parse({ summary: "这篇文章解释了可恢复内容工作流如何降低跨平台创作和发布的返工成本。" }),
          provider: "test-summary-ai",
          model: "test-model",
          usage: null
        };
      }
    };
    server = buildServer(
      "2026-07-19T00:00:00.000Z",
      database,
      testVault,
      fakeProvider,
      undefined,
      { skillsDirectory }
    );

    const response = await server.inject({
      method: "POST",
      url: "/api/skills/article-summary/run",
      payload: {
        platform: "wechat_official",
        title: "可恢复的内容工作流",
        markdown: "# 可恢复的内容工作流\n\n正文讨论跨平台创作和发布的返工问题。"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      platform: "wechat_official",
      maxLength: 120,
      provider: "test-summary-ai"
    });
    expect(response.json().summary.length).toBeLessThanOrEqual(120);
    expect(prompts[0]).toContain("最多 120 个字符");
    expect(prompts[0]).toContain("微信公众号");
  });

  it("runs selection editing through the managed selection skill", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-selection-skills-"));
    temporaryDirectories.push(skillsDirectory);
    const requests: Array<GenerateStructuredRequest<unknown>> = [];
    const fakeProvider: ModelProvider = {
      id: "test-selection-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        requests.push(request as GenerateStructuredRequest<unknown>);
        return {
          value: request.parse({ replacement: "改写后的自然表达" }),
          provider: "test-selection-ai",
          model: "test-model",
          usage: null
        };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const response = await server.inject({
      method: "POST",
      url: "/api/skills/selection-edit/run",
      payload: {
        action: "rewrite",
        contextKey: "source:posts/selection/index.md",
        selectedText: "需要改写的文字",
        beforeText: "前文",
        afterText: "后文",
        title: "测试文章",
        instruction: "Keep technical terms and use a direct tone."
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ replacement: "改写后的自然表达", provider: "test-selection-ai", conversation: { assistantMessage: { suggestions: [expect.objectContaining({ replacement: "改写后的自然表达" })] } } });
    expect(requests[0]).toMatchObject({ task: "selection", skillId: "selection-edit" });
    expect(requests[0].prompt).toContain("Keep technical terms and use a direct tone.");
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM article_chat_messages WHERE context_key = ?").get("source:posts/selection/index.md")).toMatchObject({ count: 2 });
  });

  it("generates an editable cover prompt from the article", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-cover-prompt-skills-"));
    temporaryDirectories.push(skillsDirectory);
    const requests: Array<GenerateStructuredRequest<unknown>> = [];
    const fakeProvider: ModelProvider = {
      id: "test-cover-prompt-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        requests.push(request as GenerateStructuredRequest<unknown>);
        return {
          value: request.parse({ prompt: "16:9 横版，蓝绿色调，一座连接内容与读者的桥，右侧留出干净标题区域，不含文字和水印。" }),
          provider: "test-cover-prompt-ai",
          model: "test-model",
          usage: null
        };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const response = await server.inject({
      method: "POST",
      url: "/api/skills/cover-prompt-generation/run",
      payload: {
        title: "可恢复的内容工作流",
        markdown: "# 可恢复的内容工作流\n\n文章讨论创作、审核和发布之间的衔接。"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ provider: "test-cover-prompt-ai" });
    expect(response.json().prompt).toContain("16:9");
    expect(requests[0]).toMatchObject({ task: "cover_prompt", skillId: "cover-prompt-generation" });
  });

  it("returns recent runtime logs and redacts access tokens", async () => {
    database = openInMemoryDatabase();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-runtime-logs-"));
    temporaryDirectories.push(directory);
    const logFilePath = path.join(directory, "contentferry.log");
    fs.writeFileSync(logFilePath, [
      JSON.stringify({ level: 30, time: 1784500000000, reqId: "req-1", req: { method: "POST", url: "/wechat/callback/test" }, msg: "incoming request" }),
      JSON.stringify({ level: 50, time: 1784500000100, reqId: "req-2", req: { method: "GET", url: "/wechat?access_token=secret-value" }, res: { statusCode: 500 }, msg: "request failed" })
    ].join("\n") + "\n", "utf8");
    server = buildServer("2026-07-20T00:00:00.000Z", database, testVault, undefined, undefined, { logFilePath });
    const response = await server.inject({ method: "GET", url: "/api/runtime-logs?limit=20" });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "POST", url: "/wechat/callback/test" }),
      expect.objectContaining({ statusCode: 500, url: "/wechat?access_token=***" })
    ]));
    const errors = await server.inject({ method: "GET", url: "/api/runtime-logs?limit=20&scope=errors" });
    expect(errors.statusCode).toBe(200);
    expect(errors.json()).toMatchObject({ totalMatched: 1, hasMore: false, sourceTruncated: false });
    expect(errors.json().items).toEqual([expect.objectContaining({ statusCode: 500 })]);
  });

  it("persists article settings and returns recently used authors", async () => {
    server = createTestServer();
    const account = await server.inject({
      method: "POST",
      url: "/api/media-accounts",
      payload: { platform: "wechat_official", displayName: "合集测试号" }
    });
    const accountId = account.json().id as string;
    const saved = await server.inject({
      method: "PUT",
      url: "/api/article-settings",
      payload: {
        contextKey: "project:11111111-1111-4111-8111-111111111111",
        author: "围炉作者",
        digest: "这是一段公众号摘要。",
        coverSource: "contentferry-asset://project/cover.jpg",
        accountId,
        needOpenComment: true,
        onlyFansCanComment: true,
        declareOriginal: true,
        enableReward: true,
        collectionName: "测试合集"
      }
    });
    expect(saved.statusCode).toBe(200);

    const loaded = await server.inject({
      method: "GET",
      url: "/api/article-settings?contextKey=project%3A11111111-1111-4111-8111-111111111111"
    });
    expect(loaded.json()).toMatchObject({
      author: "围炉作者",
      digest: "这是一段公众号摘要。",
      needOpenComment: true,
      onlyFansCanComment: true,
      declareOriginal: true,
      enableReward: true,
      collectionName: "测试合集"
    });

    const authors = await server.inject({ method: "GET", url: "/api/article-settings/authors" });
    expect(authors.json().items).toContain("围炉作者");

    database?.connection.prepare(`INSERT INTO wechat_collections
      (account_id, name, wechat_collection_id, observed_at) VALUES (?, ?, ?, ?)`)
      .run(accountId, "微信同步合集", "collection-1", "2026-07-26T00:00:00.000Z");
    const collections = await server.inject({
      method: "GET",
      url: `/api/article-settings/collections?accountId=${accountId}`
    });
    expect(collections.json()).toMatchObject({
      items: expect.arrayContaining(["测试合集", "微信同步合集"]),
      syncedAt: "2026-07-26T00:00:00.000Z"
    });
  });

  it("accepts editor images larger than Fastify's default one megabyte limit", async () => {
    const assetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-large-assets-"));
    temporaryDirectories.push(assetDirectory);
    server = createTestServer(undefined, new LocalAssetStore(assetDirectory));
    const response = await server.inject({
      method: "POST",
      url: "/api/content-assets",
      payload: {
        contextId: "large-image-test",
        mimeType: "image/jpeg",
        base64: Buffer.alloc(1_200_000, 1).toString("base64")
      }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().assetUrl).toMatch(/^contentferry-asset:\/\//);
  });

  it("reports a healthy local service", async () => {
    server = createTestServer();
    const response = await server.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      database: "ready",
      startedAt: "2026-07-19T00:00:00.000Z"
    });
  });

  it("does not retain the obsolete long Wechat callback route", async () => {
    server = createTestServer();
    const response = await server.inject({
      method: "POST",
      url: "/api/integrations/wechat/callback/11111111-1111-4111-8111-111111111111"
    });

    expect(response.statusCode).toBe(404);
  });

  it("creates one local workspace and manages multiple platform accounts", async () => {
    server = createTestServer();
    const workspace = await server.inject({ method: "GET", url: "/api/workspaces/default" });
    expect(workspace.json()).toMatchObject({ id: "local-default", timezone: "Asia/Shanghai" });

    const createWechat = await server.inject({ method: "POST", url: "/api/media-accounts", payload: {
      platform: "wechat_official", displayName: "围炉聊科技", externalAccountId: "gh_test"
    } });
    const createCsdn = await server.inject({ method: "POST", url: "/api/media-accounts", payload: {
      platform: "csdn", displayName: "我的 CSDN"
    } });
    expect(createWechat.statusCode).toBe(201);
    expect(createCsdn.statusCode).toBe(201);

    const listed = await server.inject({ method: "GET", url: "/api/media-accounts" });
    expect(listed.json().items).toHaveLength(2);
  });

  it("prevents duplicate account names within the same platform", async () => {
    server = createTestServer();
    const payload = { platform: "wechat_official", displayName: "接口测试号" };
    expect((await server.inject({ method: "POST", url: "/api/media-accounts", payload })).statusCode).toBe(201);
    const duplicate = await server.inject({ method: "POST", url: "/api/media-accounts", payload });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: "该平台下已存在同名账号。" });
    const otherPlatform = await server.inject({ method: "POST", url: "/api/media-accounts", payload: { ...payload, platform: "csdn" } });
    expect(otherPlatform.statusCode).toBe(201);
  });

  it("updates and clears a cnblogs account's blog name through the account rename endpoint", async () => {
    server = createTestServer();
    const account = await server.inject({ method: "POST", url: "/api/media-accounts", payload: {
      platform: "cnblogs", displayName: "我的博客园", externalAccountId: "old-blog"
    } });
    expect(account.statusCode).toBe(201);
    expect(account.json().externalAccountId).toBe("old-blog");

    const renamed = await server.inject({ method: "PUT", url: `/api/media-accounts/${account.json().id}`, payload: {
      displayName: "我的博客园", externalAccountId: "https://www.cnblogs.com/new-blog/"
    } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().externalAccountId).toBe("https://www.cnblogs.com/new-blog/");

    const cleared = await server.inject({ method: "PUT", url: `/api/media-accounts/${account.json().id}`, payload: {
      displayName: "我的博客园", externalAccountId: ""
    } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().externalAccountId).toBeNull();

    const renamedOnly = await server.inject({ method: "PUT", url: `/api/media-accounts/${account.json().id}`, payload: {
      displayName: "博客园改名"
    } });
    expect(renamedOnly.statusCode).toBe(200);
    expect(renamedOnly.json().displayName).toBe("博客园改名");
    expect(renamedOnly.json().externalAccountId).toBeNull();
  });

  it("saves an account's writing context for later creation workflows", async () => {
    server = createTestServer();
    const account = await server.inject({ method: "POST", url: "/api/media-accounts", payload: {
      platform: "wechat_official", displayName: "围炉聊科技"
    } });
    const saved = await server.inject({ method: "PUT", url: `/api/media-accounts/${account.json().id}/profile`, payload: {
      positioning: "面向技术从业者的 AI 与效率工具内容",
      targetAudience: "关注 AI 工具的职场技术读者",
      prohibitedTopics: "未经核实的投资建议",
      writingStyle: "务实、清晰、带具体案例",
      regularColumns: "工具实测、工作流拆解"
    } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().profile).toMatchObject({ positioning: "面向技术从业者的 AI 与效率工具内容", regularColumns: "工具实测、工作流拆解" });
  });

  it("only previews an existing article directory without modifying its files", async () => {
    server = createTestServer();
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-preview-"));
    try {
      fs.mkdirSync(path.join(sourceDirectory, ".vitepress"));
      fs.writeFileSync(path.join(sourceDirectory, "index.md"), "站点首页");
      fs.writeFileSync(path.join(sourceDirectory, "article.md"), "---\ntitle: 测试文章\npublish: true\ntags: [AI]\n---\n正文");
      fs.mkdirSync(path.join(sourceDirectory, "posts", "测试文章"), { recursive: true });
      fs.writeFileSync(path.join(sourceDirectory, "posts", "测试文章", "index.md"), "---\ntitle: 测试文章\npublish: true\ntags: [AI]\n---\n正文");
      fs.mkdirSync(path.join(sourceDirectory, "posts", "测试文章", "images"));
      fs.writeFileSync(path.join(sourceDirectory, "posts", "测试文章", "images", "已有图片.png"), "existing-image");
      fs.mkdirSync(path.join(sourceDirectory, "public", "covers"), { recursive: true });
      fs.writeFileSync(path.join(sourceDirectory, "public", "covers", "封面.jpg"), "public-image");
      fs.writeFileSync(path.join(sourceDirectory, ".vitepress", "ignored.md"), "不应扫描");
      const configured = await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
      expect(configured.statusCode).toBe(200);
      const preview = await server.inject({ method: "GET", url: "/api/content-source/preview" });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({ articleCount: 1, sitePageCount: 2, items: [{ relativePath: "posts/测试文章/index.md", title: "测试文章", frontMatterKeys: ["title", "publish", "tags"] }] });
      const articlePath = "posts/测试文章/index.md";
      const opened = await server.inject({ method: "GET", url: `/api/content-source/article?path=${encodeURIComponent(articlePath)}` });
      expect(opened.statusCode).toBe(200);
      expect(opened.json()).toMatchObject({ relativePath: articlePath, title: "测试文章", markdown: "正文" });
      const saved = await server.inject({ method: "PUT", url: "/api/content-source/article", payload: { path: articlePath, markdown: "# 修改后的正文\n\n新的内容" } });
      expect(saved.statusCode).toBe(200);
      const renamedArticlePath = "posts/修改后的正文/index.md";
      expect(saved.json()).toMatchObject({ relativePath: renamedArticlePath, title: "修改后的正文" });
      expect(fs.existsSync(path.join(sourceDirectory, "posts", "测试文章"))).toBe(false);
      const savedSource = fs.readFileSync(path.join(sourceDirectory, "posts", "修改后的正文", "index.md"), "utf8");
      expect(savedSource).toContain("publish: true");
      expect(savedSource).toContain("title: '修改后的正文'");
      expect(savedSource).toContain("# 修改后的正文");
      const image = await server.inject({ method: "POST", url: "/api/content-source/article-asset", payload: {
        path: renamedArticlePath,
        mimeType: "image/png",
        base64: Buffer.from("test-image").toString("base64")
      } });
      expect(image.statusCode).toBe(201);
      expect(image.json().assetUrl).toMatch(/^\.\/assets\/[a-f0-9-]+\.png$/);
      const existingImage = await server.inject({ method: "GET", url: `/api/content-source/article-resource?path=${encodeURIComponent(renamedArticlePath)}&src=${encodeURIComponent("./images/已有图片.png")}` });
      expect(existingImage.statusCode).toBe(200);
      expect(existingImage.headers["content-type"]).toContain("image/png");
      const publicImage = await server.inject({ method: "GET", url: `/api/content-source/article-resource?path=${encodeURIComponent(renamedArticlePath)}&src=${encodeURIComponent("/covers/封面.jpg")}` });
      expect(publicImage.statusCode).toBe(200);
      const escapedImage = await server.inject({ method: "GET", url: `/api/content-source/article-resource?path=${encodeURIComponent(renamedArticlePath)}&src=${encodeURIComponent("../../../../outside.png")}` });
      expect(escapedImage.statusCode).toBe(404);
      expect(fs.readFileSync(path.join(sourceDirectory, "posts", "修改后的正文", "index.md"), "utf8")).toContain("正文");
    } finally {
      fs.rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });

  it("sorts VitePress articles by front matter created time descending", async () => {
    server = createTestServer();
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-sort-"));
    temporaryDirectories.push(sourceDirectory);
    for (const [directory, created] of [["较早文章", "2026-01-01 09:00:00"], ["最新文章", "2026-07-20 12:00:00"]]) {
      const articleDirectory = path.join(sourceDirectory, "posts", directory);
      fs.mkdirSync(articleDirectory, { recursive: true });
      fs.writeFileSync(path.join(articleDirectory, "index.md"), `---\ntitle: '${directory}'\ncreated: '${created}'\n---\n\n正文\n`);
    }
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    const preview = await server.inject({ method: "GET", url: "/api/content-source/preview" });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().items.map((item: { title: string }) => item.title)).toEqual(["最新文章", "较早文章"]);
  });

  it("turns a user topic into a content project after source setup", async () => {
    server = createTestServer();
    const created = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "AI Agent 如何改变个人开发者工作流" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ topic: "AI Agent 如何改变个人开发者工作流", status: "idea" });
    const brief = await server.inject({ method: "GET", url: `/api/content-projects/${created.json().id}/brief` });
    expect(brief.json()).toMatchObject({ topic: created.json().topic });
    const relativePath = created.json().sourceRelativePath as string;
    const rootPath = database!.connection.prepare("SELECT root_path FROM content_sources WHERE workspace_id = 'local-default'")
      .pluck().get() as string;
    const createdMarkdown = fs.readFileSync(path.join(rootPath, ...relativePath.split("/")), "utf8");
    expect(createdMarkdown).toContain("created:");
    expect(createdMarkdown).toContain("tags: []");
    expect(createdMarkdown).toContain("publish: false");
    expect(createdMarkdown).toContain("# AI Agent 如何改变个人开发者工作流");
    const listed = await server.inject({ method: "GET", url: "/api/content-projects" });
    expect(listed.json().items).toHaveLength(1);
    const deleted = await server.inject({ method: "DELETE", url: `/api/content-projects/${created.json().id}` });
    expect(deleted.statusCode).toBe(204);
    expect(fs.existsSync(path.dirname(path.join(rootPath, ...relativePath.split("/"))))).toBe(false);
    expect((await server.inject({ method: "GET", url: "/api/content-projects" })).json().items).toHaveLength(0);
  });

  it("uses the optional article title as the project title", async () => {
    server = createTestServer();
    const created = await server.inject({ method: "POST", url: "/api/content-projects", payload: {
      topic: "整理个人开发者可用免费模型的使用边界", title: "零成本基建系列——长期免费的 AI 模型 API"
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ topic: "零成本基建系列——长期免费的 AI 模型 API" });
    const relativePath = created.json().sourceRelativePath as string;
    expect(relativePath).toContain("零成本基建系列——长期免费的 AI 模型 API");
  });

  it("keeps the original creation topic when a title is supplied", async () => {
    server = createTestServer();
    const created = await server.inject({ method: "POST", url: "/api/content-projects", payload: {
      topic: "original idea", title: "confirmed title", objective: "reader outcome"
    } });
    const brief = await server.inject({ method: "GET", url: `/api/content-projects/${created.json().id}/brief` });
    expect(created.json()).toMatchObject({ topic: "confirmed title" });
    expect(brief.json()).toMatchObject({ topic: "original idea", objective: "reader outcome" });
  });

  it("falls back to copy-and-remove when Windows blocks an article directory rename", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-busy-delete-"));
    temporaryDirectories.push(root);
    const articleDirectory = path.join(root, "posts", "被占用的文章");
    const trashRoot = path.join(root, ".contentferry-trash");
    const stagedPath = path.join(trashRoot, "staged-copy");
    fs.mkdirSync(articleDirectory, { recursive: true });
    fs.mkdirSync(trashRoot, { recursive: true });
    fs.writeFileSync(path.join(articleDirectory, "index.md"), "# 被占用的文章");

    const staged = stageDirectoryDeletion(articleDirectory, stagedPath, trashRoot, {
      renameSync: () => {
        throw Object.assign(new Error("directory is temporarily busy"), { code: "EPERM" });
      },
      copyFileSync: fs.copyFileSync,
      unlinkSync: fs.unlinkSync,
      mkdirSync: fs.mkdirSync,
      existsSync: fs.existsSync,
      readdirSync: fs.readdirSync,
      rmdirSync: fs.rmdirSync
    });

    expect(fs.existsSync(articleDirectory)).toBe(false);
    expect(fs.existsSync(path.join(stagedPath, "index.md"))).toBe(true);
    staged.finalize();
    expect(fs.existsSync(stagedPath)).toBe(false);
  });

  it("builds an editable initial brief from the project and account context", async () => {
    server = createTestServer();
    const account = await server.inject({ method: "POST", url: "/api/media-accounts", payload: { platform: "wechat_official", displayName: "测试账号" } });
    await server.inject({ method: "PUT", url: `/api/media-accounts/${account.json().id}/profile`, payload: {
      positioning: "AI 工具实测", targetAudience: "技术从业者", prohibitedTopics: "", writingStyle: "", regularColumns: ""
    } });
    const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "AI Agent 工作流", targetAccountId: account.json().id } });
    const initialBrief = await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/brief` });
    expect(initialBrief.json()).toMatchObject({ audience: "技术从业者", generatedFromAccountProfile: true });
    const saved = await server.inject({ method: "PUT", url: `/api/content-projects/${project.json().id}/brief`, payload: {
      objective: "帮助读者判断是否值得采用", audience: "技术从业者", angle: "以个人开发者为例", sourceNotes: "已有使用笔记"
    } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ angle: "以个人开发者为例", generatedFromAccountProfile: false });
    const outline = await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/outline` });
    expect(outline.statusCode).toBe(200);
    expect(outline.json()).toMatchObject({ generatedFromBrief: true });
    const savedOutline = await server.inject({ method: "PUT", url: `/api/content-projects/${project.json().id}/outline`, payload: { markdown: "# AI Agent 工作流\n\n## 我的提纲" } });
    expect(savedOutline.json()).toMatchObject({ markdown: "# AI Agent 工作流\n\n## 我的提纲", generatedFromBrief: false });
    const draft = await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/draft` });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ generatedFromOutline: true });
    const savedDraft = await server.inject({ method: "PUT", url: `/api/content-projects/${project.json().id}/draft`, payload: { markdown: "# AI Agent 工作流\n\n正文草稿" } });
    expect(savedDraft.json()).toMatchObject({ markdown: "# AI Agent 工作流\n\n正文草稿", generatedFromOutline: false });
    const rootPath = database!.connection.prepare("SELECT root_path FROM content_sources WHERE workspace_id = 'local-default'")
      .pluck().get() as string;
    const articleFile = path.join(rootPath, ...String(project.json().sourceRelativePath).split("/"));
    const externalSource = fs.readFileSync(articleFile, "utf8").replace("正文草稿", "Obsidian 外部修改");
    fs.writeFileSync(articleFile, externalSource);
    const externallyEdited = await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/draft` });
    expect(externallyEdited.json().markdown).toContain("Obsidian 外部修改");
    const review = await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/review` });
    expect(review.json()).toMatchObject({ status: "pending", factChecked: false });
    const approved = await server.inject({ method: "PUT", url: `/api/content-projects/${project.json().id}/review`, payload: {
      status: "approved", factChecked: true, accountFitChecked: true, aiCheckResult: "待朱雀检测", notes: "人工审核通过"
    } });
    expect(approved.json()).toMatchObject({ status: "approved", factChecked: true });
  });

  it("uses the configured AI provider to generate an outline and draft without saving them silently", async () => {
    const prompts: string[] = [];
    const fakeProvider: ModelProvider = {
      id: "test-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        prompts.push(request.prompt);
        const markdown = request.task === "outline"
          ? "# AI 提纲\n\n## 真实问题\n\n- 读者在采用 AI 工具时最容易忽略的边界"
          : "# AI 正文\n\n这是一份由测试模型生成的正文。";
        return {
          value: request.parse({ markdown }),
          provider: "test-ai",
          model: "test-model",
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 2 }
        };
      },
      async webResearch(_context: WebResearchContext): Promise<GenerateStructuredResult<ResearchCard>> {
        return {
          value: {
            planMarkdown: "## 本次补研结论\n\n- 官方文档可支持基础接入说明。",
            sources: [{
              title: "示例官方文档", url: "https://example.com/docs", excerpt: "用于验证资料卡持久化。",
              keyClaims: ["提供了可核对的接入说明"], sourceType: "official"
            }]
          },
          provider: "test-ai",
          model: null,
          usage: null
        };
      }
    };
    server = createTestServer(fakeProvider);
    const account = await server.inject({ method: "POST", url: "/api/media-accounts", payload: {
      platform: "wechat_official", displayName: "AI 测试账号"
    } });
    await server.inject({ method: "PUT", url: `/api/media-accounts/${account.json().id}/profile`, payload: {
      positioning: "帮助技术从业者理解 AI 工具", targetAudience: "技术从业者", prohibitedTopics: "虚构数据",
      writingStyle: "自然、具体", regularColumns: "工具实测"
    } });
    const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: {
      topic: "AI Agent 如何改变开发流程", targetAccountId: account.json().id
    } });
    await server.inject({ method: "PUT", url: `/api/content-projects/${project.json().id}/brief`, payload: {
      objective: "帮助读者判断如何采用", audience: "个人开发者", angle: "从真实工作流出发", sourceNotes: "用户自己的实践笔记"
    } });

    const research = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/research/generate` });
    expect(research.statusCode).toBe(200);
    const researchResult = parseSseCompleteEvent(research.body) as {
      planMarkdown: string;
      sources: Array<{ id: string; title: string; selected: boolean }>;
    };
    expect(researchResult).toMatchObject({ planMarkdown: "## 本次补研结论\n\n- 官方文档可支持基础接入说明。", sources: [{ title: "示例官方文档", selected: true }] });
    const researchSourceId = researchResult.sources[0].id;
    const deselected = await server.inject({ method: "PATCH", url: `/api/content-projects/${project.json().id}/research/sources/${researchSourceId}`, payload: { selected: false } });
    expect(deselected.statusCode).toBe(200);
    expect(deselected.json().sources[0]).toMatchObject({ id: researchSourceId, selected: false });

    const outline = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/outline/generate`, payload: {} });
    expect(outline.statusCode).toBe(200);
    expect(outline.json()).toMatchObject({ provider: "test-ai", generatedFromBrief: true, markdown: "# AI Agent 如何改变开发流程\n\n## 真实问题\n\n- 读者在采用 AI 工具时最容易忽略的边界" });
    const projectsBeforeSave = await server.inject({ method: "GET", url: "/api/content-projects" });
    expect(projectsBeforeSave.json().items[0].outlineReady).toBe(false);

    await server.inject({ method: "PUT", url: `/api/content-projects/${project.json().id}/outline`, payload: { markdown: outline.json().markdown } });
    const draft = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/draft/generate`, payload: {} });
    expect(draft.json()).toMatchObject({ provider: "test-ai", generatedFromOutline: true, markdown: "# AI Agent 如何改变开发流程\n\n这是一份由测试模型生成的正文。" });
    expect(prompts[0]).toContain("账号定位：帮助技术从业者理解 AI 工具");
    expect(prompts[0]).toContain("不是研究计划、写作任务书、待办清单或作者工作说明");
    expect(prompts[1]).toContain("已确认提纲");
  });

  it("appends follow-up research and records it in the article's Awen conversation", async () => {
    const fakeProvider: ModelProvider = {
      id: "test-research-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        const markdown = request.task === "outline"
          ? "# AI 提纲\n\n## 真实问题\n\n- 读者在采用 AI 工具时最容易忽略的边界"
          : "# AI 正文\n\n这是一份由测试模型生成的正文。";
        return {
          value: request.parse({ markdown }),
          provider: "test-research-ai",
          model: "test-model",
          usage: null
        };
      },
      async webResearch(_context: WebResearchContext, _onStatus?: (message: string) => void, options?: WebResearchOptions): Promise<GenerateStructuredResult<ResearchCard>> {
        const isFollowUp = options?.instruction !== undefined;
        return {
          value: {
            planMarkdown: isFollowUp ? "## 本轮补研结论\n\n- 已补充调用限额。" : "## 本次补研结论\n\n- 已确认基础接入方式。",
            sources: [{
              title: isFollowUp ? "调用限额官方说明" : "接入官方说明",
              url: isFollowUp ? "https://example.com/limits" : "https://example.com/getting-started",
              excerpt: "用于验证增量资料卡不会覆盖原有资料。",
              keyClaims: ["该页面说明了当前适用的限制。"],
              sourceType: "official"
            }]
          },
          provider: "test-research-ai",
          model: "test-model",
          usage: null
        };
      }
    };
    server = createTestServer(fakeProvider);
    const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "测试增量补研" } });
    const projectId = project.json().id as string;
    const sourceRelativePath = project.json().sourceRelativePath as string;
    expect((await server.inject({ method: "POST", url: `/api/content-projects/${projectId}/research/generate` })).statusCode).toBe(200);

    const followUp = await server.inject({
      method: "POST",
      url: `/api/content-projects/${projectId}/research/follow-up`,
      payload: { message: "请继续核查调用限额，只使用官方文档。" }
    });
    expect(followUp.statusCode).toBe(200);
    const followUpResult = parseSseCompleteEvent(followUp.body) as {
      planMarkdown: string;
      sources: Array<{ url: string }>;
    };
    expect(followUpResult).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ url: "https://example.com/getting-started" }),
        expect.objectContaining({ url: "https://example.com/limits" })
      ])
    });
    expect(followUpResult.planMarkdown).toContain("本次补研结论");
    expect(followUpResult.planMarkdown).toContain("本轮补研结论");

    const conversation = await server.inject({ method: "GET", url: `/api/article-chat?contextKey=${encodeURIComponent(`source:${sourceRelativePath}`)}` });
    expect(conversation.statusCode).toBe(200);
    expect(conversation.json().messages).toEqual([
      expect.objectContaining({ role: "user", content: expect.stringContaining("继续核查调用限额") }),
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("本轮补研结论") })
    ]);
  });

  it("accepts the development UI's local cross-origin request", async () => {
    server = createTestServer();
    const response = await server.inject({
      method: "OPTIONS",
      url: "/api/media-accounts",
      headers: {
        origin: "http://127.0.0.1:5175",
        "access-control-request-method": "POST"
      }
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5175");
  });

  it("stores credentials without returning their plaintext value", async () => {
    server = createTestServer();
    const account = await server.inject({ method: "POST", url: "/api/media-accounts", payload: {
      platform: "wechat_official", displayName: "测试公众号"
    } });
    const id = account.json().id as string;
    const saved = await server.inject({ method: "PUT", url: `/api/media-accounts/${id}/credentials/app_secret`, payload: { secret: "not-for-api-output" } });
    expect(saved.statusCode).toBe(204);
    expect(saved.body).not.toContain("not-for-api-output");

    const listed = await server.inject({ method: "GET", url: "/api/media-accounts" });
    expect(listed.body).not.toContain("not-for-api-output");
    expect(listed.json().items[0].credentialsConfigured).toBe(true);
  });

  it("shows safe credential status and removes a deleted account from the workspace", async () => {
    server = createTestServer();
    const account = await server.inject({ method: "POST", url: "/api/media-accounts", payload: {
      platform: "wechat_official", displayName: "待删除公众号"
    } });
    const id = account.json().id as string;
    for (const [kind, secret] of [["app_id", "wx-visible"], ["app_secret", "secret-hidden"], ["callback_token", "token-hidden"]]) {
      await server.inject({ method: "PUT", url: `/api/media-accounts/${id}/credentials/${kind}`, payload: { secret } });
    }

    const status = await server.inject({ method: "GET", url: `/api/media-accounts/${id}/credentials/status` });
    expect(status.json()).toMatchObject({
      appId: "wx-visible",
      appSecretConfigured: true,
      callbackTokenConfigured: true,
      localCallbackUrl: `http://127.0.0.1:4317/wechat/callback/${id}`
    });
    expect(status.body).not.toContain("secret-hidden");
    expect(status.body).not.toContain("token-hidden");

    expect((await server.inject({ method: "DELETE", url: `/api/media-accounts/${id}` })).statusCode).toBe(204);
    const listed = await server.inject({ method: "GET", url: "/api/media-accounts" });
    expect(listed.json().items).toHaveLength(0);
  });

  it("creates a Wechat draft, uploads local images, and keeps publish submission asynchronous", async () => {
    const assetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-assets-"));
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-wechat-source-"));
    const calls: string[] = [];
    const draftPayloads: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/cgi-bin/stable_token")) return Response.json({ access_token: "token-1", expires_in: 7200 });
      if (url.includes("/cgi-bin/material/batchget_material")) return Response.json({
        total_count: 1,
        item_count: 1,
        item: [{ media_id: "library-cover-id", name: "素材库封面", update_time: 1784460000, url: "https://mmbiz.qpic.cn/library-cover" }]
      });
      if (url.includes("/cgi-bin/material/get_material")) return new Response(Buffer.from("wechat-image"), {
        headers: { "content-type": "image/png" }
      });
      if (url.includes("/cgi-bin/media/uploadimg")) return Response.json({ url: "https://mmbiz.qpic.cn/test-inline" });
      if (url.includes("/cgi-bin/material/add_material")) return Response.json({ media_id: "cover-media-id" });
      if (url.includes("/cgi-bin/draft/add")) {
        draftPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ media_id: "draft-media-id" });
      }
      if (url.includes("/cgi-bin/freepublish/submit")) return Response.json({ errcode: 0, publish_id: "publish-id-1" });
      return Response.json({ errcode: -1, errmsg: "unexpected request" });
    }));
    server = createTestServer(undefined, new LocalAssetStore(assetDirectory));
    try {
      const account = await server.inject({ method: "POST", url: "/api/media-accounts", payload: {
        platform: "wechat_official", displayName: "接口测试公众号"
      } });
      const accountId = account.json().id as string;
      for (const [kind, secret] of [["app_id", "wx-test"], ["app_secret", "secret-test"], ["callback_token", "callback-test"]]) {
        expect((await server.inject({ method: "PUT", url: `/api/media-accounts/${accountId}/credentials/${kind}`, payload: { secret } })).statusCode).toBe(204);
      }
      expect((await server.inject({ method: "POST", url: `/api/integrations/wechat/accounts/${accountId}/test`, payload: {} })).statusCode).toBe(200);
      const materials = await server.inject({ method: "GET", url: `/api/integrations/wechat/accounts/${accountId}/materials/images` });
      expect(materials.json()).toMatchObject({ items: [{ mediaId: "library-cover-id", name: "素材库封面" }] });
      const materialPreview = await server.inject({
        method: "GET",
        url: `/api/integrations/wechat/accounts/${accountId}/materials/images/library-cover-id`
      });
      expect(materialPreview.statusCode).toBe(200);
      expect(materialPreview.headers["content-type"]).toContain("image/png");
      expect(materialPreview.rawPayload.toString()).toBe("wechat-image");
      const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: {
        topic: "微信公众号接口闭环", targetAccountId: accountId
      } });
      const projectId = project.json().id as string;
      const asset = await server.inject({ method: "POST", url: "/api/content-assets", payload: {
        contextId: projectId, mimeType: "image/png", base64: Buffer.from("image").toString("base64")
      } });
      const markdown = `# 微信公众号接口闭环\n\n正文\n\n![封面](${asset.json().assetUrl})`;
      await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/brief`, payload: {
        objective: "验证发布闭环", audience: "测试关注者", angle: "接口验证", sourceNotes: ""
      } });
      await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/outline`, payload: {
        markdown: "# 接口闭环\n\n- 正文"
      } });
      await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/draft`, payload: { markdown } });

      const draft = await server.inject({ method: "POST", url: "/api/integrations/wechat/drafts", payload: {
        accountId, projectId, author: "ContentFerry", coverSource: asset.json().assetUrl
      } });
      expect(draft.statusCode).toBe(201);
      expect(draft.json()).toMatchObject({ draftMediaId: "draft-media-id", status: "draft_ready" });
      const submitted = await server.inject({ method: "POST", url: `/api/integrations/wechat/jobs/${draft.json().id}/submit`, payload: { mode: "publish" } });
      expect(submitted.json()).toMatchObject({ publishId: "publish-id-1", status: "submitted", mode: "publish" });
      const corrected = await server.inject({
        method: "PATCH",
        url: `/api/integrations/wechat/jobs/${draft.json().id}/status`,
        payload: { status: "published", reason: "已在公众号后台核实发布成功" }
      });
      expect(corrected.statusCode).toBe(200);
      expect(corrected.json()).toMatchObject({
        status: "published",
        statusSource: "manual",
        statusNote: "已在公众号后台核实发布成功"
      });
      expect(calls.filter((url) => url.endsWith("/cgi-bin/stable_token"))).toHaveLength(1);
      expect(calls.some((url) => url.includes("/cgi-bin/draft/add?access_token="))).toBe(true);
      expect(draftPayloads[0]).toMatchObject({
        articles: [{ need_open_comment: 1, only_fans_can_comment: 0 }]
      });
      expect(calls.some((url) => url.includes("/cgi-bin/freepublish/submit?access_token="))).toBe(true);
      const timestamp = "1784460000";
      const nonce = "callback-nonce";
      const signature = createHash("sha1").update(["callback-test", timestamp, nonce].sort().join("")).digest("hex");
      const callback = await server.inject({
        method: "POST",
        url: `/wechat/callback/${accountId}?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
        headers: { "content-type": "text/xml" },
        payload: `<xml><Event><![CDATA[PUBLISHJOBFINISH]]></Event><publish_id><![CDATA[publish-id-1]]></publish_id><publish_status>0</publish_status></xml>`
      });
      expect(callback.statusCode).toBe(200);
      const callbackLogs = await server.inject({ method: "GET", url: "/api/runtime-logs?limit=20" });
      expect(callbackLogs.json().items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          url: `/wechat/callback/${accountId}`,
          message: "微信回调已接收并处理",
          statusCode: 200
        })
      ]));
      const jobs = await server.inject({ method: "GET", url: "/api/integrations/wechat/jobs" });
      expect(jobs.json().items[0]).toMatchObject({ status: "published", publishId: "publish-id-1" });
      const localDelete = await server.inject({ method: "DELETE", url: `/api/content-projects/${projectId}` });
      expect(localDelete.statusCode).toBe(204);
      const retainedJobs = await server.inject({ method: "GET", url: "/api/integrations/wechat/jobs" });
      expect(retainedJobs.json().items[0]).toMatchObject({ status: "published", projectId: null });
      const deletedPublishRecord = await server.inject({
        method: "DELETE",
        url: `/api/integrations/wechat/jobs/${retainedJobs.json().items[0].id}`
      });
      expect(deletedPublishRecord.statusCode).toBe(204);
      const jobsAfterRecordDelete = await server.inject({ method: "GET", url: "/api/integrations/wechat/jobs" });
      expect(jobsAfterRecordDelete.json().items).toHaveLength(0);

      fs.mkdirSync(path.join(sourceDirectory, "posts", "已有文章", "assets"), { recursive: true });
      fs.writeFileSync(path.join(sourceDirectory, "posts", "已有文章", "assets", "cover.png"), "source-cover");
      fs.writeFileSync(path.join(sourceDirectory, "posts", "已有文章", "index.md"), "---\ntitle: 已有文章\n---\n正文\n\n![封面](./assets/cover.png)");
      await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
      const sourceDraft = await server.inject({ method: "POST", url: "/api/integrations/wechat/source-drafts", payload: {
        accountId, relativePath: "posts/已有文章/index.md", coverSource: "./assets/cover.png"
      } });
      expect(sourceDraft.statusCode).toBe(201);
      expect(sourceDraft.json()).toMatchObject({ title: "已有文章", draftMediaId: "draft-media-id", status: "draft_ready" });
      const manuallyPublishedDraft = await server.inject({
        method: "PATCH",
        url: `/api/integrations/wechat/jobs/${sourceDraft.json().id}/status`,
        payload: { status: "published", reason: "已在微信公众号后台直接发布并核实" }
      });
      expect(manuallyPublishedDraft.statusCode).toBe(200);
      expect(manuallyPublishedDraft.json()).toMatchObject({
        status: "published",
        statusSource: "manual",
        statusNote: "已在微信公众号后台直接发布并核实"
      });
    } finally {
      fs.rmSync(assetDirectory, { recursive: true, force: true });
      fs.rmSync(sourceDirectory, { recursive: true, force: true });
    }
  });
});

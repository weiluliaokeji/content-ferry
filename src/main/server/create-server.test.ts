import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildServer as buildServerImpl } from "./create-server";
import { openInMemoryDatabase, type AppDatabase } from "../db/database";
import type { CredentialVault } from "../security/credential-vault";
import type { GenerateMarkdownStreamRequest, GenerateStructuredRequest, GenerateStructuredResult, ModelProvider, ReviewImageRequest, WebResearchOptions } from "../ai/model-provider";
import type { ResearchCard, WebResearchContext } from "../ai/research-prompts";
import type { WebSearchClient } from "../ai/web-search";
import { extractWebResearchTargets } from "../ai/awen-conversation-service";
import { LocalAssetStore } from "../content/local-asset-store";
import { stageDirectoryDeletion } from "../content/content-source-service";
import { AgentMemoryRepository } from "../ai/agent-memory-repository";
import { ArticlePracticeTaskRepository } from "../content/article-practice-task-repository";
import { ToolWorkflowRepository } from "../agent/tool-workflow-repository";
import type { ToolWorkflowSnapshot } from "../agent/tool-workflow-runner";

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

type BuildServerArgs = Parameters<typeof buildServerImpl>;

function buildServer(...args: BuildServerArgs) {
  const provider = args[3];
  if (provider) {
    args[3] = new Proxy(provider, {
      get(target, property, receiver) {
        if (property !== "generateStructured") return Reflect.get(target, property, receiver) as unknown;
        return async <T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> => {
          if (request.prompt.includes("你是与执行阿文分开的完成条件验证器")) {
            const requestText = request.prompt.match(/<author-request>\s*([\s\S]*?)\s*<\/author-request>/u)?.[1]?.trim() ?? "测试请求";
            const rawToolText = request.prompt.match(/\[原始工具观察\]\n([\s\S]*?)\n<candidate-final/u)?.[1] ?? "";
            const toolQuote = rawToolText.match(/\[[^\]]+\]\s*(.+)/u)?.[1]?.trim();
            const evidence = [
              { source: "request", quote: requestText.slice(0, 80) },
              ...(toolQuote ? [{ source: "tool", quote: toolQuote.slice(0, 80) }] : [])
            ];
            return {
              value: request.parse({ decision: "verified", reason: "测试验证器确认当前模拟观察满足测试条件。", nextStep: null, evidence }),
              provider: "test-verifier",
              model: "test-verifier",
              usage: null
            };
          }
          return target.generateStructured(request);
        };
      }
    });
  }
  return buildServerImpl(...args);
}

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
    vi.unstubAllEnvs();
  });

  // `list_system_tools` discovers commands by reading real PATH entries, so a
  // test that asserts on tool observations must not depend on what happens to
  // be installed on the machine running the suite. Seed a temporary directory
  // with the command the fake model asks for and put it first on PATH so
  // discovery returns the same non-empty result everywhere, including CI
  // runners where the real tool is absent.
  function seedSystemTool(command: string): void {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `contentferry-fake-tool-${command}-`));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, `${command}.cmd`), "@echo off\r\n");
    vi.stubEnv("PATH", `${directory}${path.delimiter}${process.env.PATH ?? ""}`);
  }

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

  it("persists image review mode and rejects connections without image input", async () => {
    server = createTestServer();
    const reset = await server.inject({ method: "PUT", url: "/api/image-review/settings", payload: { mode: "disabled", provider: null } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ mode: "disabled", provider: null });

    const rejected = await server.inject({ method: "PUT", url: "/api/image-review/settings", payload: { mode: "specific", provider: "modelscope" } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain("不支持图片输入");

    const saved = await server.inject({ method: "PUT", url: "/api/image-review/settings", payload: { mode: "specific", provider: "openai_codex" } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ mode: "specific", provider: "openai_codex", effectiveProvider: "openai_codex", effectiveVisionInputSupport: "supported" });

    const current = await server.inject({ method: "PUT", url: "/api/image-review/settings", payload: { mode: "current", provider: null } });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ mode: "current", provider: null, currentProvider: "openai_codex" });
  });

  it("exposes a guarded execution preflight without host fallback", async () => {
    server = createTestServer();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-execution-route-"));
    temporaryDirectories.push(cwd);
    const response = await server.inject({
      method: "POST",
      url: "/api/execution/preflight",
      payload: {
        targetType: "wsl", runtime: "node", targetOptions: { wslDistribution: "__contentferry_missing_distribution__" }, args: ["-e", ""], cwd,
        directoryGrants: [{ path: cwd, access: "write" }], networkPolicy: "disabled"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: false, targetType: "wsl" });
    expect(response.json().reason).toContain("不会自动回退");

    const tools = await server.inject({ method: "GET", url: "/api/tools/system" });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().items).toBeInstanceOf(Array);

    const grant = await server.inject({
      method: "POST",
      url: "/api/agent/permissions",
      payload: { scope: "global", decision: "allow", toolId: "execution:git", action: "read", targetPrefix: cwd }
    });
    expect(grant.statusCode).toBe(201);
    const grants = await server.inject({ method: "GET", url: "/api/agent/permissions" });
    expect(grants.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ id: grant.json().id, toolId: "execution:git" })]));
    const removedGrant = await server.inject({ method: "DELETE", url: `/api/agent/permissions/${grant.json().id}` });
    expect(removedGrant.statusCode).toBe(204);
  });

  it("normalizes Markdown-wrapped URLs before web verification", () => {
    expect(extractWebResearchTargets("请核实 `https://herdr.dev/docs/agent-skill/` 页面")).toEqual([
      "https://herdr.dev/docs/agent-skill/"
    ]);
  });

  it("enforces execution permissions and records the confirmation decision", async () => {
    server = createTestServer();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-execution-audit-"));
    temporaryDirectories.push(cwd);
    const denied = await server.inject({
      method: "POST",
      url: "/api/agent/permissions",
      payload: { scope: "global", decision: "deny", toolId: "execution:node", action: "read", targetPrefix: cwd }
    });
    expect(denied.statusCode).toBe(201);

    const rejected = await server.inject({
      method: "POST",
      url: "/api/execution/run",
      payload: {
        targetType: "host_trusted", runtime: "node", args: ["-e", "console.log('should not run')"], cwd,
        directoryGrants: [{ path: cwd, access: "read" }], networkPolicy: "disabled", confirmed: true, acknowledgeHostRisk: true
      }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain("拒绝");

    await server.inject({ method: "DELETE", url: `/api/agent/permissions/${denied.json().id}` });
    const completed = await server.inject({
      method: "POST",
      url: "/api/execution/run",
      payload: {
        targetType: "host_trusted", runtime: "node", args: ["-e", "process.stdout.write('ok')"], cwd,
        directoryGrants: [{ path: cwd, access: "read" }], networkPolicy: "disabled", confirmed: true, acknowledgeHostRisk: true
      }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().run).toMatchObject({ status: "completed", authorization: { confirmed: true, checks: [{ action: "read", decision: "ask" }] } });

    const allowed = await server.inject({
      method: "POST",
      url: "/api/agent/permissions",
      payload: { scope: "global", decision: "allow", toolId: "execution:node", action: "read", targetPrefix: cwd }
    });
    expect(allowed.statusCode).toBe(201);
    const missingRunConfirmation = await server.inject({
      method: "POST",
      url: "/api/execution/run",
      payload: {
        targetType: "host_trusted", runtime: "node", args: ["-e", "process.stdout.write('should not run')"], cwd,
        directoryGrants: [{ path: cwd, access: "read" }], networkPolicy: "disabled", confirmed: false, acknowledgeHostRisk: true
      }
    });
    expect(missingRunConfirmation.statusCode).toBe(400);
    expect(missingRunConfirmation.json().error).toContain("每次执行都需要重新确认");
  });

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
    // 本用例是重型端到端场景（真实临时技能目录 + 多次文件读写），本地独占实测 ~2.6s，
    // CI 2 核 runner 与整仓并行下会超过 vitest 默认 5s 预算，显式放宽超时。
  }, 30_000);

  it("stores Tavily configuration locally and can test or remove it", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
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

    const wrongContext = await server.inject({ method: "PATCH", url: `/api/article-chat/messages/${messageId}/suggestions/0`, payload: { contextKey: "source:posts/other/index.md", status: "accepted" } });
    expect(wrongContext.statusCode).toBe(404);

    const repaired = await server.inject({ method: "PATCH", url: `/api/article-chat/messages/${messageId}/suggestions/0`, payload: { contextKey, status: "pending" } });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().suggestions).toEqual([expect.objectContaining({ status: "pending" })]);

    const handled = await server.inject({ method: "PATCH", url: `/api/article-chat/messages/${messageId}/suggestions/0`, payload: { contextKey, status: "rejected" } });
    expect(handled.statusCode).toBe(200);
    expect(handled.json().suggestions).toEqual([expect.objectContaining({ status: "rejected" })]);

    const after = await server.inject({ method: "GET", url: `/api/article-chat?contextKey=${encodeURIComponent(contextKey)}` });
    expect(after.statusCode).toBe(200);
    expect(after.json().messages[0].suggestions).toEqual([expect.objectContaining({ status: "rejected" })]);
  });

  it("rejects sibling replacement suggestions when one alternative is accepted", async () => {
    server = createTestServer();
    const contextKey = "source:posts/title-options/index.md";
    const messageId = "22222222-2222-4222-8222-222222222222";
    const now = new Date().toISOString();
    const original = "# 原来的文章标题";
    database!.connection.prepare("INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, '', ?)")
      .run(contextKey, now);
    database!.connection.prepare(`INSERT INTO article_chat_messages
      (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
      VALUES (?, ?, 'assistant', ?, '', ?, ?)`)
      .run(
        messageId,
        contextKey,
        "这里有五个互斥的标题方案。",
        JSON.stringify([
          { original, replacement: "# 标题一", reason: "方案一", status: "pending" },
          { original, replacement: "# 标题二", reason: "方案二", status: "pending" },
          { original, replacement: "# 标题三", reason: "方案三", status: "pending" },
          { original, replacement: "# 标题四", reason: "方案四", status: "pending" },
          { original, replacement: "# 标题五", reason: "方案五", status: "pending" }
        ]),
        now
      );

    const accepted = await server.inject({ method: "PATCH", url: `/api/article-chat/messages/${messageId}/suggestions/3`, payload: { contextKey, status: "accepted" } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().suggestions.map((suggestion: { status: string }) => suggestion.status)).toEqual([
      "rejected", "rejected", "rejected", "accepted", "rejected"
    ]);

    const after = await server.inject({ method: "GET", url: `/api/article-chat?contextKey=${encodeURIComponent(contextKey)}` });
    expect(after.statusCode).toBe(200);
    expect(after.json().messages[0].suggestions.map((suggestion: { status: string }) => suggestion.status)).toEqual([
      "rejected", "rejected", "rejected", "accepted", "rejected"
    ]);
  });

  it("reuses a client Awen message id when a failed message is sent again", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-skills-"));
    temporaryDirectories.push(skillsDirectory);
    let modelCalls = 0;
    const fakeProvider: ModelProvider = {
      id: "test-awen-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        modelCalls += 1;
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
    const assistantMessages = database.connection.prepare("SELECT id, content FROM article_chat_messages WHERE context_key = ? AND role = 'assistant'")
      .all(payload.contextKey) as Array<{ id: string; content: string }>;
    expect(assistantMessages).toHaveLength(1);
    expect(modelCalls).toBe(1);
  });

  it("repairs a malformed final reply after a tool completed", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-workflow-final-skills-"));
    temporaryDirectories.push(skillsDirectory);
    seedSystemTool("scoop");
    let round = 0;
    const fakeProvider: ModelProvider = {
      id: "test-awen-workflow-final-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        const value = round++ === 0
          ? { kind: "tool_calls", text: null, calls: [{ toolId: "list_system_tools", action: "read", target: null, input: { query: "scoop" } }] }
          : round === 2
            ? { kind: "final", text: "工具已经完成，但这不是结构化 JSON", calls: null }
            : { kind: "final", text: JSON.stringify({ reply: "系统工具读取完成。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }), calls: null };
        return { value: request.parse(value), provider: "test-awen-workflow-final-ai", model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });

    const response = await server.inject({
      method: "POST",
      url: "/api/article-chat/messages",
      payload: {
        contextKey: "source:posts/workflow-final-failure/index.md",
        clientMessageId: "44444444-4444-4444-8444-444444444444",
        title: "工具最终回复失败",
        markdown: "正文。",
        message: "请读取系统工具并回复。",
        workflowMode: "tool"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().workflow.status, JSON.stringify(response.json().workflow.events)).toBe("completed");
    expect(response.json().workflow.events.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining(["tool_completed", "workflow_completed"]));
    expect(response.json().message.content).toContain("系统工具读取完成");
  });

  it("keeps draft assessment out of practice until Awen actually requests a practice tool", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-no-practice-skills-"));
    temporaryDirectories.push(skillsDirectory);
    const fakeProvider: ModelProvider = {
      id: "test-awen-no-practice-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        return { value: request.parse({
          kind: "final", text: JSON.stringify({ reply: "这篇基础语法文章无需实测，可直接按提纲起草。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }), calls: null
        }), provider: this.id, model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-no-practice-articles-"));
    temporaryDirectories.push(sourceDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "Markdown 标题的基本写法" } });
    const projectId = project.json().id as string;
    await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/brief`, payload: { objective: "讲清 Markdown 标题语法", audience: "Markdown 入门者", angle: "说明常见标题层级", sourceNotes: "" } });
    await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/outline`, payload: { markdown: "# Markdown 标题的基本写法\n\n## 标题层级" } });

    const started = await server.inject({ method: "POST", url: `/api/content-projects/${projectId}/practice-task/start`, payload: { goal: "按提纲准备正文；自行判断是否值得实践。" } });

    expect(started.statusCode, JSON.stringify(started.json())).toBe(200);
    expect(started.json().workflow.status).toBe("completed");
    expect(started.json().task.status).toBe("drafting");
    const events = new ArticlePracticeTaskRepository(database.connection).listEvents(started.json().task.id as string);
    expect(events.map((event) => event.kind)).toContain("assessment_started");
    expect(events.map((event) => event.kind)).not.toContain("practice_started");
    expect(events.map((event) => event.kind)).not.toContain("practice_result");
    expect(events.map((event) => event.kind)).toContain("draft_started");
  });

  it("runs an authorized Node example, carries its observation into the first draft, and links it after save", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-practice-skills-"));
    temporaryDirectories.push(skillsDirectory);
    const practiceWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-practice-workspace-"));
    temporaryDirectories.push(practiceWorkspaceRoot);
    let draftPrompt = "";
    let workflowModelTurn = 0;
    const claim = "Node.js 本机运行输出 Sample printed 42.";
    const generatedMarkdown = `# Node 示例验证\n\n${claim}\n`;
    const fakeProvider: ModelProvider = {
      id: "test-awen-practice-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        if (request.task === "revision") {
          return { value: request.parse({ associations: [{ observationIndex: 0, paragraphText: claim, support: "direct" }] }), provider: this.id, model: "test-model", usage: null };
        }
        const turn = workflowModelTurn++ === 0
          ? { kind: "tool_calls", text: null, calls: [{ toolId: "practice_run_code", action: "write", target: null, input: { runtime: "node", code: "console.log('Sample printed 42.')" } }] }
          : { kind: "final", text: JSON.stringify({ reply: claim, memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }), calls: null };
        return { value: request.parse(turn), provider: "test-awen-practice-ai", model: "test-model", usage: null };
      },
      async generateMarkdownStream(request: GenerateMarkdownStreamRequest) {
        draftPrompt = request.prompt;
        request.onDelta(generatedMarkdown);
        return { value: { markdown: generatedMarkdown }, provider: this.id, model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory, practiceWorkspaceRoot });
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-practice-articles-"));
    temporaryDirectories.push(sourceDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });

    const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "Node 示例验证" } });
    const projectId = project.json().id as string;
    await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/brief`, payload: {
      objective: "说明可验证的代码行为", audience: "开发者", angle: "通过短示例验证", sourceNotes: ""
    } });
    await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/outline`, payload: { markdown: "# Node 示例验证\n\n## 观察结果" } });

    const started = await server.inject({ method: "POST", url: `/api/content-projects/${projectId}/practice-task/start`, payload: { goal: "判断是否需要运行 Node 示例" } });
    expect(started.statusCode, JSON.stringify(started.json())).toBe(200);
    expect(started.json().workflow.status).toBe("waiting_user");
    expect(started.json().task).toMatchObject({ status: "waiting_permission", latestGoal: "判断是否需要运行 Node 示例" });
    expect(started.json().task.checkpoint.workflowId).toBe(started.json().workflow.workflowId);
    expect(new ArticlePracticeTaskRepository(database.connection).listEvents(started.json().task.id).map((event) => event.kind)).toContain("practice_started");
    const workflowId = started.json().workflow.workflowId as string;
    const completedPractice = await server.inject({ method: "POST", url: `/api/article-chat/workflows/${workflowId}/permission`, payload: { decision: "allow", scope: "run" } });
    expect(completedPractice.statusCode, JSON.stringify(completedPractice.json())).toBe(200);
    expect(completedPractice.json().workflow.status, JSON.stringify(completedPractice.json().workflow.events)).toBe("completed");
    const thread = await server.inject({ method: "GET", url: "/api/article-chat?contextKey=project:" + projectId });
    expect(thread.json().messages[0].content).toContain("文渡发起的正文起草任务");
    const practiceTaskId = started.json().task.id as string;
    const practiceTask = new ArticlePracticeTaskRepository(database.connection).require(practiceTaskId);
    const practiceResult = new ArticlePracticeTaskRepository(database.connection).listEvents(practiceTaskId).find((event) => event.kind === "practice_result");
    expect(practiceTask.status).toBe("drafting");
    expect(practiceResult?.payload.summary).toContain(claim);
    expect(JSON.stringify(practiceResult?.payload.results)).toContain('"stdout":"Sample printed 42.\\n"');
    const draft = await server.inject({ method: "POST", url: `/api/content-projects/${projectId}/draft/generate/stream`, payload: {} });
    expect(draft.statusCode).toBe(200);
    const draftComplete = parseSseCompleteEvent(draft.body);
    expect(draftComplete).toMatchObject({ markdown: generatedMarkdown });
    expect(draftPrompt).toContain(claim);
    expect(draftPrompt).toMatch(/Node\.js；版本 .+；状态 completed；退出码 0/u);
    expect(draftPrompt).not.toContain("C:\\Users\\adams");
    const savedDraft = await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/draft`, payload: { markdown: draftComplete.markdown } });
    expect(savedDraft.statusCode).toBe(200);
    const portableSources = await server.inject({ method: "GET", url: `/api/content-source/article-practice-sources?path=${encodeURIComponent(String(draftComplete.sourceRelativePath))}` });
    expect(portableSources.json().sources).toContainEqual(expect.objectContaining({ type: "practice_paragraph_link", status: "linked", claim }));
    expect(database.connection.prepare("SELECT status FROM article_practice_tasks WHERE id = ?").get(practiceTaskId)).toEqual({ status: "completed" });
  });

  it("stops an authorization-waiting practice and waits for the author's draft decision", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-stop-permission-skills-"));
    temporaryDirectories.push(skillsDirectory);
    let modelCalls = 0;
    const fakeProvider: ModelProvider = {
      id: "test-awen-stop-permission-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        modelCalls += 1;
        return { value: request.parse({
          kind: "tool_calls", text: null,
          calls: [{ toolId: "practice_run_code", action: "write", target: null, input: { runtime: "node", code: "console.log('not-yet-run')" } }]
        }), provider: this.id, model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-stop-permission-articles-"));
    temporaryDirectories.push(sourceDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "授权等待时停止实践" } });
    const projectId = project.json().id as string;
    const started = await server.inject({ method: "POST", url: "/api/article-chat/messages", payload: {
      contextKey: `project:${projectId}`, clientMessageId: "d0b8de74-bd3f-40eb-8f27-25d6a64bb19e", projectId,
      practiceIntentMode: "chat", workflowMode: "tool", title: "授权等待时停止实践", markdown: "# 授权等待时停止实践", message: "请验证这个示例。"
    } });
    expect(started.statusCode, JSON.stringify(started.json())).toBe(200);
    const workflowId = started.json().workflow.workflowId as string;
    expect(started.json().workflow.status).toBe("waiting_user");
    expect((await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/practice-task` })).json().task.status)
      .toBe("waiting_permission");

    const stoppedWorkflow = await server.inject({ method: "POST", url: `/api/article-chat/workflows/${workflowId}/cancel` });
    expect(stoppedWorkflow.statusCode, JSON.stringify(stoppedWorkflow.json())).toBe(200);
    expect(stoppedWorkflow.json().status).toBe("cancelled");
    const waitingForChoice = await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/practice-task` });
    expect(waitingForChoice.json().task).toMatchObject({ status: "waiting_stop_choice", feedbackDeadline: null });
    expect(modelCalls).toBe(1);

    const decided = await server.inject({ method: "POST", url: `/api/content-projects/${projectId}/practice-task/${waitingForChoice.json().task.id}/decision`, payload: { decision: "stop_draft" } });
    expect(decided.statusCode, JSON.stringify(decided.json())).toBe(200);
    expect(decided.json().task.status).toBe("stopped");
    expect(modelCalls).toBe(1);
  });

  it("asks before resuming after restart and restores a pending permission without replaying the call", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-resume-permission-skills-"));
    temporaryDirectories.push(skillsDirectory);
    let modelCalls = 0;
    const fakeProvider: ModelProvider = {
      id: "test-awen-resume-permission-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        modelCalls += 1;
        return { value: request.parse({
          kind: "tool_calls", text: null,
          calls: [{ toolId: "practice_run_code", action: "write", target: null, input: { runtime: "node", code: "console.log('must-not-run')" } }]
        }), provider: this.id, model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-resume-permission-articles-"));
    temporaryDirectories.push(sourceDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "重启后恢复待授权实践" } });
    const projectId = project.json().id as string;
    const started = await server.inject({ method: "POST", url: "/api/article-chat/messages", payload: {
      contextKey: `project:${projectId}`, clientMessageId: "97ba66e5-f690-4587-82f9-09ea34beb423", projectId,
      practiceIntentMode: "chat", workflowMode: "tool", title: "重启后恢复待授权实践", markdown: "# 重启后恢复待授权实践", message: "请验证这个示例。"
    } });
    expect(started.statusCode, JSON.stringify(started.json())).toBe(200);
    const workflowId = started.json().workflow.workflowId as string;
    expect(started.json().workflow.status).toBe("waiting_user");
    expect(modelCalls).toBe(1);

    await server.close();
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const interrupted = await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/practice-task` });
    expect(interrupted.json().task).toMatchObject({ status: "waiting_resume_choice", resumeStatus: "waiting_permission" });
    expect(modelCalls).toBe(1);

    const taskId = interrupted.json().task.id as string;
    const resumedTask = await server.inject({ method: "POST", url: `/api/content-projects/${projectId}/practice-task/${taskId}/decision`, payload: { decision: "resume" } });
    expect(resumedTask.json()).toMatchObject({ task: { status: "waiting_permission" }, needsReconciliation: false });
    const resumedWorkflow = await server.inject({ method: "POST", url: `/api/article-chat/workflows/${workflowId}/resume` });
    expect(resumedWorkflow.statusCode, JSON.stringify(resumedWorkflow.json())).toBe(200);
    expect(resumedWorkflow.json().workflow).toMatchObject({ status: "waiting_user", pendingPermission: { callId: expect.any(String) } });
    expect(resumedWorkflow.json().workflow.events.map((event: { type: string }) => event.type)).toContain("permission_requested");
    expect(modelCalls).toBe(1);
  });

  it("does not require a legacy practice plan to draft, but preserves active practice decisions", async () => {
    const fakeProvider: ModelProvider = {
      id: "test-draft-without-plan",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        const value = request.task === "revision" ? { associations: [] } : { markdown: "# 直接起草\n\n正文内容。" };
        return { value: request.parse(value), provider: this.id, model: "test-model", usage: null };
      }
    };
    server = createTestServer(fakeProvider);
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-draft-no-plan-"));
    temporaryDirectories.push(sourceDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    const createReadyProject = async (topic: string): Promise<string> => {
      const response = await server!.inject({ method: "POST", url: "/api/content-projects", payload: { topic } });
      const projectId = response.json().id as string;
      await server!.inject({ method: "PUT", url: `/api/content-projects/${projectId}/brief`, payload: {
        objective: "写清实际观察", audience: "读者", angle: "以事实为依据", sourceNotes: ""
      } });
      await server!.inject({ method: "PUT", url: `/api/content-projects/${projectId}/outline`, payload: { markdown: `# ${topic}\n\n## 观察` } });
      return projectId;
    };

    const withoutPlanProject = await createReadyProject("无需旧计划");
    const plan = await server.inject({ method: "GET", url: `/api/content-projects/${withoutPlanProject}/practice-plan` });
    expect(plan.json()).toBeNull();
    const draft = await server.inject({ method: "POST", url: `/api/content-projects/${withoutPlanProject}/draft/generate`, payload: {} });
    expect(draft.statusCode, JSON.stringify(draft.json())).toBe(200);

    const waitingProject = await createReadyProject("等待作者选择");
    const taskRepository = new ArticlePracticeTaskRepository(database!.connection);
    const task = taskRepository.create(waitingProject, "需要作者决定的验证");
    taskRepository.beginAssessment(task.id);
    taskRepository.beginPractice(task.id);
    taskRepository.waitForFeedback(task.id, "等待作者提供新的实践指示");
    const blocked = await server.inject({ method: "POST", url: `/api/content-projects/${waitingProject}/draft/generate`, payload: {} });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toContain("待处理选择");
  });

  it("links only unique, directly supported first-draft paragraphs to practice observations", async () => {
    database = openInMemoryDatabase();
    const draftMarkdown = "# 逐段匹配\n\n本次示例运行输出 verified: 42。\n\n这是一段重复观察正文。\n\n这是一段重复观察正文。\n";
    const providerTasks: string[] = [];
    const fakeProvider: ModelProvider = {
      id: "test-practice-source-map",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        providerTasks.push(request.task);
        const value = request.task === "revision"
          ? { associations: [
            { observationIndex: 0, paragraphText: "本次示例运行输出 verified: 42。", support: "direct" },
            { observationIndex: 0, paragraphText: "这是一段重复观察正文。", support: "direct" }
          ] }
          : { markdown: draftMarkdown };
        return { value: request.parse(value), provider: this.id, model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider);
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-practice-source-map-"));
    temporaryDirectories.push(sourceDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    const projectResponse = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "逐段匹配" } });
    const projectId = projectResponse.json().id as string;
    await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/brief`, payload: {
      objective: "验证正文主张", audience: "读者", angle: "短示例实测", sourceNotes: ""
    } });
    await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/outline`, payload: { markdown: "# 逐段匹配\n\n## 实测" } });
    const tasks = new ArticlePracticeTaskRepository(database.connection);
    const task = tasks.create(projectId, "运行 Node 示例并记录输出");
    tasks.beginAssessment(task.id);
    tasks.beginPractice(task.id);
    tasks.recordPracticeResult(task.id, { summary: JSON.stringify({ reply: "本次运行输出 verified: 42。" }), results: [] });
    tasks.beginDraft(task.id);

    const generated = await server.inject({ method: "POST", url: `/api/content-projects/${projectId}/draft/generate` });
    expect(generated.statusCode, JSON.stringify(generated.json())).toBe(200);
    expect(providerTasks).toContain("revision");
    expect(generated.json().markdown).toBe(draftMarkdown.trimEnd());
    await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/draft`, payload: { markdown: draftMarkdown } });
    const sources = await server.inject({ method: "GET", url: `/api/content-source/article-practice-sources?path=${encodeURIComponent(generated.json().sourceRelativePath)}` });
    expect(sources.json().sources).toContainEqual(expect.objectContaining({ type: "practice_paragraph_link", status: "linked", claim: "本次运行输出 verified: 42。" }));
    expect(sources.json().sources).toContainEqual(expect.objectContaining({ type: "practice_observation", status: "pending_review" }));
    expect(sources.json().sources.filter((source: { type: string }) => source.type === "practice_paragraph_link")).toHaveLength(1);

    const changed = await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/draft`, payload: { markdown: draftMarkdown.replace("本次示例运行输出 verified: 42。", "本次示例运行输出 verified: 99。") } });
    expect(changed.statusCode).toBe(200);
    const revisedSources = await server.inject({ method: "GET", url: `/api/content-source/article-practice-sources?path=${encodeURIComponent(generated.json().sourceRelativePath)}` });
    expect(revisedSources.json().sources).toContainEqual(expect.objectContaining({ type: "practice_paragraph_link", status: "pending_review" }));
  });

  it("reconnects an edited paragraph when the practice claim remains directly supported", async () => {
    database = openInMemoryDatabase();
    const originalParagraph = "实测后确认，示例可以正常生成结果。";
    const editedParagraph = "在本次 Windows 环境运行后，示例成功生成预期结果。";
    const conflictingParagraph = "本次运行未能生成预期结果。";
    const fakeProvider: ModelProvider = {
      id: "test-practice-source-reconnect",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        const value = request.task === "revision"
          ? { associations: [{ observationIndex: 0, paragraphText: request.prompt.includes(conflictingParagraph) ? conflictingParagraph : editedParagraph, support: request.prompt.includes(conflictingParagraph) ? "partial" : "direct" }] }
          : { markdown: "# 编辑段落来源重连" };
        return { value: request.parse(value), provider: this.id, model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider);
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-practice-source-reconnect-"));
    temporaryDirectories.push(sourceDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    const projectResponse = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "编辑段落来源重连" } });
    const projectId = projectResponse.json().id as string;
    await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/brief`, payload: {
      objective: "保留实践来源", audience: "读者", angle: "依据与结论一致", sourceNotes: ""
    } });
    await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/outline`, payload: { markdown: "# 编辑段落来源重连\n\n## 实测" } });
    const initialDraft = await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/draft`, payload: { markdown: `# 编辑段落来源重连\n\n${originalParagraph}` } });
    const task = new ArticlePracticeTaskRepository(database.connection).create(projectId, "验证示例输出");
    const tasks = new ArticlePracticeTaskRepository(database.connection);
    tasks.beginAssessment(task.id);
    tasks.beginPractice(task.id);
    tasks.recordPracticeResult(task.id, { summary: JSON.stringify({ reply: "示例运行成功并输出预期结果。" }), results: [] });
    const linked = await server.inject({ method: "POST", url: `/api/content-projects/${projectId}/practice-task/${task.id}/source-link`, payload: { paragraphText: originalParagraph } });
    expect(linked.statusCode, JSON.stringify(linked.json())).toBe(200);

    const editedDraft = await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/draft`, payload: { markdown: `# 编辑段落来源重连\n\n${editedParagraph}` } });
    expect(editedDraft.statusCode, JSON.stringify(editedDraft.json())).toBe(200);
    const sources = await server.inject({ method: "GET", url: `/api/content-source/article-practice-sources?path=${encodeURIComponent(initialDraft.json().sourceRelativePath)}` });
    expect(sources.json().sources).toContainEqual(expect.objectContaining({
      type: "practice_paragraph_link", status: "linked", claim: "示例运行成功并输出预期结果。"
    }));
    expect(sources.json().sources.filter((source: { type: string }) => source.type === "practice_paragraph_link")).toHaveLength(1);

    const conflictingDraft = await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/draft`, payload: { markdown: `# 编辑段落来源重连\n\n${conflictingParagraph}` } });
    expect(conflictingDraft.statusCode).toBe(200);
    const conflictingSources = await server.inject({ method: "GET", url: `/api/content-source/article-practice-sources?path=${encodeURIComponent(initialDraft.json().sourceRelativePath)}` });
    expect(conflictingSources.json().sources).toContainEqual(expect.objectContaining({
      type: "practice_paragraph_link", status: "pending_review", claim: "示例运行成功并输出预期结果。"
    }));
  });

  it("routes the author's failure guidance back into the active practice task", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-feedback-skills-"));
    temporaryDirectories.push(skillsDirectory);
    const fakeProvider: ModelProvider = {
      id: "test-awen-practice-feedback-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        const turn = {
          kind: "final",
          text: JSON.stringify({ reply: "已按你的补充要求改用 Node 验证，无需进一步操作。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }),
          calls: null
        };
        return { value: request.parse(turn), provider: this.id, model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-practice-feedback-articles-"));
    temporaryDirectories.push(sourceDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    const projectResponse = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "失败反馈续做" } });
    const projectId = projectResponse.json().id as string;
    const tasks = new ArticlePracticeTaskRepository(database.connection);
    const task = tasks.create(projectId, "验证示例行为");
    tasks.beginAssessment(task.id);
    tasks.beginPractice(task.id);
    tasks.waitForFeedback(task.id, "首次运行失败");

    const response = await server.inject({ method: "POST", url: "/api/article-chat/messages", payload: {
      contextKey: `project:${projectId}`, clientMessageId: "8a6e5f2a-b05d-4df7-a522-d2ccf6da9dc3", projectId,
      practiceTaskId: task.id, continuePracticeAfterFeedback: true, workflowMode: "tool", title: "失败反馈续做",
      markdown: "# 失败反馈续做\n\n## 验证", message: "请改用已经安装的 Node 重试。"
    } });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    expect(response.json().workflow.status).toBe("completed");
    expect(tasks.require(task.id)).toMatchObject({ status: "drafting", latestGoal: "请改用已经安装的 Node 重试。", goalRevision: 2 });
    expect(tasks.listEvents(task.id).map((event) => event.kind)).toContain("feedback_received");
  });

  it("gives Awen the failed and completed step identities for an explicit retry without replaying the old workflow", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-step-retry-skills-"));
    temporaryDirectories.push(skillsDirectory);
    let retryPrompt = "";
    const fakeProvider: ModelProvider = {
      id: "test-awen-step-retry-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        retryPrompt = request.prompt;
        const turn = {
          kind: "final",
          text: JSON.stringify({ reply: "我会只重新检查失败步骤。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }),
          calls: null
        };
        return { value: request.parse(turn), provider: this.id, model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-practice-step-retry-articles-"));
    temporaryDirectories.push(sourceDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    const projectResponse = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "失败步骤重试" } });
    const projectId = projectResponse.json().id as string;
    const contextKey = `project:${projectId}`;
    const tasks = new ArticlePracticeTaskRepository(database.connection);
    let task = tasks.create(projectId, "验证示例行为");
    tasks.beginAssessment(task.id);
    tasks.beginPractice(task.id);
    const workflowId = "a84f6cc8-cf01-4d62-89d8-145c10d4f100";
    task = tasks.saveCheckpoint(task.id, { workflowId, stepId: "awen-tool-workflow" });
    tasks.waitForFeedback(task.id, "上一次运行失败");
    const failedWorkflow: ToolWorkflowSnapshot = {
      workflowId, status: "failed", round: 2, userRequest: "验证示例行为",
      transcript: [
        { role: "user", content: "验证示例行为" },
        { role: "tool", content: "practice_run_code：执行失败：模拟错误 /private/path" }
      ],
      events: [
        { id: "event-1", type: "tool_completed", at: "2026-09-25T00:00:01.000Z", message: "工具完成", data: { callId: "call-1", toolId: "list_system_tools" } },
        { id: "event-2", type: "tool_failed", at: "2026-09-25T00:00:02.000Z", message: "模拟错误 /private/path", data: { callId: "call-2", toolId: "practice_run_code" } },
        { id: "event-3", type: "workflow_failed", at: "2026-09-25T00:00:03.000Z", message: "已结束" }
      ],
      toolResults: [{ callId: "call-1", toolId: "list_system_tools", output: { python: "3.13" } }],
      pendingPermission: null, finalText: null, warningCount: 1
    };
    new ToolWorkflowRepository(database.connection).save(failedWorkflow, {
      contextKey, projectId, request: { contextKey, projectId, practiceTaskId: task.id }
    });

    const response = await server.inject({ method: "POST", url: "/api/article-chat/messages", payload: {
      contextKey, clientMessageId: "deba616f-eaf3-4f0f-ae65-40eaade8b17a", projectId,
      practiceTaskId: task.id, continuePracticeAfterFeedback: true, workflowMode: "tool", title: "失败步骤重试",
      markdown: "# 失败步骤重试\n\n验证目标。", message: "请只重试上一次实践中失败的步骤。"
    } });

    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    expect(retryPrompt).toContain("上一次失败的工具步骤：practice_run_code");
    expect(retryPrompt).toContain("此前已完成的工具步骤：list_system_tools");
    expect(retryPrompt).toContain("这些步骤及其结果已保留，不要重复执行");
    expect(retryPrompt).not.toContain("/private/path");
    expect(response.json().workflow.status).toBe("completed");
    expect(tasks.require(task.id).status).toBe("drafting");
  });

  it("creates a practice task from an editor chat only when Awen requests code and waits for the article suggestion decision", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-editor-practice-skills-"));
    temporaryDirectories.push(skillsDirectory);
    seedSystemTool("scoop");
    let modelTurn = 0;
    const fakeProvider: ModelProvider = {
      id: "test-awen-editor-practice-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        const turns: unknown[] = [
          { kind: "tool_calls", text: null, calls: [{ toolId: "list_system_tools", action: "read", target: null, input: { query: "scoop" } }] },
          { kind: "tool_calls", text: null, calls: [{ toolId: "practice_run_code", action: "write", target: null, input: { runtime: "node", code: "console.log('verified: 42')" } }] },
          { kind: "final", text: JSON.stringify({
            reply: "Node 实测输出 verified: 42；我把运行条件整理成一条正文建议，请确认是否应用。",
            memorySuggestion: "", writingMemorySuggestion: "",
            suggestions: [{ original: "当前正文包含一个待验证行为。", replacement: "当前正文包含一个待验证行为。Node.js 本机运行示例输出 verified: 42；该结果仅适用于这段示例和本次运行环境。", reason: "补入本次可复现的验证结果与适用条件。", kind: "content", operation: "insert_after" }],
            imageSearchRequest: null
          }), calls: null }
        ];
        const turn = turns[modelTurn++];
        return { value: request.parse(turn), provider: this.id, model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-practice-editor-articles-"));
    temporaryDirectories.push(sourceDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    const projectResponse = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "正文验证建议" } });
    const projectId = projectResponse.json().id as string;
    const markdown = "# 正文验证建议\n\n当前正文包含一个待验证行为。";
    const started = await server.inject({ method: "POST", url: "/api/article-chat/messages", payload: {
      contextKey: `project:${projectId}`, clientMessageId: "f98ce1a7-9340-41c4-804d-96fb8e1744c0", projectId,
      practiceIntentMode: "chat", workflowMode: "tool", title: "正文验证建议", markdown, message: "请用 Node 实测这段行为。"
    } });
    expect(started.statusCode, JSON.stringify(started.json())).toBe(200);
    expect(started.json().workflow.status).toBe("waiting_user");
    const waiting = await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/practice-task` });
    const taskId = waiting.json().task.id as string;
    expect(waiting.json().task).toMatchObject({ status: "waiting_permission", latestGoal: "请用 Node 实测这段行为。", checkpoint: { workflowId: started.json().workflow.workflowId } });

    const completed = await server.inject({ method: "POST", url: `/api/article-chat/workflows/${started.json().workflow.workflowId}/permission`, payload: { decision: "allow", scope: "run" } });
    expect(completed.statusCode, JSON.stringify(completed.json())).toBe(200);
    expect(completed.json().workflow.status, JSON.stringify(completed.json().workflow.events)).toBe("completed");
    const task = await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/practice-task` });
    expect(task.json().task).toMatchObject({ id: taskId, status: "waiting_edit_confirmation" });
    const thread = await server.inject({ method: "GET", url: `/api/article-chat?contextKey=${encodeURIComponent(`project:${projectId}`)}` });
    expect(thread.json().messages.at(-1).suggestions[0]).toMatchObject({ operation: "insert_after", original: "当前正文包含一个待验证行为。", practiceTaskId: taskId });

    const acceptedParagraph = "当前正文包含一个待验证行为。Node.js 本机运行示例输出 verified: 42；该结果仅适用于这段示例和本次运行环境。";
    const project = projectResponse.json() as { sourceRelativePath: string };
    await server.inject({ method: "PUT", url: "/api/content-source/article", payload: { path: project.sourceRelativePath, markdown: `# 正文验证建议\n\n当前正文包含一个待验证行为。\n\n${acceptedParagraph}` } });
    const sourceLink = await server.inject({ method: "POST", url: `/api/content-projects/${projectId}/practice-task/${taskId}/source-link`, payload: { paragraphText: acceptedParagraph } });
    expect(sourceLink.statusCode, JSON.stringify(sourceLink.json())).toBe(200);
    expect(sourceLink.json().source).toMatchObject({ type: "practice_paragraph_link", status: "linked", paragraphSha256: expect.any(String) });
    expect(JSON.stringify(sourceLink.json())).not.toContain(acceptedParagraph);
    const portableSources = await server.inject({ method: "GET", url: `/api/content-source/article-practice-sources?path=${encodeURIComponent(project.sourceRelativePath)}` });
    expect(portableSources.json().sources).toContainEqual(expect.objectContaining({ type: "practice_paragraph_link", status: "linked", paragraphSha256: expect.any(String) }));
    expect(JSON.stringify(portableSources.json())).not.toContain(acceptedParagraph);

    const confirmed = await server.inject({ method: "POST", url: `/api/content-projects/${projectId}/practice-task/${taskId}/decision`, payload: { decision: "edit_confirmed" } });
    expect(confirmed.json().task.status).toBe("completed");
    const history = await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/practice-task/history` });
    expect(history.statusCode).toBe(200);
    expect(history.json().tasks[0]).toMatchObject({ id: taskId, status: "completed", latestGoal: "请用 Node 实测这段行为。" });
    expect(history.json().tasks[0].events.at(-1)).toMatchObject({ kind: "edit_suggestion_accepted" });

    const legacyRunId = "a1111111-1111-4111-8111-111111111111";
    database.connection.prepare(`INSERT INTO execution_runs
      (id, project_id, request_json, preflight_json, status, exit_code, stdout, stderr, created_at, finished_at)
      VALUES (?, ?, ?, ?, 'completed', 0, 'old output', '', ?, ?)`)
      .run(legacyRunId, projectId, JSON.stringify({ runtime: "node", targetType: "host_trusted", cwd: "C:\\private\\project", args: ["private code"] }),
        JSON.stringify({ available: true, targetType: "host_trusted", executable: "node", resolvedCwd: "C:\\private\\project", warnings: [] }),
        "2026-09-20T10:00:00.000Z", "2026-09-20T10:00:01.000Z");
    database.connection.prepare(`INSERT INTO experimental_observations
      (id, project_id, execution_run_id, title, claim, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run("b1111111-1111-4111-8111-111111111111", projectId, legacyRunId, "旧实验观察", "旧记录中的观察结论", "2026-09-20T10:00:01.000Z", "2026-09-20T10:00:01.000Z");
    const legacyHistory = await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/practice-task/legacy-executions` });
    expect(legacyHistory.statusCode).toBe(200);
    const legacyRunSummary = legacyHistory.json().items.find((item: { id: string }) => item.id === legacyRunId);
    expect(legacyRunSummary).toMatchObject({ id: legacyRunId, runtime: "node", targetType: "host_trusted", status: "completed", observation: { id: "b1111111-1111-4111-8111-111111111111", claim: "旧记录中的观察结论", status: "pending" } });
    expect(JSON.stringify(legacyHistory.json())).not.toContain("private");
    expect(legacyRunSummary).not.toHaveProperty("stdout");
    const legacyDetails = await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/practice-task/legacy-executions/${legacyRunId}` });
    expect(legacyDetails.statusCode).toBe(200);
    expect(legacyDetails.json()).toMatchObject({ id: legacyRunId, stdout: "old output", artifacts: [] });
  });

  it("starts an independent practice while an earlier editor suggestion awaits article save", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-independent-editor-practice-skills-"));
    temporaryDirectories.push(skillsDirectory);
    let turn = 0;
    const fakeProvider: ModelProvider = {
      id: "test-awen-independent-editor-practice-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        const outputs: unknown[] = [
          { kind: "tool_calls", text: null, calls: [{
            toolId: "practice_run_code", action: "write", target: null,
            input: { runtime: "node", code: "console.log('independent-practice')" }
          }] },
          { kind: "final", text: JSON.stringify({ reply: "已开始独立实践。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
        ];
        const value = request.parse(outputs[turn++]);
        return { value, provider: this.id, model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-independent-editor-articles-"));
    temporaryDirectories.push(sourceDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    const projectResponse = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "独立实践任务" } });
    const projectId = projectResponse.json().id as string;
    const tasks = new ArticlePracticeTaskRepository(database.connection);
    let earlier = tasks.create(projectId, "把已有实践建议保存到文章");
    earlier = tasks.beginAssessment(earlier.id);
    earlier = tasks.beginPractice(earlier.id);
    earlier = tasks.beginDraft(earlier.id);
    earlier = tasks.waitForEditConfirmation(earlier.id, "already-applied-suggestion");

    const started = await server.inject({ method: "POST", url: "/api/article-chat/messages", payload: {
      contextKey: `project:${projectId}`, clientMessageId: "7ad19002-e7d4-4a40-9d7d-f2a6fcaed2ee", projectId,
      practiceIntentMode: "chat", workflowMode: "tool", title: "独立实践任务",
      markdown: "# 独立实践任务\n\n当前正文保留此前的实践建议。", message: "请在本机验证另一个无关目标。"
    } });

    expect(started.statusCode, JSON.stringify(started.json())).toBe(200);
    expect(started.json().workflow.status).toBe("waiting_user");
    expect(started.json().workflow.events.map((event: { type: string }) => event.type)).not.toContain("tool_deferred");
    const active = tasks.findActive(projectId);
    expect(active).toMatchObject({ status: "waiting_permission", latestGoal: "请在本机验证另一个无关目标。" });
    expect(active?.id).not.toBe(earlier.id);
    expect(tasks.require(earlier.id)).toMatchObject({ status: "waiting_edit_confirmation", latestGoal: "把已有实践建议保存到文章", goalRevision: 1 });
  });

  it("appends a new editor practice request to the existing task while it is in the drafting stage", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-editor-followup-skills-"));
    temporaryDirectories.push(skillsDirectory);
    let modelTurn = 0;
    const prompts: string[] = [];
    const fakeProvider: ModelProvider = {
      id: "test-awen-editor-followup-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        prompts.push(request.prompt);
        const turns: unknown[] = [
          { kind: "tool_calls", text: null, calls: [{ toolId: "practice_run_code", action: "write", target: null, input: { runtime: "node", code: "console.log('edge: verified')" } }] },
          { kind: "tool_calls", text: null, calls: [{ toolId: "practice_run_code", action: "write", target: null, input: { runtime: "node", code: "console.log('second-check')" } }] },
          { kind: "final", text: JSON.stringify({
            reply: "新目标已记录；请先处理当前授权，之后继续验证。",
            memorySuggestion: "", writingMemorySuggestion: "",
            suggestions: [],
            imageSearchRequest: null
          }), calls: null },
          { kind: "final", text: JSON.stringify({
            reply: "已完成补充验证，下面是建议插入正文的内容。",
            memorySuggestion: "", writingMemorySuggestion: "",
            suggestions: [{ original: "文章结论仍待补充边界条件。", replacement: "文章结论仍待补充边界条件。补测结果为 edge: verified。", reason: "补充这轮验证结果。", kind: "content", operation: "insert_after" }],
            imageSearchRequest: null
          }), calls: null }
        ];
        return { value: request.parse(turns[modelTurn++]), provider: this.id, model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-editor-followup-articles-"));
    temporaryDirectories.push(sourceDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    const projectResponse = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "编辑阶段追加实践" } });
    const projectId = projectResponse.json().id as string;
    const tasks = new ArticlePracticeTaskRepository(database.connection);
    const original = tasks.create(projectId, "起草前验证主要结论");
    tasks.beginAssessment(original.id);
    tasks.beginPractice(original.id);
    tasks.beginDraft(original.id);

    const markdown = "# 编辑阶段追加实践\n\n文章结论仍待补充边界条件。";
    const started = await server.inject({ method: "POST", url: "/api/article-chat/messages", payload: {
      contextKey: `project:${projectId}`, clientMessageId: "24e8a792-0b65-46c4-a986-6d0aeb3d47fb", projectId,
      practiceIntentMode: "chat", workflowMode: "tool", title: "编辑阶段追加实践", markdown, message: "再测一下边界输入，并把结果建议加到合适段落。"
    } });

    expect(started.statusCode, JSON.stringify(started.json())).toBe(200);
    expect(started.json().workflow.status).toBe("waiting_user");
    const active = tasks.findActive(projectId);
    expect(active).toMatchObject({ id: original.id, status: "waiting_permission", latestGoal: "再测一下边界输入，并把结果建议加到合适段落。", goalRevision: 2 });
    const activity = await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/practice-task` });
    expect(activity.json().task.events.map((event: { kind: string }) => event.kind)).toContain("goal_added");

    const queuedGoal = await server.inject({ method: "POST", url: "/api/article-chat/messages", payload: {
      contextKey: `project:${projectId}`, clientMessageId: "b580c571-447f-4831-900b-9f171f444e2a", projectId,
      practiceIntentMode: "chat", workflowMode: "tool", title: "编辑阶段追加实践", markdown,
      message: "当前授权处理完后，再检查另一个兼容性边界。"
    } });
    expect(queuedGoal.statusCode, JSON.stringify(queuedGoal.json())).toBe(200);
    expect(queuedGoal.json().workflow.status).toBe("completed");
    expect(queuedGoal.json().workflow.events.map((event: { type: string }) => event.type)).toContain("tool_deferred");
    expect(tasks.require(original.id)).toMatchObject({ status: "waiting_permission", latestGoal: "当前授权处理完后，再检查另一个兼容性边界。", goalRevision: 3 });
    expect(tasks.require(original.id).checkpoint.workflowId).toBe(started.json().workflow.workflowId);

    const completed = await server.inject({ method: "POST", url: `/api/article-chat/workflows/${started.json().workflow.workflowId}/permission`, payload: { decision: "allow", scope: "run" } });
    expect(completed.statusCode, JSON.stringify(completed.json())).toBe(200);
    expect(completed.json().workflow.status).toBe("completed");
    expect(tasks.require(original.id).status).toBe("waiting_edit_confirmation");
    expect(prompts.at(-1)).toContain("新增实践目标：当前授权处理完后，再检查另一个兼容性边界。");
    const thread = await server.inject({ method: "GET", url: `/api/article-chat?contextKey=${encodeURIComponent(`project:${projectId}`)}` });
    expect(thread.json().messages.at(-1).suggestions[0]).toMatchObject({ operation: "insert_after", practiceTaskId: original.id });
    expect(tasks.listEvents(original.id).map((event) => event.kind)).toContain("additional_practice_started");
  });

  it("treats a new chat validation request as the user's choice to continue after stopping practice", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-stop-new-goal-skills-"));
    temporaryDirectories.push(skillsDirectory);
    let turn = 0;
    const fakeProvider: ModelProvider = {
      id: "test-awen-stop-new-goal-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        const outputs: unknown[] = [
          { kind: "tool_calls", text: null, calls: [{ toolId: "practice_run_code", action: "write", target: null, input: { runtime: "node", code: "console.log('new-goal-ran')" } }] },
          { kind: "final", text: JSON.stringify({
            reply: "已按你的新要求验证，并整理了正文建议。", memorySuggestion: "", writingMemorySuggestion: "",
            suggestions: [{ original: "这个行为仍待验证。", replacement: "这个行为经新一轮实践确认。", reason: "回应停止后的新验证要求。", kind: "content", operation: "replace" }],
            imageSearchRequest: null
          }), calls: null }
        ];
        return { value: request.parse(outputs[turn++]), provider: this.id, model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-stop-new-goal-articles-"));
    temporaryDirectories.push(sourceDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "停止后的新验证" } });
    const projectId = project.json().id as string;
    const tasks = new ArticlePracticeTaskRepository(database.connection);
    let task = tasks.create(projectId, "第一轮目标");
    task = tasks.beginAssessment(task.id);
    task = tasks.beginPractice(task.id);
    task = tasks.requestStop(task.id);

    const started = await server.inject({ method: "POST", url: "/api/article-chat/messages", payload: {
      contextKey: `project:${projectId}`, clientMessageId: "def97d9a-42ed-47a7-bdab-9bbf6000130f", projectId,
      practiceIntentMode: "chat", workflowMode: "tool", title: "停止后的新验证", markdown: "# 停止后的新验证\n\n这个行为仍待验证。",
      message: "请按新目标继续验证另一个边界。"
    } });

    expect(started.statusCode, JSON.stringify(started.json())).toBe(200);
    expect(tasks.require(task.id)).toMatchObject({ status: "waiting_permission", latestGoal: "请按新目标继续验证另一个边界。", goalRevision: 2 });
    expect(tasks.listEvents(task.id).find((event) => event.kind === "stop_choice")).toMatchObject({ payload: { choice: "new_goal" } });
    const completed = await server.inject({ method: "POST", url: `/api/article-chat/workflows/${started.json().workflow.workflowId}/permission`, payload: { decision: "allow", scope: "run" } });
    expect(completed.statusCode, JSON.stringify(completed.json())).toBe(200);
    expect(tasks.require(task.id).status).toBe("waiting_edit_confirmation");
  });

  it("authorizes task-scoped edits to an associated existing project file and can restore them", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-project-edit-skills-"));
    temporaryDirectories.push(skillsDirectory);
    let turn = 0;
    const fakeProvider: ModelProvider = {
      id: "test-awen-project-edit-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        const expectedSha256 = createHash("sha256").update("console.log('before');\\n").digest("hex");
        const outputs: unknown[] = [
          { kind: "tool_calls", text: null, calls: [{ toolId: "practice_read_project_file", action: "read", target: "ignored", input: { relativePath: "src/example.js" } }] },
          { kind: "tool_calls", text: null, calls: [{ toolId: "practice_edit_project_file", action: "write", target: "ignored", input: { relativePath: "src/example.js", content: "console.log('updated');\\n", expectedSha256 } }] },
          { kind: "final", text: JSON.stringify({ reply: "已修改示例文件并保留恢复记录。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: null }) }
        ];
        return { value: request.parse(outputs[turn++]), provider: this.id, model: "test-model", usage: null };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-project-edit-articles-"));
    const codeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-project-edit-code-"));
    temporaryDirectories.push(sourceDirectory, codeDirectory);
    await server.inject({ method: "PUT", url: "/api/content-source", payload: { rootPath: sourceDirectory } });
    fs.mkdirSync(path.join(codeDirectory, "src"));
    const targetFile = path.join(codeDirectory, "src", "example.js");
    fs.writeFileSync(targetFile, "console.log('before');\\n", "utf8");
    const projectResponse = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "关联代码文件修改" } });
    const projectId = projectResponse.json().id as string;
    await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/practice-directory`, payload: { directory: codeDirectory } });

    const started = await server.inject({ method: "POST", url: "/api/article-chat/messages", payload: {
      contextKey: `project:${projectId}`, clientMessageId: "b05d8cb7-6947-4210-a44d-68571731094b", projectId,
      practiceIntentMode: "chat", workflowMode: "tool", title: "关联代码文件修改", markdown: "# 关联代码文件修改", message: "请修改 src/example.js"
    } });
    expect(started.statusCode, JSON.stringify(started.json())).toBe(200);
    expect(started.json().workflow.status).toBe("waiting_user");
    expect(started.json().workflow.pendingPermission.request.toolId).toBe("practice_edit_project_file");
    expect(fs.readFileSync(targetFile, "utf8")).toBe("console.log('before');\\n");

    const completed = await server.inject({ method: "POST", url: `/api/article-chat/workflows/${started.json().workflow.workflowId}/permission`, payload: { decision: "allow", scope: "task" } });
    expect(completed.statusCode, JSON.stringify(completed.json())).toBe(200);
    expect(completed.json().workflow.status, JSON.stringify(completed.json().workflow)).toBe("completed");
    expect(fs.readFileSync(targetFile, "utf8")).toBe("console.log('updated');\\n");
    const change = completed.json().workflow.toolResults.find((item: { toolId: string }) => item.toolId === "practice_edit_project_file").output;
    expect(change).toMatchObject({ relativePath: "src/example.js", diff: { before: "console.log('before');\\n", after: "console.log('updated');\\n" } });
    expect(JSON.stringify(change)).not.toContain("backupPath");

    const taskId = (database!.connection.prepare("SELECT id FROM article_practice_tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 1").get(projectId) as { id: string }).id;
    const restored = await server.inject({ method: "POST", url: `/api/content-projects/${projectId}/practice-task/${taskId}/project-file-changes/${change.id}/restore` });
    expect(restored.statusCode, JSON.stringify(restored.json())).toBe(200);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("console.log('before');\\n");
  });

  it("preloads requested web pages into the Awen prompt", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-web-skills-"));
    temporaryDirectories.push(skillsDirectory);
    const prompts: string[] = [];
    const fakeProvider: ModelProvider = {
      id: "test-awen-web-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        prompts.push(request.prompt);
        return {
          value: request.parse({ reply: "已根据应用抓取的资料核对。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [] }),
          provider: "test-awen-web-ai",
          model: "test-model",
          usage: null
        };
      }
    };
    const webSearch: WebSearchClient = {
      activeProviderId: null,
      search: vi.fn(async () => []),
      extract: vi.fn(async (url) => ({ content: `官方页面正文：${url} 支持 Agent Skill。` }))
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory, webSearch });

    const response = await server.inject({
      method: "POST",
      url: "/api/article-chat/messages",
      payload: {
        contextKey: "source:posts/web-check/index.md",
        title: "联网核验测试",
        markdown: "正文中提到 https://herdr.dev/docs/agent-skill/。",
        message: "请重新核实官方页面 https://herdr.dev/docs/agent-skill/"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(webSearch.extract).toHaveBeenCalledWith("https://herdr.dev/docs/agent-skill/");
    expect(prompts.some((prompt) => prompt.includes("官方页面正文：https://herdr.dev/docs/agent-skill/"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("应用侧联网核验结果"))).toBe(true);
  });

  it("lets Awen use the structured image search request and persists candidates in history", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-images-skills-"));
    temporaryDirectories.push(skillsDirectory);
    const fakeProvider: ModelProvider = {
      id: "test-awen-image-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        if (request.prompt.includes("请为文章配图候选推荐插入位置")) {
          return {
            value: request.parse({ placements: [
              { imageUrl: "https://images.example.test/tmux.png", position: "after", anchor: "这是一段足够长的正文，用来测试图片推荐位置。", reason: "候选说明与该段主题一致。", rank: 1 }
            ] }),
            provider: "test-awen-image-ai",
            model: "test-model",
            usage: null
          };
        }
        const outputSchema = request.outputSchema as {
          properties?: {
            imageSearchRequest?: {
              anyOf?: Array<{ required?: string[] }>;
            };
          };
        };
        expect(outputSchema.properties?.imageSearchRequest?.anyOf?.[0]?.required).toEqual(["query", "limit"]);
        return {
          value: request.parse({ reply: "我会先检索候选。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: { query: "tmux multiple panes screenshot", limit: 6 } }),
          provider: "test-awen-image-ai",
          model: "test-model",
          usage: null
        };
      },
      async reviewImage<T>(request: ReviewImageRequest<T>) {
        expect(fs.existsSync(request.imagePath)).toBe(true);
        return {
          value: request.parse({ decision: "accept", score: 0.96, reason: "图片内容与 tmux 多 pane 运行场景匹配。" }),
          provider: "test-awen-image-ai",
          model: "test-model",
          usage: null
        };
      }
    };
    const searchImages = vi.fn(async () => [{
      imageUrl: "https://images.example.test/recorder.png",
      thumbnailUrl: "https://images.example.test/recorder-thumb.png",
      caption: "Skill Recorder 操作界面",
      sourceUrl: "https://github.com/microsoft/skill-recorder",
      sourceTitle: "Skill Recorder"
    }, {
      imageUrl: "https://images.example.test/tmux.png",
      thumbnailUrl: "https://images.example.test/tmux-thumb.png",
      caption: "tmux 多 pane 终端运行界面",
      sourceUrl: "https://github.com/tmux/tmux",
      sourceTitle: "tmux"
    }]);
    const webSearch: WebSearchClient = {
      activeProviderId: "tavily",
      search: vi.fn(async () => []),
      searchImages,
      extract: vi.fn(async () => ({ content: "" }))
    };
    const imageReviewImageSource = {
      downloadForReview: vi.fn(async () => ({ bytes: Buffer.from("test-image"), mimeType: "image/png" }))
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory, webSearch, imageReviewImageSource });
    const reviewSettings = await server.inject({ method: "PUT", url: "/api/image-review/settings", payload: { mode: "current", provider: null } });
    expect(reviewSettings.statusCode).toBe(200);

    const response = await server.inject({
      method: "POST",
      url: "/api/article-chat/messages",
      payload: {
        contextKey: "source:posts/awen-images/index.md",
        title: "联网找图测试",
        markdown: "这是一段足够长的正文，用来测试图片推荐位置。",
        message: "有没有 tmux 运行时的图片可以放到文章中"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(searchImages).toHaveBeenCalledWith("tmux multiple panes screenshot", 6);
    expect(response.json().message.imageSearch).toMatchObject({
      status: "ready",
      query: "tmux multiple panes screenshot",
        provider: "tavily",
      items: [
        { imageUrl: "https://images.example.test/tmux.png", review: { status: "accepted", score: 0.96 }, placement: { position: "after", rank: 1 } },
        { imageUrl: "https://images.example.test/recorder.png", review: { status: "accepted", score: 0.96 }, placement: { position: "end", rank: 3 } }
      ]
    });
    expect(response.json().message.content).toContain("已在图片素材窗口打开");
    const history = await server.inject({ method: "GET", url: "/api/image-candidates/history?contextKey=source%3Aposts%2Fawen-images%2Findex.md" });
    expect(history.json().items).toHaveLength(1);
    expect(history.json().items[0].provider).toBe("tavily");
    const thread = await server.inject({ method: "GET", url: "/api/article-chat?contextKey=source%3Aposts%2Fawen-images%2Findex.md" });
    expect(thread.json().messages.at(-1).imageSearch.items).toHaveLength(2);
  });

  it("does not claim image search succeeded when the image search tool returns no candidates", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-image-failure-skills-"));
    temporaryDirectories.push(skillsDirectory);
    const fakeProvider: ModelProvider = {
      id: "test-awen-image-failure-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        return {
          value: request.parse({ reply: "我会先检索候选。", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [], imageSearchRequest: { query: "不可用图片", limit: 4 } }),
          provider: "test-awen-image-failure-ai",
          model: "test-model",
          usage: null
        };
      }
    };
    const webSearch: WebSearchClient = {
      activeProviderId: "tavily",
      search: vi.fn(async () => []),
      searchImages: vi.fn(async () => []),
      extract: vi.fn(async () => ({ content: "" }))
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory, webSearch });
    const response = await server.inject({
      method: "POST",
      url: "/api/article-chat/messages",
      payload: { contextKey: "source:posts/awen-image-failure/index.md", title: "找图失败", markdown: "正文。", message: "请找图" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().message.imageSearch).toMatchObject({ status: "failed", items: [], error: "图片检索未返回可用候选，请换个描述重试。" });
    expect(response.json().message.content).toContain("图片检索没有成功");
    expect(response.json().message.content).not.toContain("找到 0 个候选");
  });

  it("renders escaped newlines from an Awen reply as actual newlines", async () => {
    database = openInMemoryDatabase();
    const skillsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-awen-newline-skills-"));
    temporaryDirectories.push(skillsDirectory);
    const fakeProvider: ModelProvider = {
      id: "test-awen-newline-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        return {
          value: request.parse({ reply: "第一段\\n第二段\\n- 列表项", memorySuggestion: "", writingMemorySuggestion: "", suggestions: [] }),
          provider: "test-awen-newline-ai",
          model: "test-model",
          usage: null
        };
      }
    };
    server = buildServer("2026-07-19T00:00:00.000Z", database, testVault, fakeProvider, undefined, { skillsDirectory });

    const response = await server.inject({
      method: "POST",
      url: "/api/article-chat/messages",
      payload: {
        contextKey: "source:posts/newline/index.md",
        title: "换行测试",
        markdown: "正文。",
        message: "请分段回答。"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().message.content).toBe("第一段\n第二段\n- 列表项");

    const now = new Date().toISOString();
    database.connection.prepare(`INSERT INTO article_chat_messages
      (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
      VALUES (?, ?, 'assistant', ?, '', '[]', ?)`)
      .run("33333333-3333-4333-8333-333333333333", "source:posts/newline/index.md", "历史行一\\n历史行二", now);
    const thread = await server.inject({ method: "GET", url: "/api/article-chat?contextKey=source%3Aposts%2Fnewline%2Findex.md" });
    expect(thread.json().messages.at(-1).content).toBe("历史行一\n历史行二");
  });

  it("exposes scoped memory management without deleting source events", async () => {
    server = createTestServer();
    const memory = new AgentMemoryRepository(database!.connection);
    const eventId = memory.appendEvent({ scopeKey: "account:memory-test", eventType: "test", payload: { text: "短句" } });
    const candidateId = memory.addCandidate({ scopeKey: "account:memory-test", kind: "writing_preference", content: "偏好短句。", sourceEventIds: [eventId] });
    const promoted = await server.inject({ method: "POST", url: `/api/agent-memory/candidates/${candidateId}/promote` });
    expect(promoted.statusCode).toBe(200);
    const listed = await server.inject({ method: "GET", url: "/api/agent-memory?scopeKey=account%3Amemory-test" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().memories).toHaveLength(1);
    const memoryId = promoted.json().memoryId as string;
    const disabled = await server.inject({ method: "PATCH", url: `/api/agent-memory/${memoryId}`, payload: { status: "deleted" } });
    expect(disabled.statusCode).toBe(200);
    const forgotten = await server.inject({ method: "POST", url: "/api/agent-memory/forget", payload: { scopeKey: "account:memory-test", mode: "derived" } });
    expect(forgotten.statusCode).toBe(200);
    expect((database!.connection.prepare("SELECT COUNT(*) AS count FROM agent_events WHERE scope_key = ?").get("account:memory-test") as { count: number }).count).toBe(1);
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
        isAiGenerated: true,
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
      isAiGenerated: true,
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
      fs.mkdirSync(path.join(sourceDirectory, "posts", "修改后的正文", "assets"), { recursive: true });
      const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120"><rect width="100%" height="100%" fill="#0f172a"/></svg>';
      fs.writeFileSync(path.join(sourceDirectory, "posts", "修改后的正文", "assets", "diagram.svg"), svgContent);
      const svgImage = await server.inject({ method: "GET", url: `/api/content-source/article-resource?path=${encodeURIComponent(renamedArticlePath)}&src=${encodeURIComponent("./assets/diagram.svg")}` });
      expect(svgImage.statusCode).toBe(200);
      expect(svgImage.headers["content-type"]).toContain("image/svg+xml");
      expect(svgImage.body).toContain("<svg");
      const svgRasterized = await server.inject({ method: "GET", url: `/api/content-source/article-resource?path=${encodeURIComponent(renamedArticlePath)}&src=${encodeURIComponent("./assets/diagram.svg")}&rasterize=1` });
      expect(svgRasterized.statusCode).toBe(200);
      expect(svgRasterized.headers["content-type"]).toContain("image/png");
      // The PNG magic header must be present at byte 0 — any other content (SVG
      // body, an HTML error page, plain text) means rasterize silently failed.
      expect(Buffer.from(svgRasterized.rawPayload).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
      expect(svgRasterized.headers.etag).toBeTruthy();
      expect(svgRasterized.headers["cache-control"]).toContain("must-revalidate");
      const svgRasterizedCached = await server.inject({
        method: "GET",
        url: `/api/content-source/article-resource?path=${encodeURIComponent(renamedArticlePath)}&src=${encodeURIComponent("./assets/diagram.svg")}&rasterize=1`,
        headers: { "if-none-match": svgRasterized.headers.etag }
      });
      expect(svgRasterizedCached.statusCode).toBe(304);
      expect(svgRasterizedCached.rawPayload.length).toBe(0);
      const svgRasterizeOff = await server.inject({ method: "GET", url: `/api/content-source/article-resource?path=${encodeURIComponent(renamedArticlePath)}&src=${encodeURIComponent("./assets/diagram.svg")}&rasterize=0` });
      expect(svgRasterizeOff.statusCode).toBe(200);
      expect(svgRasterizeOff.headers["content-type"]).toContain("image/svg+xml");
      expect(fs.readFileSync(path.join(sourceDirectory, "posts", "修改后的正文", "index.md"), "utf8")).toContain("正文");
    } finally {
      fs.rmSync(sourceDirectory, { recursive: true, force: true });
    }
    // 本用例是重型端到端场景（真实临时文章库 + 20+ 次 HTTP inject + 2 次 SVG resvg 光栅化），
    // 本地独占实测 2.6~4.9s 波动，CI 2 核 runner 稳定超 5s 默认预算（v0.1.4 release 两次失败于此），
    // 显式放宽超时避免把环境慢误判为用例卡死。
  }, 30_000);

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
    const memory = new AgentMemoryRepository(database!.connection);
    memory.appendEvent({ scopeKey: `source:${relativePath}`, eventType: "test.article", payload: { ok: true } });
    const deleted = await server.inject({ method: "DELETE", url: `/api/content-projects/${created.json().id}` });
    expect(deleted.statusCode).toBe(204);
    expect(fs.existsSync(path.dirname(path.join(rootPath, ...relativePath.split("/"))))).toBe(false);
    expect((database!.connection.prepare("SELECT COUNT(*) AS count FROM agent_events WHERE scope_key = ?").get(`source:${relativePath}`) as { count: number }).count).toBe(0);
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

  it("stores an optional canonical code-project directory on the article project", async () => {
    server = createTestServer();
    const created = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "带代码目录的文章" } });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id as string;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-practice-project-"));
    temporaryDirectories.push(directory);

    const saved = await server.inject({
      method: "PUT", url: `/api/content-projects/${projectId}/practice-directory`, payload: { directory }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().project.practiceProjectDirectory).toBe(fs.realpathSync.native(directory));
    expect((await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/practice-directory` })).json())
      .toEqual({ directory: fs.realpathSync.native(directory) });

    const missing = await server.inject({
      method: "PUT", url: `/api/content-projects/${projectId}/practice-directory`, payload: { directory: path.join(directory, "missing") }
    });
    expect(missing.statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/practice-directory` })).json())
      .toEqual({ directory: fs.realpathSync.native(directory) });
    const cleared = await server.inject({
      method: "PUT", url: `/api/content-projects/${projectId}/practice-directory`, payload: { directory: null }
    });
    expect(cleared.json().project.practiceProjectDirectory).toBeNull();
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

  it("keeps user-specified verification status separate from evidence cards", async () => {
    server = createTestServer();
    const created = await server.inject({ method: "POST", url: "/api/content-projects", payload: {
      topic: "Matt Pocock 的 skills 介绍和推荐",
      sourceNotes: "这是一条自己的选题笔记。",
      specifiedSources: ["https://example.com/matt-pocock-skills?utm_source=test"]
    } });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().id as string;

    const research = await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/research` });
    expect(research.json()).toMatchObject({
      sources: [],
      specifiedSources: [{
        url: "https://example.com/matt-pocock-skills",
        status: "pending_manual_verification",
        verificationNote: "",
        failureReason: ""
      }]
    });

    const sourceId = research.json().specifiedSources[0].id as string;
    const verified = await server.inject({
      method: "PATCH",
      url: `/api/content-projects/${projectId}/research/specified-sources/${sourceId}`,
      payload: { status: "verified", verificationNote: "已在浏览器核对正文与作者身份。" }
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().specifiedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sourceId, status: "verified", verificationNote: "已在浏览器核对正文与作者身份。" })
    ]));

    const badStatus = await server.inject({
      method: "PATCH",
      url: `/api/content-projects/${projectId}/research/specified-sources/${sourceId}`,
      payload: { status: "failed" }
    });
    expect(badStatus.statusCode).toBe(400);

    const missingSource = await server.inject({
      method: "PATCH",
      url: `/api/content-projects/${projectId}/research/specified-sources/00000000-0000-0000-0000-000000000000`,
      payload: { status: "rejected" }
    });
    expect(missingSource.statusCode).toBe(400);

    const linkOnlyFollowUp = await server.inject({
      method: "POST",
      url: `/api/content-projects/${projectId}/research/follow-up`,
      payload: { specifiedSources: ["https://example.com/manual-source"] }
    });
    expect(linkOnlyFollowUp.statusCode).toBe(200);
    const manualSpecifiedSource = linkOnlyFollowUp.json().specifiedSources.find((source: { url: string }) => source.url === "https://example.com/manual-source") as { id: string; status: string };
    expect(manualSpecifiedSource).toMatchObject({ status: "pending_manual_verification" });
    expect((await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/research/tasks` })).json().items).toHaveLength(0);

    const manualCard = await server.inject({
      method: "POST",
      url: `/api/content-projects/${projectId}/research/sources`,
      payload: { title: "手工核验来源", url: "https://example.com/manual-source", excerpt: "用户已经核验并补充的摘要。", keyClaims: ["可用于后续写作"] }
    });
    expect(manualCard.statusCode).toBe(200);
    expect(manualCard.json().specifiedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: manualSpecifiedSource.id, status: "verified", verificationNote: "手工补录摘要：手工核验来源" })
    ]));
    const rejected = await server.inject({
      method: "PATCH",
      url: `/api/content-projects/${projectId}/research/specified-sources/${manualSpecifiedSource.id}`,
      payload: { status: "rejected" }
    });
    expect(rejected.json().specifiedSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: manualSpecifiedSource.id, status: "rejected" })
    ]));

    const invalidUrl = await server.inject({ method: "POST", url: "/api/content-projects", payload: {
      topic: "不应创建的项目",
      specifiedSources: ["https://user:secret@example.com/private"]
    } });
    expect(invalidUrl.statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url: "/api/content-projects" })).json().items).toHaveLength(1);
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

  it("looks up a content project by its article path and reports which creation assets exist", async () => {
    server = createTestServer();
    const account = await server.inject({ method: "POST", url: "/api/media-accounts", payload: { platform: "wechat_official", displayName: "测试账号" } });
    const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "归档后可回看", targetAccountId: account.json().id } });
    const projectId = project.json().id as string;
    const relativePath = String(project.json().sourceRelativePath);
    await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/brief`, payload: {
      objective: "判断是否值得采用", audience: "技术从业者", angle: "以实测为例", sourceNotes: "原始笔记"
    } });
    await server.inject({ method: "PUT", url: `/api/content-projects/${projectId}/outline`, payload: { markdown: "# 归档后可回看\n\n## 一" } });

    const found = await server.inject({ method: "GET", url: `/api/content-projects/by-source?relativePath=${encodeURIComponent(relativePath)}` });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ project: { id: projectId, briefReady: true, outlineReady: true, researchReady: false } });

    const missing = await server.inject({ method: "GET", url: "/api/content-projects/by-source?relativePath=posts/does-not-exist/index.md" });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toMatchObject({ project: null });
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
    const outlineDraft = await server.inject({ method: "PUT", url: `/api/content-projects/${project.json().id}/outline/draft`, payload: { markdown: "# 暂存提纲\n\n## 待调整" } });
    expect(outlineDraft.statusCode).toBe(200);
    const draftPreview = await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/outline/draft` });
    expect(draftPreview.json()).toMatchObject({ markdown: "# 暂存提纲\n\n## 待调整" });
    const beforeConfirm = await server.inject({ method: "GET", url: "/api/content-projects" });
    expect(beforeConfirm.json().items.find((item: { id: string }) => item.id === project.json().id).outlineReady).toBe(false);
    const savedOutline = await server.inject({ method: "PUT", url: `/api/content-projects/${project.json().id}/outline`, payload: { markdown: "# AI Agent 工作流\n\n## 我的提纲" } });
    expect(savedOutline.json()).toMatchObject({ markdown: "# AI Agent 工作流\n\n## 我的提纲", generatedFromBrief: false });
    const renamedProject = await server.inject({ method: "GET", url: "/api/content-projects" });
    expect(renamedProject.json().items.find((item: { id: string }) => item.id === project.json().id)).toMatchObject({ topic: "AI Agent 工作流" });
    const clearedDraft = await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/outline/draft` });
    expect(clearedDraft.json()).toBeNull();
    const draft = await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/draft` });
    expect(draft.statusCode).toBe(200);
    expect(draft.json()).toMatchObject({ generatedFromOutline: true });
    const savedDraft = await server.inject({ method: "PUT", url: `/api/content-projects/${project.json().id}/draft`, payload: { markdown: "# AI Agent 工作流\n\n正文草稿" } });
    expect(savedDraft.json()).toMatchObject({ markdown: "# AI Agent 工作流\n\n正文草稿", generatedFromOutline: false });
    const revisedOutline = await server.inject({ method: "PUT", url: `/api/content-projects/${project.json().id}/outline`, payload: { markdown: "# AI Agent 工作流（修订）\n\n## 新的提纲结构" } });
    expect(revisedOutline.statusCode).toBe(200);
    const draftAfterOutlineRevision = await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/draft` });
    expect(draftAfterOutlineRevision.json().markdown).toContain("正文草稿");
    expect(draftAfterOutlineRevision.json().markdown).not.toContain("新的提纲结构");
    const projectAfterOutlineRevision = await server.inject({ method: "GET", url: "/api/content-projects" });
    const rootPath = database!.connection.prepare("SELECT root_path FROM content_sources WHERE workspace_id = 'local-default'")
      .pluck().get() as string;
    const articleFile = path.join(rootPath, ...String(projectAfterOutlineRevision.json().items.find((item: { id: string }) => item.id === project.json().id).sourceRelativePath).split("/"));
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
    const researchInstructions: string[] = [];
    const fakeProvider: ModelProvider = {
      id: "test-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        prompts.push(request.prompt);
        const markdown = request.task === "outline" && request.prompt.includes("最小实践计划")
          ? "# 最小实践计划\n\n## 验证一个关键步骤\n- 已有结果可直接记录，不必重跑"
          : request.task === "outline"
          ? "# AI 提纲\n\n## 真实问题\n\n- 读者在采用 AI 工具时最容易忽略的边界"
          : "# AI 正文\n\n这是一份由测试模型生成的正文。";
        return {
          value: request.parse({ markdown }),
          provider: "test-ai",
          model: "test-model",
          usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 2 }
        };
      },
      async webResearch(_context: WebResearchContext, _onStatus?: (message: string) => void, options?: WebResearchOptions): Promise<GenerateStructuredResult<ResearchCard>> {
        if (options?.instruction) researchInstructions.push(options.instruction);
        const temporary = options?.instruction?.includes("临时调研") === true;
        return {
          value: {
            planMarkdown: "## 本次补研结论\n\n- 官方文档可支持基础接入说明。",
            sources: [{
              title: temporary ? "临时示例官方文档" : "示例官方文档", url: temporary ? "https://example.com/temporary-docs" : "https://example.com/docs", excerpt: "用于验证资料卡持久化。",
              keyClaims: ["提供了可核对的接入说明"], sourceType: "official", evidence: {
                claim: "提供了可核对的接入说明", recommendation: "用于核对接入路径", qualityReason: "测试正文", freshness: "测试时间", boundary: "仅覆盖测试页面", kind: "official",
                sourceUrls: [temporary ? "https://example.com/temporary-docs" : "https://example.com/docs"], snapshots: [{ url: temporary ? "https://example.com/temporary-docs" : "https://example.com/docs", excerpt: "测试正文", capturedAt: "2026-09-10T12:00:00.000Z", sha256: "a".repeat(64) }]
              }
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
      sources: Array<{ id: string; title: string; selected: boolean; adoptionStatus: string }>;
    };
    expect(researchResult).toMatchObject({ planMarkdown: "## 本次补研结论\n\n- 官方文档可支持基础接入说明。", sources: [{ title: "示例官方文档", selected: false, adoptionStatus: "recommended" }] });
    const temporary = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/research/temporary`, payload: { scope: "selection", context: "请核对这段正文中的接入限制。", depth: "quick" } });
    expect(temporary.statusCode).toBe(200);
    expect(temporary.json()).toMatchObject({ scope: "selection", context: "请核对这段正文中的接入限制。", sources: [{ title: "临时示例官方文档" }] });
    expect(researchInstructions[0]).toContain("<untrusted-article-context>");
    const invalidTemporary = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/research/temporary`, payload: { scope: "invalid", context: "测试", depth: "quick" } });
    expect(invalidTemporary.statusCode).toBe(400);
    expect((await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/research` })).json().sources).toHaveLength(1);
    const temporarySource = temporary.json().sources[0] as { title: string; url: string; excerpt: string; keyClaims: string[]; evidence: unknown };
    const savedTemporary = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/research/sources`, payload: {
      title: temporarySource.title, url: temporarySource.url, excerpt: temporarySource.excerpt, keyClaims: temporarySource.keyClaims, adoptionStatus: "pending_verification", evidence: temporarySource.evidence
    } });
    expect(savedTemporary.statusCode).toBe(200);
    expect(savedTemporary.json().sources).toEqual(expect.arrayContaining([expect.objectContaining({ title: temporarySource.title, adoptionStatus: "pending_verification", retrievedAt: "2026-09-10T12:00:00.000Z", evidence: expect.objectContaining({ snapshots: expect.any(Array) }) })]));
    const researchTasks = await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/research/tasks` });
    expect(researchTasks.statusCode).toBe(200);
    expect(researchTasks.json().items[0]).toMatchObject({ projectId: project.json().id, kind: "generate", status: "completed" });
    const researchSourceId = researchResult.sources[0].id;
    const deselected = await server.inject({ method: "PATCH", url: `/api/content-projects/${project.json().id}/research/sources/${researchSourceId}`, payload: { adoptionStatus: "pending_verification" } });
    expect(deselected.statusCode).toBe(200);
    expect(deselected.json().sources[0]).toMatchObject({ id: researchSourceId, selected: false, adoptionStatus: "pending_verification" });

    const outline = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/outline/generate`, payload: {} });
    expect(outline.statusCode).toBe(200);
    expect(outline.json()).toMatchObject({ provider: "test-ai", generatedFromBrief: true, markdown: "# AI Agent 如何改变开发流程\n\n## 真实问题\n\n- 读者在采用 AI 工具时最容易忽略的边界" });
    const projectsBeforeSave = await server.inject({ method: "GET", url: "/api/content-projects" });
    expect(projectsBeforeSave.json().items[0].outlineReady).toBe(false);

    await server.inject({ method: "PUT", url: `/api/content-projects/${project.json().id}/outline`, payload: { markdown: outline.json().markdown } });
    const draftWithoutPlan = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/draft/generate`, payload: {} });
    expect(draftWithoutPlan.statusCode).toBe(200);
    expect(draftWithoutPlan.json().markdown).toContain("由测试模型生成");
    const practicePlan = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/practice-plan/generate`, payload: {} });
    expect(practicePlan.statusCode).toBe(200);
    expect(practicePlan.json()).toMatchObject({ status: "draft", markdown: "# 最小实践计划\n\n## 验证一个关键步骤\n- 已有结果可直接记录，不必重跑" });
    const confirmedPlan = await server.inject({ method: "PUT", url: `/api/content-projects/${project.json().id}/practice-plan`, payload: {
      markdown: "# 最小实践计划\n\n## 使用已有本机结果\n- 不必重跑", status: "confirmed"
    } });
    expect(confirmedPlan.statusCode).toBe(200);
    const practiceTaskStart = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/practice-task`, payload: { goal: "验证示例能否运行" } });
    expect(practiceTaskStart.statusCode).toBe(201);
    expect(practiceTaskStart.json().task).toMatchObject({ status: "assessing", latestGoal: "验证示例能否运行", goalRevision: 1 });
    const practiceTaskId = practiceTaskStart.json().task.id as string;
    const practiceTaskAppend = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/practice-task`, payload: { goal: "再记录适用版本" } });
    expect(practiceTaskAppend.statusCode).toBe(200);
    expect(practiceTaskAppend.json()).toMatchObject({ appendedToExistingTask: true, task: { id: practiceTaskId, goalRevision: 2 } });
    const stoppedPractice = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/practice-task/${practiceTaskId}/stop` });
    expect(stoppedPractice.json().task.status).toBe("waiting_stop_choice");
    const stopChoice = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/practice-task/${practiceTaskId}/decision`, payload: { decision: "continue_draft" } });
    expect(stopChoice.json().task).toMatchObject({ status: "drafting", hasGaps: true });
    const adopted = await server.inject({ method: "PATCH", url: `/api/content-projects/${project.json().id}/research/sources/${researchSourceId}`, payload: { adoptionStatus: "adopted" } });
    expect(adopted.json().sources[0]).toMatchObject({ adoptionStatus: "adopted", selected: true });
    const draft = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/draft/generate`, payload: {} });
    expect(draft.json()).toMatchObject({ provider: "test-ai", generatedFromOutline: true, markdown: "# AI Agent 如何改变开发流程\n\n这是一份由测试模型生成的正文。" });
    expect(prompts[0]).toContain("账号定位：帮助技术从业者理解 AI 工具");
    expect(prompts[0]).toContain("不是研究计划、写作任务书、待办清单或作者工作说明");
    const draftPrompt = prompts.filter((prompt) => prompt.includes("微信公众号资深作者")).pop() ?? "";
    expect(draftPrompt).toContain("已确认提纲");
    expect(prompts[0]).not.toContain("示例官方文档");
    expect(prompts[0]).not.toContain(temporarySource.title);
    expect(draftPrompt).toContain("示例官方文档");
    expect(draftPrompt).not.toContain("使用已有本机结果");
    const refresh = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/research/refresh`, payload: { depth: "quick" } });
    expect(refresh.statusCode).toBe(200);
    const current = await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/research` });
    expect(current.json().sources[0]).toMatchObject({ id: researchSourceId, adoptionStatus: "adopted", selected: true });
    const runs = await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/research/runs` });
    expect(runs.json().items.map((run: { kind: string }) => run.kind)).toEqual(["refresh", "generate"]);
    expect(runs.json().items[1].research.sources[0]).toMatchObject({ adoptionStatus: "recommended" });
  });

  it("streams practice-plan progress and persists the generated draft before completing", async () => {
    const plan = "# 最小实践计划\n\n## 验证一个关键步骤\n- 已有结果可直接记录，不必重跑";
    const fakeProvider: ModelProvider = {
      id: "test-stream-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        return { value: request.parse({ markdown: plan }), provider: "test-stream-ai", model: null, usage: null };
      },
      async generateMarkdownStream(request: GenerateMarkdownStreamRequest) {
        // Mirrors the Codex lifecycle events so the dialog's wording translation
        // for this step is covered by the assertion below.
        request.onStatus?.("Codex 会话已建立，正在读取创作要求…");
        request.onStatus?.("正在规划文章结构…");
        request.onDelta("# 最小实践计划\n\n## 验证一个关键步骤");
        return { value: { markdown: plan }, provider: "test-stream-ai", model: null, usage: null };
      }
    };
    server = createTestServer(fakeProvider);
    const account = await server.inject({ method: "POST", url: "/api/media-accounts", payload: { platform: "wechat_official", displayName: "流式实践计划账号" } });
    const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "流式实践计划", targetAccountId: account.json().id } });

    const stream = await server.inject({ method: "POST", url: `/api/content-projects/${project.json().id}/practice-plan/generate/stream` });
    expect(stream.statusCode).toBe(200);
    // The dialog needs live progress frames, not only a terminal payload.
    expect(stream.body).toContain("event: status");
    // Outline/draft provider wording is translated for the practice-plan step.
    expect(stream.body).toContain("已建立生成会话，正在读取创作要求…");
    expect(stream.body).toContain("正在拟定最少需要验证的步骤…");
    expect(stream.body).toContain("event: delta");
    expect(parseSseCompleteEvent(stream.body)).toMatchObject({ status: "draft", markdown: plan });
    // The finished plan is written before `complete`, so it survives a reload.
    const stored = await server.inject({ method: "GET", url: `/api/content-projects/${project.json().id}/practice-plan` });
    expect(stored.json()).toMatchObject({ status: "draft", markdown: plan });
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

  it("returns temporary research failures without persisting sources or runs", async () => {
    const fakeProvider: ModelProvider = {
      id: "test-temporary-failure",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        return { value: request.parse({ markdown: "# 测试" }), provider: "test-temporary-failure", model: null, usage: null };
      },
      async webResearch(): Promise<GenerateStructuredResult<ResearchCard>> {
        throw new Error("临时调研测试失败");
      }
    };
    server = createTestServer(fakeProvider);
    const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "临时调研失败测试" } });
    const projectId = project.json().id as string;
    const response = await server.inject({ method: "POST", url: `/api/content-projects/${projectId}/research/temporary`, payload: { scope: "article", context: "测试失败路径", depth: "quick" } });
    expect(response.statusCode).toBe(500);
    expect((await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/research` })).json().sources).toHaveLength(0);
    expect((await server.inject({ method: "GET", url: `/api/content-projects/${projectId}/research/runs` })).json().items).toHaveLength(0);
  });

  it("persists a visible research plan and reports budget exhaustion as partial research", async () => {
    const requestedDepths: string[] = [];
    const fakeProvider: ModelProvider = {
      id: "test-research-plan-ai",
      async generateStructured<T>(request: GenerateStructuredRequest<T>) {
        return { value: request.parse({ markdown: "# 测试" }), provider: "test-research-plan-ai", model: null, usage: null };
      },
      async webResearch(_context: WebResearchContext, _onStatus?: (message: string) => void, options?: WebResearchOptions): Promise<GenerateStructuredResult<ResearchCard>> {
        requestedDepths.push(options?.depth ?? "balanced");
        return {
          value: {
            planMarkdown: "## 本次补研结论\n\n- 已找到一条可追溯资料。",
            sources: [{
              title: "官方说明", url: "https://example.com/docs", excerpt: "用于验证研究计划状态。",
              keyClaims: ["页面包含当前接入说明。"], sourceType: "official"
            }],
            execution: {
              rounds: options?.depth === "quick" ? 1 : 2,
              maxRounds: options?.depth === "quick" ? 1 : 5,
              budgetExhausted: options?.depth === "quick"
            }
          } as unknown as ResearchCard,
          provider: "test-research-plan-ai",
          model: null,
          usage: null
        };
      }
    };
    server = createTestServer(fakeProvider);
    const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: {
      topic: "当前 AI Agent 的接入限制", objective: "帮助读者判断能否采用", angle: "同时说明风险和反例"
    } });
    const projectId = project.json().id as string;

    const initial = await server.inject({ method: "POST", url: `/api/content-projects/${projectId}/research/generate`, payload: { depth: "quick" } });
    expect(initial.statusCode).toBe(200);
    expect(parseSseCompleteEvent(initial.body)).toMatchObject({
      plan: {
        depth: "quick",
        partial: true,
        execution: { budgetExhausted: true },
        questions: expect.arrayContaining([expect.stringContaining("当前 AI Agent")]),
        freshnessRisks: expect.arrayContaining([expect.any(String)]),
        gaps: expect.arrayContaining([expect.stringContaining("执行预算")])
      }
    });

    const followUp = await server.inject({
      method: "POST",
      url: `/api/content-projects/${projectId}/research/follow-up`,
      payload: { message: "请补充个人开发者的实际踩坑经验", depth: "deep" }
    });
    expect(followUp.statusCode).toBe(200);
    expect(parseSseCompleteEvent(followUp.body)).toMatchObject({
      plan: {
        depth: "deep",
        questions: expect.arrayContaining([expect.stringContaining("实际踩坑经验")])
      }
    });
    expect(requestedDepths).toEqual(["quick", "deep"]);
  });

  it("accepts a manually entered research card for later writing", async () => {
    server = createTestServer();
    const project = await server.inject({ method: "POST", url: "/api/content-projects", payload: { topic: "手工资料卡测试" } });
    const projectId = project.json().id as string;
    const response = await server.inject({
      method: "POST",
      url: `/api/content-projects/${projectId}/research/sources`,
      payload: { title: "官方说明摘录", excerpt: "这是用户核实后的资料。", keyClaims: ["结论一"] }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ projectId, sources: [{ title: "官方说明摘录", excerpt: "这是用户核实后的资料。", selected: true, sourceType: "public" }] });
    expect(response.json().sources[0].url).toMatch(/^manual:\/\//);
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
        accountId, projectId, author: "ContentFerry", coverSource: asset.json().assetUrl, isAiGenerated: true
      } });
      expect(draft.statusCode).toBe(201);
      expect(draft.json()).toMatchObject({ draftMediaId: "draft-media-id", status: "draft_ready", isAiGenerated: true });
      const draftEvents = await server.inject({ method: "GET", url: `/api/publish-lifecycle/jobs/${draft.json().id}/events` });
      expect(draftEvents.statusCode).toBe(200);
      expect(draftEvents.json()).toMatchObject({
        status: "ready",
        events: [expect.objectContaining({ newStatus: "ready", source: "system" })]
      });
      const submitted = await server.inject({ method: "POST", url: `/api/integrations/wechat/jobs/${draft.json().id}/submit`, payload: { mode: "publish" } });
      expect(submitted.json()).toMatchObject({ publishId: "publish-id-1", status: "submitted", mode: "publish" });
      const submittedEvents = await server.inject({ method: "GET", url: `/api/publish-lifecycle/jobs/${draft.json().id}/events` });
      expect(submittedEvents.json().events).toEqual(expect.arrayContaining([
        expect.objectContaining({ previousStatus: "ready", newStatus: "submitting", source: "system" })
      ]));
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
      const callbackEvents = await server.inject({ method: "GET", url: `/api/publish-lifecycle/jobs/${draft.json().id}/events` });
      expect(callbackEvents.json().events).toEqual(expect.arrayContaining([
        expect.objectContaining({ newStatus: "published", source: "platform" })
      ]));
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

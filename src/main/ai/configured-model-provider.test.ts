import { describe, it, expect, vi } from "vitest";
import { ConfiguredModelProvider } from "./configured-model-provider";
import type { ModelProvider, GenerateStructuredResult } from "./model-provider";
import type { AiAuditLog, AiAuditCall } from "./ai-audit-log";
import type { WebSearchClient } from "./web-search";

function fakeAuditLog() {
  const record = vi.fn<void, [AiAuditCall]>();
  const auditLog = {
    record,
    clear: vi.fn()
  } as unknown as AiAuditLog;
  return { auditLog, record };
}

function stubConnections() {
  return {
    get: () => ({ modelId: "gpt-test", enabled: true, credentialConfigured: true, displayName: "测试", baseUrl: "", proxyUrl: "" }),
    getCredential: () => "test-key"
  } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
}

function stubSkills() {
  return {
    get: () => ({ enabled: true, name: "测试技能", provider: "openai_codex" }),
    instructionsFor: (_id: string, _prompt: string) => "RULES"
  } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1];
}

/** A no-network web search stub returning one canned result per query. */
function stubWebSearch(): WebSearchClient {
  const search = vi.fn(async (query: string) => [
    { title: `结果 ${query}`, url: `https://example.com/${encodeURIComponent(query)}`, snippet: `摘要 ${query}` }
  ]);
  const extract = vi.fn(async () => ({ content: "正文" }));
  return { search, extract, activeProviderId: "duckduckgo" } as unknown as WebSearchClient;
}

function stubCodex(structuredValue: unknown, markdown?: string) {
  const codex: Partial<ModelProvider> = {
    generateStructured: vi.fn(async (req: { prompt: string }) => ({
      value: structuredValue,
      provider: "openai_codex",
      model: "gpt-test",
      usage: { inputTokens: 5, outputTokens: 6, cachedInputTokens: 0, reasoningOutputTokens: 0 }
    })),
    generateMarkdownStream: markdown
      ? vi.fn(async (req: { prompt: string; onDelta: (m: string) => void }) => {
        req.onDelta(markdown);
        return { value: { markdown }, provider: "openai_codex", model: "gpt-test", usage: null };
      })
      : undefined
  };
  return codex as unknown as ModelProvider;
}

describe("ConfiguredModelProvider audit", () => {
  it("records the full enriched prompt and structured response on success", async () => {
    const { auditLog, record } = fakeAuditLog();
    const codex = stubCodex({ title: "示例标题" });
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), codex, auditLog, stubWebSearch());

    await provider.generateStructured({
      task: "outline",
      skillId: "wechat-writing",
      prompt: "原始任务内容",
      outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
      parse: (value) => value as { title: string },
      timeoutMs: 1000
    });

    expect(record).toHaveBeenCalledTimes(1);
    const call = record.mock.calls[0][0];
    expect(call.ok).toBe(true);
    expect(call.prompt).toContain("请遵循以下 ContentFerry 技能说明");
    expect(call.prompt).toContain("RULES");
    expect(call.prompt).toContain("原始任务内容");
    expect(call.response).toBe(JSON.stringify({ title: "示例标题" }));
    expect(call.skillId).toBe("wechat-writing");
  });

  it("records the error message and ok=false on failure", async () => {
    const { auditLog, record } = fakeAuditLog();
    const failingCodex = {
      generateStructured: vi.fn(async () => { throw new Error("模型超时"); })
    } as unknown as ModelProvider;
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), failingCodex, auditLog, stubWebSearch());

    await expect(
      provider.generateStructured({
        task: "draft",
        skillId: "wechat-writing",
        prompt: "任务",
        outputSchema: { type: "object", properties: {}, required: [], additionalProperties: true },
        parse: (value) => value as Record<string, unknown>,
        timeoutMs: 1000
      })
    ).rejects.toThrow("模型超时");

    expect(record).toHaveBeenCalledTimes(1);
    const call = record.mock.calls[0][0];
    expect(call.ok).toBe(false);
    expect(call.error).toBe("模型超时");
  });

  it("records the full markdown response for streaming and does not double-log", async () => {
    const { auditLog, record } = fakeAuditLog();
    const codex = stubCodex(undefined, "流式生成的正文内容");
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), codex, auditLog, stubWebSearch());

    const deltas: string[] = [];
    const result: GenerateStructuredResult<{ markdown: string }> = await provider.generateMarkdownStream({
      task: "draft",
      skillId: "wechat-writing",
      prompt: "任务",
      onDelta: (m) => deltas.push(m),
      onStatus: () => {},
      timeoutMs: 1000
    });

    expect(result.value.markdown).toBe("流式生成的正文内容");
    expect(deltas).toContain("流式生成的正文内容");
    expect(record).toHaveBeenCalledTimes(1);
    const call = record.mock.calls[0][0];
    expect(call.response).toContain("流式生成的正文内容");
  });

  it("falls back to structured generation when the configured Codex provider cannot stream Markdown", async () => {
    const { auditLog, record } = fakeAuditLog();
    const codex = stubCodex({ markdown: "普通模式生成的正文" });
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), codex, auditLog, stubWebSearch());
    const deltas: string[] = [];
    const statuses: string[] = [];

    const result = await provider.generateMarkdownStream({
      task: "draft", skillId: "wechat-writing", prompt: "任务",
      onDelta: (markdown) => deltas.push(markdown),
      onStatus: (message) => statuses.push(message),
      timeoutMs: 1_000
    });

    expect(result.value.markdown).toBe("普通模式生成的正文");
    expect(deltas).toEqual(["普通模式生成的正文"]);
    expect(statuses).toContain("当前模型不支持流式输出，正在改用普通生成模式…");
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].response).toContain("普通模式生成的正文");
  });

  it("skips recording when no audit log is provided", async () => {
    const codex = stubCodex({ title: "x" });
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), codex, undefined, stubWebSearch());
    // Should not throw even though there is no auditLog.
    const result = await provider.generateStructured({
      task: "outline",
      skillId: "wechat-writing",
      prompt: "任务",
      outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
      parse: (value) => value as { title: string },
      timeoutMs: 1000
    });
    expect(result.value.title).toBe("x");
  });

  it("records the resolved provider/model for a cross-model structured call (no Codex guard)", async () => {
    const { auditLog, record } = fakeAuditLog();
    const codex = stubCodex({ title: "x" });
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), codex, auditLog, stubWebSearch());

    // web-research no longer requires OpenAI Codex — any configured model works.
    const status = vi.fn();
    await provider.webResearch(
      { topic: "主题", objective: "目标", audience: "读者", angle: "角度", positioning: "定位", sourceNotes: "已有" },
      status
    ).catch(() => {});

    // The audit envelope should at least record the targeted provider/model
    // even when retrieval yields nothing in this stubbed setup.
    expect(record).toHaveBeenCalled();
    const call = record.mock.calls[0][0];
    expect(call.provider).toBe("openai_codex");
    expect(call.model).toBe("gpt-test");
  });
});

describe("ConfiguredModelProvider adaptive research retrieval", () => {
  it("pivots to a new search when candidate body extraction fails, without promoting snippets", async () => {
    const prompts: string[] = [];
    const plannerResponses = [
      { action: "search", query: "official scoop install instructions" },
      { action: "done", query: "" },
      { action: "search", query: "Scoop current installation official documentation" }
    ];
    const codex = {
      generateStructured: vi.fn(async (request: { prompt: string }) => {
        prompts.push(request.prompt);
        const value = request.prompt.includes("研究规划器")
          ? plannerResponses.shift() ?? { action: "done", query: "" }
          : { planMarkdown: "依据已核验正文整理", sources: [], coverage: { answeredQuestions: [], remainingQuestions: [] } };
        return { value, provider: "openai_codex", model: "gpt-test", usage: null };
      })
    } as unknown as ModelProvider;
    const search = vi.fn(async (query: string) => [{
      title: `候选 ${query}`,
      url: query.includes("official scoop") ? "https://example.com/blocked" : "https://example.com/verified",
      snippet: query.includes("official scoop") ? "不可作为依据的搜索摘要" : "新的搜索摘要"
    }]);
    const extract = vi.fn(async (url: string) => {
      if (url.endsWith("/blocked")) throw new Error("页面拒绝访问");
      return { content: "已核验网页正文：当前官方安装步骤。" };
    });
    const webSearch = { search, extract, activeProviderId: "test" } as unknown as WebSearchClient;
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), codex, undefined, webSearch);
    const result = await provider.webResearch({
      topic: "Scoop 安装", objective: "提供可执行安装步骤", audience: "Windows 用户", angle: "当前安装方式", positioning: "实用指南", sourceNotes: ""
    });

    expect(result.value.execution?.rounds).toBe(2);
    expect(search).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenCalledTimes(2);
    const recoveryPlannerPrompt = prompts[2] ?? "";
    expect(recoveryPlannerPrompt).toContain("未能取得可核验正文");
    expect(recoveryPlannerPrompt).toContain("不能使用搜索摘要代替正文");
    const synthesisPrompt = prompts.find((prompt) => prompt.includes("可追溯资料卡")) ?? "";
    expect(synthesisPrompt).toContain("已核验网页正文：当前官方安装步骤。");
    expect(synthesisPrompt).not.toContain("不可作为依据的搜索摘要");
  });

  it("does not repeat a query or exceed the research round budget during recovery", async () => {
    const responses = [
      { action: "search", query: "new query" },
      { action: "done", query: "" },
      { action: "search", query: "new query" }
    ];
    const codex = {
      generateStructured: vi.fn(async () => ({ value: responses.shift(), provider: "openai_codex", model: "gpt-test", usage: null }))
    } as unknown as ModelProvider;
    const search = vi.fn(async () => [{ title: "候选", url: "https://example.com/blocked", snippet: "摘要" }]);
    const extract = vi.fn(async () => { throw new Error("页面拒绝访问"); });
    const history = [{ query: "already tried", resultCount: 1, resultUrls: ["https://example.com/blocked"] }];
    const webSearch = { search, extract, activeProviderId: "test" } as unknown as WebSearchClient;
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), codex, undefined, webSearch);
    await expect(provider.webResearch({
      topic: "主题", objective: "目标", audience: "读者", angle: "角度", positioning: "定位", sourceNotes: "", searchHistory: history
    })).rejects.toThrow("所有网页正文提取均失败");
    expect(search).toHaveBeenCalledTimes(1);
    expect(codex.generateStructured).toHaveBeenCalledTimes(3);
  });

  it("uses an unused search round when the first query produces no candidate pages", async () => {
    const prompts: string[] = [];
    const plannerResponses = [
      { action: "search", query: "specific documentation keyword" },
      { action: "done", query: "" },
      { action: "search", query: "official product installation guide" }
    ];
    const codex = {
      generateStructured: vi.fn(async (request: { prompt: string }) => {
        prompts.push(request.prompt);
        const value = request.prompt.includes("研究规划器")
          ? plannerResponses.shift() ?? { action: "done", query: "" }
          : { planMarkdown: "已找到并核验资料", sources: [], coverage: { answeredQuestions: [], remainingQuestions: [] } };
        return { value, provider: "openai_codex", model: "gpt-test", usage: null };
      })
    } as unknown as ModelProvider;
    const search = vi.fn(async (query: string) => query.includes("official product")
      ? [{ title: "官方指南", url: "https://example.com/official-guide", snippet: "未核验摘要" }]
      : []);
    const extract = vi.fn(async () => ({ content: "官方正文：安装步骤与当前要求。" }));
    const webSearch = { search, extract, activeProviderId: "test" } as unknown as WebSearchClient;
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), codex, undefined, webSearch);

    const result = await provider.webResearch({
      topic: "应用安装", objective: "提供可执行安装步骤", audience: "新用户", angle: "从零开始", positioning: "实用指南", sourceNotes: ""
    });

    expect(result.value.execution?.rounds).toBe(2);
    expect(search).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenCalledOnce();
    expect(prompts[2]).toContain("没有返回候选网页");
  });

  it("deduplicates equivalent page URLs before extraction and synthesis", async () => {
    const prompts: string[] = [];
    const plannerResponses = [
      { action: "search", query: "first source query" },
      { action: "search", query: "second source query" }
    ];
    const codex = {
      generateStructured: vi.fn(async (request: { prompt: string }) => {
        prompts.push(request.prompt);
        const value = request.prompt.includes("研究规划器")
          ? plannerResponses.shift() ?? { action: "done", query: "" }
          : { planMarkdown: "依据已核验正文整理", sources: [], coverage: { answeredQuestions: [], remainingQuestions: [] } };
        return { value, provider: "openai_codex", model: "gpt-test", usage: null };
      })
    } as unknown as ModelProvider;
    const search = vi.fn(async (query: string) => [{
      title: `结果 ${query}`,
      url: query.startsWith("first") ? "https://example.com/guide?utm_source=first" : "https://example.com/guide",
      snippet: `搜索摘要 ${query}`
    }]);
    const extract = vi.fn(async () => ({ content: "唯一核验的正文内容。" }));
    const webSearch = { search, extract, activeProviderId: "test" } as unknown as WebSearchClient;
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), codex, undefined, webSearch);

    const result = await provider.webResearch({
      topic: "主题", objective: "目标", audience: "读者", angle: "角度", positioning: "定位", sourceNotes: ""
    });

    expect(result.value.execution?.rounds).toBe(2);
    expect(search).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenCalledOnce();
    expect(prompts[1]).toContain("https://example.com/guide?utm_source=first");
    const synthesisPrompt = prompts.find((prompt) => prompt.includes("可追溯资料卡")) ?? "";
    expect(synthesisPrompt.match(/唯一核验的正文内容。/gu)).toHaveLength(1);
  });
});

function openrouterConnections() {
  return {
    get: (provider: string) =>
      provider === "custom:test-openrouter"
        ? { modelId: "openai/gpt-5-mini", enabled: true, credentialConfigured: true, displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", proxyUrl: "" }
        : { modelId: "", enabled: false, credentialConfigured: false, displayName: "x", baseUrl: "", proxyUrl: "" },
    getCredential: () => "test-key"
  } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
}

function openrouterSkills() {
  return {
    get: () => ({ enabled: true, name: "测试技能", provider: "custom:test-openrouter" }),
    instructionsFor: () => "RULES"
  } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1];
}

describe("ConfiguredModelProvider structured-output fallback", () => {
  it("retries without response_format when the model rejects structured outputs", async () => {
    const codex = stubCodex({ title: "x" });
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ?? "");
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({ error: { message: "model features structured outputs not support" } }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "降级成功" }) } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = new ConfiguredModelProvider(openrouterConnections(), openrouterSkills(), codex, undefined, stubWebSearch());
      const result = await provider.generateStructured({
        task: "outline",
        skillId: "wechat-writing",
        prompt: "主题",
        outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
        parse: (value) => value as { title: string },
        timeoutMs: 1000
      });
      expect(result.value.title).toBe("降级成功");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(bodies[0]).response_format).toBeDefined();
      expect(JSON.parse(bodies[1]).response_format).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("records the resolved provider and model for an openai-compatible call", async () => {
    const { auditLog, record } = fakeAuditLog();
    const codex = stubCodex({ title: "x" });
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "ok" }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = new ConfiguredModelProvider(openrouterConnections(), openrouterSkills(), codex, auditLog, stubWebSearch());
      await provider.generateStructured({
        task: "outline",
        skillId: "wechat-writing",
        prompt: "主题",
        outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
        parse: (value) => value as { title: string },
        timeoutMs: 1000
      });
      const call = record.mock.calls[0][0];
      expect(call.provider).toBe("custom:test-openrouter");
      expect(call.model).toBe("openai/gpt-5-mini");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("sends a json_schema contract and an explicit output limit for a custom connection", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ?? "");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "ok" }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const connections = {
        get: () => ({ provider: "custom:test-nous", modelId: "stepfun/step-3.7-flash:free", enabled: true, credentialConfigured: true, displayName: "测试自定义", baseUrl: "https://example.test/v1", proxyUrl: "" }),
        getCredential: () => "test-key"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
      const skills = {
        get: () => ({ enabled: true, name: "测试技能", provider: "custom:test-nous" }),
        instructionsFor: () => "RULES"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1];
      const provider = new ConfiguredModelProvider(connections, skills, stubCodex({ title: "unused" }), undefined, stubWebSearch());
      await provider.generateStructured({
        task: "research",
        skillId: "web-research",
        prompt: "主题",
        outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        parse: (value) => value as { title: string },
        timeoutMs: 1000
      });
      const body = JSON.parse(bodies[0]) as { response_format?: unknown; max_tokens?: number; reasoning_effort?: string };
      expect(body.response_format).toBeDefined();
      expect(body.max_tokens).toBe(8192);
      expect(body.reasoning_effort).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reads content parts returned by an OpenAI-compatible gateway", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({
        choices: [{ message: { content: [{ type: "text", text: '{"title":"分段响应"}' }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const connections = {
        get: () => ({ provider: "custom:test-gateway", modelId: "stepfun/step-3.7-flash:free", enabled: true, credentialConfigured: true, displayName: "测试网关", baseUrl: "https://example.test/v1", proxyUrl: "" }),
        getCredential: () => "test-key"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
      const skills = {
        get: () => ({ enabled: true, name: "测试技能", provider: "custom:test-gateway" }),
        instructionsFor: () => "RULES"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1];
      const provider = new ConfiguredModelProvider(connections, skills, stubCodex({ title: "unused" }), undefined, stubWebSearch());
      const result = await provider.generateStructured({
        task: "research",
        skillId: "web-research",
        prompt: "主题",
        outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        parse: (value) => value as { title: string },
        timeoutMs: 1000
      });
      expect(result.value.title).toBe("分段响应");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("retries a truncated custom JSON response with a compact contract", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ?? "");
      const content = bodies.length === 1 ? '{"title":"未完成' : '{"title":"恢复成功"}';
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const connections = {
        get: () => ({ provider: "custom:test-truncated", modelId: "stepfun/step-3.7-flash:free", enabled: true, credentialConfigured: true, displayName: "测试截断", baseUrl: "https://example.test/v1", proxyUrl: "" }),
        getCredential: () => "test-key"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
      const skills = {
        get: () => ({ enabled: true, name: "测试技能", provider: "custom:test-truncated" }),
        instructionsFor: () => "RULES"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1];
      const provider = new ConfiguredModelProvider(connections, skills, stubCodex({ title: "unused" }), undefined, stubWebSearch());
      const result = await provider.generateStructured({
        task: "research",
        skillId: "web-research",
        prompt: "主题",
        outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
        parse: (value) => value as { title: string },
        timeoutMs: 1000
      });
      expect(result.value.title).toBe("恢复成功");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bodies[1]).toContain("资料卡数量由独立证据决定");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not apply research-card length limits when retrying a draft", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ?? "");
      const content = bodies.length === 1 ? '{"markdown":"未完成' : '{"markdown":"# 标题\\n\\n## 第一节\\n正文"}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const connections = {
        get: () => ({ provider: "custom:test-draft", modelId: "test-model", enabled: true, credentialConfigured: true, displayName: "测试正文", baseUrl: "https://example.test/v1", proxyUrl: "" }),
        getCredential: () => "test-key"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
      const skills = {
        get: () => ({ enabled: true, name: "测试技能", provider: "custom:test-draft" }),
        instructionsFor: () => "RULES"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1];
      const provider = new ConfiguredModelProvider(connections, skills, stubCodex({ title: "unused" }));
      await provider.generateStructured({
        task: "draft", skillId: "wechat-writing", prompt: "请写正文",
        outputSchema: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
        parse: (value) => value as { markdown: string }, timeoutMs: 1000
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(bodies[1]).toContain("保留已确认提纲的全部章节");
      expect(bodies[1]).not.toContain("每条摘要不超过 120 个汉字");
      expect((JSON.parse(bodies[0]) as { max_tokens: number }).max_tokens).toBe(8_000);
      expect((JSON.parse(bodies[1]) as { max_tokens: number }).max_tokens).toBe(12_000);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("retries a draft when the provider reports an output-length stop even if the JSON is valid", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ?? "");
      const truncatedButValid = bodies.length === 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ markdown: truncatedButValid ? "# Guide\n\n## Part 1\nShort" : "# Guide\n\n## Part 1\nComplete draft" }) }, finish_reason: truncatedButValid ? "length" : "stop" }]
      }), { status: 200 });
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const connections = {
        get: () => ({ provider: "custom:test-draft", modelId: "test-model", enabled: true, credentialConfigured: true, displayName: "测试正文", baseUrl: "https://example.test/v1", proxyUrl: "" }),
        getCredential: () => "test-key"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
      const provider = new ConfiguredModelProvider(connections, {
        get: () => ({ enabled: true, name: "测试正文", provider: "custom:test-draft" }),
        instructionsFor: () => "RULES"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1], stubCodex({ title: "unused" }));
      const generated = await provider.generateStructured({
        task: "draft", skillId: "wechat-writing", prompt: "请写完整正文",
        outputSchema: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
        parse: (value) => value as { markdown: string }, timeoutMs: 1000
      });

      expect(generated.value.markdown).toContain("Complete draft");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((JSON.parse(bodies[1]!) as { max_tokens: number }).max_tokens).toBe(12_000);
      expect(bodies[1]).toContain("保留已确认提纲的全部章节");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("retries a draft when a gateway reports normal completion at the edge of the output budget", async () => {
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      bodies.push(init?.body ?? "");
      const firstAttempt = bodies.length === 1;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ markdown: firstAttempt ? "# Guide\n\n## Part 1\nCompressed" : "# Guide\n\n## Part 1\nExpanded complete draft" }) }, finish_reason: "stop" }],
        usage: { completion_tokens: firstAttempt ? 7_900 : 7_200 }
      }), { status: 200 });
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const connections = {
        get: () => ({ provider: "custom:test-draft", modelId: "test-model", enabled: true, credentialConfigured: true, displayName: "测试正文", baseUrl: "https://example.test/v1", proxyUrl: "" }),
        getCredential: () => "test-key"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
      const provider = new ConfiguredModelProvider(connections, {
        get: () => ({ enabled: true, name: "测试正文", provider: "custom:test-draft" }),
        instructionsFor: () => "RULES"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1], stubCodex({ title: "unused" }));
      const generated = await provider.generateStructured({
        task: "draft", skillId: "wechat-writing", prompt: "请写完整正文",
        outputSchema: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
        parse: (value) => value as { markdown: string }, timeoutMs: 1000
      });

      expect(generated.value.markdown).toContain("Expanded complete draft");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((JSON.parse(bodies[1]!) as { max_tokens: number }).max_tokens).toBe(12_000);
      expect(bodies[1]).toContain("触及本轮输出预算上限附近");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not accept a draft that reaches the expanded output budget without a length stop signal", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ markdown: "# 仍可能偏短的候选正文" }) }, finish_reason: "stop" }],
      usage: { completion_tokens: 11_800 }
    }), { status: 200 }));
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const connections = {
        get: () => ({ provider: "custom:test-draft", modelId: "test-model", enabled: true, credentialConfigured: true, displayName: "测试正文", baseUrl: "https://example.test/v1", proxyUrl: "" }),
        getCredential: () => "test-key"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
      const provider = new ConfiguredModelProvider(connections, {
        get: () => ({ enabled: true, name: "测试正文", provider: "custom:test-draft" }),
        instructionsFor: () => "RULES"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1], stubCodex({ title: "unused" }));

      await expect(provider.generateStructured({
        task: "draft", skillId: "wechat-writing", prompt: "请写完整正文",
        outputSchema: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
        parse: (value) => value as { markdown: string }, timeoutMs: 1000
      })).rejects.toThrow("正文在扩展输出重试后仍接近输出上限；已拒绝将可能压缩的候选交给评审");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects a draft that still reports an output-length stop after the expanded retry", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ markdown: "# 可能不完整" }) }, finish_reason: "length" }]
    }), { status: 200 }));
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const connections = {
        get: () => ({ provider: "custom:test-draft", modelId: "test-model", enabled: true, credentialConfigured: true, displayName: "测试正文", baseUrl: "https://example.test/v1", proxyUrl: "" }),
        getCredential: () => "test-key"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
      const provider = new ConfiguredModelProvider(connections, {
        get: () => ({ enabled: true, name: "测试正文", provider: "custom:test-draft" }),
        instructionsFor: () => "RULES"
      } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1], stubCodex({ title: "unused" }));

      await expect(provider.generateStructured({
        task: "draft", skillId: "wechat-writing", prompt: "请写完整正文",
        outputSchema: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"] },
        parse: (value) => value as { markdown: string }, timeoutMs: 1000
      })).rejects.toThrow("已拒绝将可能不完整的候选正文交给评审");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});

import { describe, it, expect, vi } from "vitest";
import { ConfiguredModelProvider } from "./configured-model-provider";
import type { ModelProvider } from "./model-provider";
import type { WebSearchClient, SearchResultItem } from "./web-search";
import type { AiAuditLog, AiAuditCall } from "./ai-audit-log";
import type { WebResearchContext } from "./research-prompts";

const context: WebResearchContext = {
  topic: "主题",
  objective: "目标",
  audience: "读者",
  angle: "角度",
  positioning: "定位",
  sourceNotes: "已有资料"
};

const SINGLE_SOURCE = {
  title: "结果",
  url: "https://example.com/x",
  excerpt: "摘要",
  keyClaims: ["主张一"],
  sourceType: "public" as const,
  sourceUrls: ["https://example.com/x"],
  claim: "主张一",
  recommendation: "解释这个主题的关键判断。",
  qualityReason: "正文已由系统提取。",
  freshness: "请核对页面更新时间。",
  boundary: "仅适用于页面描述的版本。",
  evidenceKind: "review" as const
};

function fakeAuditLog() {
  const record = vi.fn<void, [AiAuditCall]>();
  const auditLog = { record, clear: vi.fn() } as unknown as AiAuditLog;
  return { auditLog, record };
}

function fakeWebSearch(): WebSearchClient {
  const search = vi.fn(async (query: string): Promise<SearchResultItem[]> => [
    { title: `结果 ${query}`, url: "https://example.com/x", snippet: `摘要 ${query}` }
  ]);
  const extract = vi.fn(async () => ({ content: "正文" }));
  return { search, extract, activeProviderId: "duckduckgo" } as unknown as WebSearchClient;
}

function stubConnections() {
  return {
    get: () => ({ modelId: "gpt-test", enabled: true, credentialConfigured: true, displayName: "测试", baseUrl: "https://api.openai.com/v1", proxyUrl: "" }),
    getCredential: () => "test-key"
  } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
}

function codexSkills() {
  return {
    get: () => ({ enabled: true, name: "联网资料补研", provider: "openai_codex" }),
    instructionsFor: () => "RULES"
  } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1];
}

function openaiConnections() {
  return {
    get: (provider: string) =>
      provider === "custom:test-openai"
        ? { modelId: "gpt-4o", enabled: true, credentialConfigured: true, displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", proxyUrl: "" }
        : { modelId: "", enabled: false, credentialConfigured: false, displayName: "x", baseUrl: "", proxyUrl: "" },
    getCredential: () => "test-key"
  } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
}

function openaiSkills() {
  return {
    get: () => ({ enabled: true, name: "联网资料补研", provider: "custom:test-openai" }),
    instructionsFor: () => "RULES"
  } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1];
}

/** A Codex-shaped provider: returns a planner JSON (prependInstructions=true)
 *  on the first round and synthesis (prependInstructions=false) afterwards. */
function codexPlannerThenSynthesis(): ModelProvider {
  let plannerCalls = 0;
  const codex: Partial<ModelProvider> = {
    generateStructured: vi.fn(async (req: { prependInstructions?: boolean }) => {
      if (req.prependInstructions === true) {
        plannerCalls++;
        const value = plannerCalls === 1 ? { action: "search", query: "检索词一" } : { action: "done", query: "" };
        return { value, provider: "openai_codex", model: "gpt-test", usage: null };
      }
      return { value: { planMarkdown: "结论", sources: [SINGLE_SOURCE] }, provider: "openai_codex", model: "gpt-test", usage: null };
    })
  };
  return codex as unknown as ModelProvider;
}

describe("ConfiguredModelProvider.webResearch", () => {
  it("scheme B: multi-round planner + synthesis on a non-tool model (Codex), audit records retrieval", async () => {
    const { auditLog, record } = fakeAuditLog();
    const provider = new ConfiguredModelProvider(stubConnections(), codexSkills(), codexPlannerThenSynthesis(), auditLog, fakeWebSearch());

    const result = await provider.webResearch(context, () => {});

    expect(result.value.sources).toHaveLength(1);
    expect(result.provider).toBe("openai_codex");
    const call = record.mock.calls.map(([entry]) => entry).find((entry) => entry.task === "research" && entry.retrieval);
    expect(call).toBeDefined();
    expect(record).toHaveBeenCalled();
    expect(call.ok).toBe(true);
    expect(call.retrieval).toEqual({ rounds: 1, sources: 1, provider: "duckduckgo" });
    expect(call.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(new Set(record.mock.calls.map(([entry]) => entry.correlationId))).toEqual(new Set([call.correlationId]));
  });

  it("uses the selected depth as an app-owned retrieval budget and exposes exhaustion", async () => {
    const provider = new ConfiguredModelProvider(stubConnections(), codexSkills(), codexPlannerThenSynthesis(), undefined, fakeWebSearch());

    const result = await provider.webResearch(context, () => {}, { depth: "quick" });

    expect(result.value.execution).toEqual({ rounds: 1, maxRounds: 1, budgetExhausted: true });
  });

  it("continues for application-owned coverage gaps even when the planner says done", async () => {
    const webSearch = fakeWebSearch();
    const provider = new ConfiguredModelProvider(stubConnections(), codexSkills(), codexPlannerThenSynthesis(), undefined, webSearch);
    await provider.webResearch({ ...context, coverageGaps: ["待补充：官方原始资料", "待补充：限制、反例或适用边界"] }, () => {}, { depth: "balanced" });
    expect(webSearch.search).toHaveBeenCalledTimes(2);
    expect(webSearch.search).toHaveBeenNthCalledWith(1, expect.stringContaining("官方原始资料"));
    expect(webSearch.search).toHaveBeenNthCalledWith(2, expect.stringContaining("限制、反例"));
  });

  it("uses the app-owned body verification path even when Codex built-in search is enabled", async () => {
    const generateStructured = vi.fn(async (request: { prependInstructions?: boolean }) => {
      if (request.prependInstructions) return { value: { action: "search", query: "核验词" }, provider: "openai_codex", model: "gpt-test", usage: null };
      return { value: { planMarkdown: "结论", sources: [SINGLE_SOURCE] }, provider: "openai_codex", model: "gpt-test", usage: null };
    });
    const builtInConnections = {
      get: () => ({ modelId: "gpt-test", enabled: true, credentialConfigured: true, displayName: "测试", baseUrl: "https://api.openai.com/v1", proxyUrl: "", builtInSearch: true }),
      getCredential: () => "test-key"
    } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
    const provider = new ConfiguredModelProvider(builtInConnections, codexSkills(), { id: "codex", generateStructured } as unknown as ModelProvider, undefined, fakeWebSearch());

    const result = await provider.webResearch(context, () => {}, { depth: "quick" });

    expect(generateStructured).toHaveBeenCalledWith(expect.objectContaining({ prependInstructions: true }));
    expect(generateStructured).not.toHaveBeenCalledWith(expect.objectContaining({ webSearch: true }));
    expect(result.value.sources[0].evidence?.snapshots[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.value.execution).toEqual({ rounds: 1, maxRounds: 1, budgetExhausted: true });
  });

  it("drops model-proposed links that do not have an extracted body", async () => {
    const codex: Partial<ModelProvider> = {
      generateStructured: vi.fn(async (req: { prependInstructions?: boolean }) => req.prependInstructions
        ? { value: { action: "search", query: "q" }, provider: "openai_codex", model: "gpt-test", usage: null }
        : { value: { planMarkdown: "结论", sources: [{ ...SINGLE_SOURCE, url: "https://not-verified.example/x", sourceUrls: ["https://not-verified.example/x"] }] }, provider: "openai_codex", model: "gpt-test", usage: null })
    };
    const provider = new ConfiguredModelProvider(stubConnections(), codexSkills(), codex as ModelProvider, undefined, fakeWebSearch());
    const result = await provider.webResearch(context, () => {});
    expect(result.value.sources).toEqual([]);
  });

  it("body-verifies user-specified URLs before synthesis", async () => {
    const requiredUrl = "https://example.com/required";
    const webSearch = fakeWebSearch();
    const extract = vi.fn(async (url: string) => ({ content: `正文 ${url}` }));
    webSearch.extract = extract;
    const codex: Partial<ModelProvider> = {
      generateStructured: vi.fn(async (req: { prependInstructions?: boolean }) => req.prependInstructions
        ? { value: { action: "done", query: "" }, provider: "openai_codex", model: "gpt-test", usage: null }
        : { value: { planMarkdown: "结论", sources: [{ ...SINGLE_SOURCE, url: requiredUrl, sourceUrls: [requiredUrl] }] }, provider: "openai_codex", model: "gpt-test", usage: null })
    };
    const provider = new ConfiguredModelProvider(stubConnections(), codexSkills(), codex as ModelProvider, undefined, webSearch);
    const result = await provider.webResearch({ ...context, specifiedSourceUrls: [requiredUrl] }, () => {}, { depth: "quick" });
    expect(extract).toHaveBeenCalledWith(requiredUrl);
    expect(result.value.sources[0].url).toBe(requiredUrl);
    expect(result.value.specifiedSourceResults).toEqual([{ url: requiredUrl, status: "extracted" }]);
  });

  it("reports a concrete retryable error when every body extraction fails", async () => {
    const webSearch = fakeWebSearch();
    webSearch.extract = vi.fn(async () => { throw new Error("连接超时"); });
    const statuses: string[] = [];
    const provider = new ConfiguredModelProvider(stubConnections(), codexSkills(), codexPlannerThenSynthesis(), undefined, webSearch);
    await expect(provider.webResearch(context, (status) => statuses.push(status), { depth: "quick" })).rejects.toThrow(/所有网页正文提取均失败/);
    expect(statuses.some((status) => status.includes("连接超时"))).toBe(true);
  });

  it("merges homogeneous cards and preserves every verified URL", async () => {
    const twoSources = fakeWebSearch();
    twoSources.search = vi.fn(async () => [
      { title: "评论 A", url: "https://example.com/a", snippet: "A" },
      { title: "评论 B", url: "https://example.com/b", snippet: "B" }
    ]);
    const codex: Partial<ModelProvider> = {
      generateStructured: vi.fn(async (req: { prependInstructions?: boolean }) => req.prependInstructions
        ? { value: { action: "search", query: "q" }, provider: "openai_codex", model: "gpt-test", usage: null }
        : { value: { planMarkdown: "结论", sources: [
          { ...SINGLE_SOURCE, url: "https://example.com/a", sourceUrls: ["https://example.com/a"], claim: "同一主张" },
          { ...SINGLE_SOURCE, url: "https://example.com/b", sourceUrls: ["https://example.com/b"], claim: "同一主张" }
        ] }, provider: "openai_codex", model: "gpt-test", usage: null })
    };
    const provider = new ConfiguredModelProvider(stubConnections(), codexSkills(), codex as ModelProvider, undefined, twoSources);
    const result = await provider.webResearch(context, () => {});
    expect(result.value.sources).toHaveLength(1);
    expect(result.value.sources[0].evidence?.sourceUrls).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("scheme A: model tool-calling retrieves sources, audit records retrieval", async () => {
    const { auditLog, record } = fakeAuditLog();
    let toolRound = 0;
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}");
      if (body.tools) {
        toolRound++;
        if (toolRound === 1) {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name: "web_search", arguments: JSON.stringify({ query: "检索词A" }) } }] } }]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "已完成" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ planMarkdown: "结论", sources: [SINGLE_SOURCE] }) } }],
          usage: { prompt_tokens: 1, completion_tokens: 2 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = new ConfiguredModelProvider(openaiConnections(), openaiSkills(), {} as ModelProvider, auditLog, fakeWebSearch());
      const result = await provider.webResearch(context, () => {});
      expect(result.value.sources).toHaveLength(1);
      const call = record.mock.calls.map(([entry]) => entry).find((entry) => entry.task === "research" && entry.retrieval);
      expect(call).toBeDefined();
      expect(record).toHaveBeenCalled();
      expect(call.ok).toBe(true);
      expect(call.retrieval).toEqual({ rounds: 1, sources: 1, provider: "duckduckgo" });
      expect(toolRound).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("scheme A downgrades to scheme B when tool-calling fails", async () => {
    const { auditLog, record } = fakeAuditLog();
    let plannerCalls = 0;
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}");
      if (body.tools) {
        // Force the tool-calling loop to fail; the orchestrator must fall back.
        return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500, headers: { "content-type": "application/json" } });
      }
      const schema = body.response_format?.json_schema?.schema;
      if (schema?.properties?.action) {
        plannerCalls++;
        const value = plannerCalls === 1 ? { action: "search", query: "检索词B" } : { action: "done", query: "" };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ planMarkdown: "结论", sources: [SINGLE_SOURCE] }) } }],
          usage: { prompt_tokens: 1, completion_tokens: 2 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const provider = new ConfiguredModelProvider(openaiConnections(), openaiSkills(), {} as ModelProvider, auditLog, fakeWebSearch());
      const result = await provider.webResearch(context, () => {});
      expect(result.value.sources).toHaveLength(1);
      const call = record.mock.calls.map(([entry]) => entry).find((entry) => entry.task === "research" && entry.retrieval);
      expect(call).toBeDefined();
      expect(call.ok).toBe(true);
      // scheme A contributed 0 rounds (it threw); scheme B contributed 1.
      expect(call.retrieval).toEqual({ rounds: 1, sources: 1, provider: "duckduckgo" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("throws ModelProviderUnavailableError when retrieval yields no sources", async () => {
    const { auditLog, record } = fakeAuditLog();
    const emptySearch: WebSearchClient = {
      search: vi.fn(async () => []),
      extract: vi.fn(async () => ({ content: "x" })),
      activeProviderId: "duckduckgo"
    } as unknown as WebSearchClient;
    let plannerCalls = 0;
    const codex: Partial<ModelProvider> = {
      generateStructured: vi.fn(async (req: { prependInstructions?: boolean }) => {
        if (req.prependInstructions === true) {
          plannerCalls++;
          return { value: plannerCalls === 1 ? { action: "search", query: "q" } : { action: "done", query: "" }, provider: "openai_codex", model: "gpt-test", usage: null };
        }
        return { value: { planMarkdown: "x", sources: [] }, provider: "openai_codex", model: "gpt-test", usage: null };
      })
    };
    const provider = new ConfiguredModelProvider(stubConnections(), codexSkills(), codex as unknown as ModelProvider, auditLog, emptySearch);

    await expect(provider.webResearch(context, () => {})).rejects.toThrow(/未获取到任何可用资料/);
    const call = record.mock.calls.map(([entry]) => entry).find((entry) => entry.task === "research-orchestration" && !entry.ok);
    expect(call).toBeDefined();
    expect(call.ok).toBe(false);
    expect(call.error).toMatch(/未获取到任何可用资料/);
  });

  it("throws a clear, actionable error when the web-research skill has no provider assigned", async () => {
    const { auditLog, record } = fakeAuditLog();
    const noProviderSkills = {
      get: () => ({ enabled: true, name: "联网资料补研", provider: null }),
      instructionsFor: () => "RULES"
    } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1];
    const provider = new ConfiguredModelProvider(stubConnections(), noProviderSkills, codexPlannerThenSynthesis(), auditLog, fakeWebSearch());

    await expect(provider.webResearch(context, () => {})).rejects.toThrow(/尚未指定模型|技能与模型/);
    const call = record.mock.calls[0][0];
    expect(call.ok).toBe(false);
    expect(call.error).toMatch(/尚未指定模型/);
  });
});

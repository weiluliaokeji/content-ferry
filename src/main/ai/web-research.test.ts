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
  sourceType: "public" as const
};

function fakeAuditLog() {
  const record = vi.fn<void, [AiAuditCall]>();
  const auditLog = { record, clear: vi.fn() } as unknown as AiAuditLog;
  return { auditLog, record };
}

function fakeWebSearch(): WebSearchClient {
  const search = vi.fn(async (query: string): Promise<SearchResultItem[]> => [
    { title: `结果 ${query}`, url: `https://example.com/${encodeURIComponent(query)}`, snippet: `摘要 ${query}` }
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
      provider === "openai"
        ? { modelId: "gpt-4o", enabled: true, credentialConfigured: true, displayName: "OpenAI", baseUrl: "https://api.openai.com/v1", proxyUrl: "" }
        : { modelId: "", enabled: false, credentialConfigured: false, displayName: "x", baseUrl: "", proxyUrl: "" },
    getCredential: () => "test-key"
  } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
}

function openaiSkills() {
  return {
    get: () => ({ enabled: true, name: "联网资料补研", provider: "openai" }),
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
        const value = plannerCalls === 1 ? { action: "search", query: "检索词一" } : { action: "done" };
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
    expect(record).toHaveBeenCalledTimes(1);
    const call = record.mock.calls[0][0];
    expect(call.ok).toBe(true);
    expect(call.retrieval).toEqual({ rounds: 1, sources: 1, provider: "duckduckgo" });
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
      expect(record).toHaveBeenCalledTimes(1);
      const call = record.mock.calls[0][0];
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
        const value = plannerCalls === 1 ? { action: "search", query: "检索词B" } : { action: "done" };
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
      const call = record.mock.calls[0][0];
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
          return { value: plannerCalls === 1 ? { action: "search", query: "q" } : { action: "done" }, provider: "openai_codex", model: "gpt-test", usage: null };
        }
        return { value: { planMarkdown: "x", sources: [] }, provider: "openai_codex", model: "gpt-test", usage: null };
      })
    };
    const provider = new ConfiguredModelProvider(stubConnections(), codexSkills(), codex as unknown as ModelProvider, auditLog, emptySearch);

    await expect(provider.webResearch(context, () => {})).rejects.toThrow(/未获取到任何可用资料/);
    const call = record.mock.calls[0][0];
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

import { describe, it, expect, vi } from "vitest";
import { ConfiguredModelProvider } from "./configured-model-provider";
import type { ModelProvider, GenerateStructuredResult } from "./model-provider";
import type { AiAuditLog, AiAuditCall } from "./ai-audit-log";

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
    get: () => ({ modelId: "gpt-test", enabled: true, credentialConfigured: true, displayName: "测试", baseUrl: "", proxyUrl: "" })
  } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
}

function stubSkills() {
  return {
    get: () => ({ enabled: true, name: "测试技能", provider: "openai_codex" }),
    instructionsFor: (_id: string, _prompt: string) => "RULES"
  } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1];
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
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), codex, auditLog);

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
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), failingCodex, auditLog);

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
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), codex, auditLog);

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

  it("skips recording when no audit log is provided", async () => {
    const codex = stubCodex({ title: "x" });
    const provider = new ConfiguredModelProvider(stubConnections(), stubSkills(), codex);
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

  it("records the research-provider guard failure (thrown before any model call) in the audit log", async () => {
    const { auditLog, record } = fakeAuditLog();
    const nonCodexSkills = {
      get: () => ({ enabled: true, name: "联网资料补研", provider: "openai" }),
      instructionsFor: (_id: string, _prompt: string) => "RULES"
    } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[1];
    const codex = stubCodex({ title: "x" });
    const provider = new ConfiguredModelProvider(stubConnections(), nonCodexSkills, codex, auditLog);

    await expect(
      provider.generateStructured({
        task: "research",
        skillId: "web-research",
        prompt: "主题",
        outputSchema: { type: "object", properties: {}, required: [], additionalProperties: true },
        parse: (value) => value as Record<string, unknown>,
        timeoutMs: 1000
      })
    ).rejects.toThrow(/OpenAI Codex/);

    expect(record).toHaveBeenCalledTimes(1);
    const call = record.mock.calls[0][0];
    expect(call.ok).toBe(false);
    expect(call.error).toMatch(/OpenAI Codex/);
    expect(call.skillId).toBe("web-research");
    // Issue 1: even a pre-call failure records which provider/model was targeted.
    expect(call.provider).toBe("openai");
    expect(call.model).toBe("gpt-test");
  });
});

function openrouterConnections() {
  return {
    get: (provider: string) =>
      provider === "openrouter"
        ? { modelId: "openai/gpt-5-mini", enabled: true, credentialConfigured: true, displayName: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", proxyUrl: "" }
        : { modelId: "", enabled: false, credentialConfigured: false, displayName: "x", baseUrl: "", proxyUrl: "" },
    getCredential: () => "test-key"
  } as unknown as ConstructorParameters<typeof ConfiguredModelProvider>[0];
}

function openrouterSkills() {
  return {
    get: () => ({ enabled: true, name: "测试技能", provider: "openrouter" }),
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
      const provider = new ConfiguredModelProvider(openrouterConnections(), openrouterSkills(), codex);
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
      const provider = new ConfiguredModelProvider(openrouterConnections(), openrouterSkills(), codex, auditLog);
      await provider.generateStructured({
        task: "outline",
        skillId: "wechat-writing",
        prompt: "主题",
        outputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
        parse: (value) => value as { title: string },
        timeoutMs: 1000
      });
      const call = record.mock.calls[0][0];
      expect(call.provider).toBe("openrouter");
      expect(call.model).toBe("openai/gpt-5-mini");
    } finally {
      globalThis.fetch = original;
    }
  });
});

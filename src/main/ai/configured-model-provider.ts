import type { ModelConnectionRepository, ModelProviderId } from "./model-connection-repository";
import {
  ModelProviderUnavailableError,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type GenerateMarkdownStreamRequest,
  type ModelProvider,
  type WebResearchOptions
} from "./model-provider";
import type { SkillRegistry } from "../skills/skill-registry";
import { type AiAuditLog } from "./ai-audit-log";
import {
  type WebSearchClient,
  WebSearchError
} from "./web-search";
import {
  buildPlannerPrompt,
  buildResearchSynthesisPrompt,
  buildResearchFollowUpSynthesisPrompt,
  type ResearchCard,
  type SearchSourceForPrompt,
  type WebResearchContext,
  RESEARCH_SCHEMA,
  researchOutput
} from "./research-prompts";

type CopilotSdk = typeof import("@github/copilot-sdk");
const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<CopilotSdk>;

const MAX_RESEARCH_ROUNDS = 5;

export class ConfiguredModelProvider implements ModelProvider {
  readonly id = "configured";

  constructor(
    private readonly connections: ModelConnectionRepository,
    private readonly skills: SkillRegistry,
    private readonly codexProvider: ModelProvider,
    private readonly auditLog?: AiAuditLog,
    private readonly webSearch?: WebSearchClient
  ) {}

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> {
    const skillId = request.skillId ?? (request.task === "revision"
      ? "humanize-selection"
      : request.task === "summary"
        ? "article-summary"
        : "wechat-writing");
    // The audit envelope wraps the whole call, so failures that happen *before*
    // the model call (skill disabled) are recorded too — not just errors
    // coming back from the model.
    const meta: { task: string; skillId: string; prompt: string; provider?: string; model?: string; retrieval?: { rounds: number; sources: number; provider: string | null } | null } = { task: request.task, skillId, prompt: request.prompt };
    return this.withAudit(meta, async () => {
      const skill = this.skills.get(skillId);
      if (!skill.enabled) throw new ModelProviderUnavailableError(`“${skill.name}”技能已停用。`);
      const provider = skill.provider ?? "openai_codex";
      meta.provider = provider;
      meta.model = this.modelIdFor(provider);
      return this.dispatchStructured(provider, request, meta);
    });
  }

  async generateMarkdownStream(request: GenerateMarkdownStreamRequest): Promise<GenerateStructuredResult<{ markdown: string }>> {
    const skillId = request.skillId ?? "wechat-writing";
    const meta: { task: string; skillId: string; prompt: string; provider?: string; model?: string; retrieval?: { rounds: number; sources: number; provider: string | null } | null } = { task: request.task, skillId, prompt: request.prompt };
    return this.withAudit(meta, async () => {
      const skill = this.skills.get(skillId);
      if (!skill.enabled) throw new ModelProviderUnavailableError(`“${skill.name}”技能已停用。`);
      meta.provider = skill.provider ?? "openai_codex";
      meta.model = this.modelIdFor(meta.provider);
      const enriched = { ...request, prompt: `请遵循以下 ContentFerry 技能说明：\n\n${this.skills.instructionsFor(skillId, request.prompt)}\n\n本次任务：\n${request.prompt}` };
      if (skill.provider === "openai_codex" || !skill.provider) {
        if (!this.codexProvider.generateMarkdownStream) throw new ModelProviderUnavailableError("当前 Codex 连接不支持流式生成。");
        return this.codexProvider.generateMarkdownStream!({ ...enriched, modelId: this.connections.get("openai_codex").modelId });
      }
      const generated = await this.generateStructured({
        task: request.task,
        skillId,
        prompt: request.prompt,
        outputSchema: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"], additionalProperties: false },
        parse: (value) => value as { markdown: string },
        timeoutMs: request.timeoutMs
      });
      request.onDelta(generated.value.markdown);
      return generated;
    });
  }

  /** Model-agnostic web research: app-owned retrieval + LLM synthesis.
   *  Multi-round exploration is preserved — scheme B (text planner) is the
   *  universal path; scheme A (model tool-calling) is used when the selected
   *  provider supports tools, and falls back to scheme B if it stalls. */
  async webResearch(context: WebResearchContext, onStatus?: (message: string) => void, options?: WebResearchOptions): Promise<GenerateStructuredResult<ResearchCard>> {
    const skillId = "web-research";
    const meta: { task: string; skillId: string; prompt: string; provider?: string; model?: string; retrieval?: { rounds: number; sources: number; provider: string | null } | null } = { task: "research", skillId, prompt: "" };
    return this.withAudit(meta, async () => {
      if (!this.webSearch) throw new ModelProviderUnavailableError("联网检索服务未初始化。");
      const skill = this.skills.get(skillId);
      if (!skill.enabled) throw new ModelProviderUnavailableError(`“${skill.name}”技能已停用。`);
      // After the web-research decoupling, synthesis can run on ANY configured
      // text model — there is no reason to silently fall back to Codex. Require
      // an explicit per-skill provider so the model used always matches what the
      // user picked in 技能与模型.
      if (!skill.provider) throw new ModelProviderUnavailableError(`“${skill.name}”尚未指定模型。请在“技能与模型”中为该技能选择一个模型连接后再试。`);
      const provider = skill.provider;
      meta.provider = provider;
      meta.model = this.modelIdFor(provider);
      const instructions = this.skills.instructionsFor(skillId, "");
      const onStatusHook = onStatus ?? (() => {});
      const accumulated: SearchSourceForPrompt[] = [];
      let rounds = 0;

      if (this.providerSupportsTools(provider)) {
        try {
          rounds += await this.gatherSchemeA(provider, context, accumulated, onStatusHook);
        } catch {
          onStatusHook("工具调用检索未成功，改用规划式检索继续补充资料…");
        }
      }
      if (accumulated.length === 0) {
        rounds += await this.gatherSchemeB(provider, context, accumulated, onStatusHook, MAX_RESEARCH_ROUNDS - rounds);
      }

      if (accumulated.length === 0) {
        throw new ModelProviderUnavailableError("联网检索未获取到任何可用资料，请检查网络或配置搜索服务后重试。");
      }

      const synthesisPrompt = options?.instruction
        ? buildResearchFollowUpSynthesisPrompt(context, accumulated, options.instruction, instructions)
        : buildResearchSynthesisPrompt(context, accumulated, instructions);
      meta.prompt = synthesisPrompt;
      const card = await this.dispatchResearchSynthesis(provider, synthesisPrompt, onStatusHook);
      meta.retrieval = { rounds, sources: accumulated.length, provider: this.webSearch.activeProviderId };
      return card;
    });
  }

  // --- research retrieval schemes -------------------------------------------

  /** Scheme B: app drives the loop; the model returns a JSON plan each round. */
  private async gatherSchemeB(provider: string, context: WebResearchContext, accumulated: SearchSourceForPrompt[], onStatus: (m: string) => void, maxRounds: number): Promise<number> {
    const plannerSchema = {
      type: "object",
      properties: { action: { type: "string", enum: ["search", "done"] }, query: { type: "string" } },
      required: ["action"],
      additionalProperties: false
    } as const;
    let rounds = 0;
    for (let round = 1; round <= maxRounds; round++) {
      onStatus(`第 ${round} 轮研究：规划检索方向…`);
      const plan = await this.dispatchPlanner(provider, context, accumulated, round, maxRounds, onStatus);
      if (plan.action === "done") break;
      const query = (plan.query ?? "").trim();
      if (!query) break;
      rounds++;
      onStatus(`第 ${round} 轮研究：检索「${query}」`);
      const results = await this.webSearch!.search(query);
      onStatus(`第 ${round} 轮研究：找到 ${results.length} 条资料`);
      for (const r of results) accumulated.push({ title: r.title, url: r.url, snippet: r.snippet, sourceType: "public" });
    }
    return rounds;
  }

  /** Scheme A: the model calls our web_search tool; we execute it and feed
   *  results back, looping until the model stops calling tools. */
  private async gatherSchemeA(provider: string, context: WebResearchContext, accumulated: SearchSourceForPrompt[], onStatus: (m: string) => void): Promise<number> {
    const tool = {
      name: "web_search",
      description: "检索网页，返回相关结果的标题、URL 与摘要，用于为文章补研查找官方与公开资料。",
      parameters: { type: "object", properties: { query: { type: "string", description: "检索词" } }, required: ["query"], additionalProperties: false }
    };
    let rounds = 0;
    await this.generateWithTools(provider, {
      system: `你是阿文，正在为一篇中文自媒体文章做联网补研。你拥有 web_search 工具，主动调用它查找官方与公开资料，必要时多次检索，覆盖事实、限制、反例与使用路径。资料足够时，停止调用工具，用一段中文说明本次补研结论。\n文章主题：${context.topic}\n写作目标：${context.objective}\n核心角度：${context.angle}`,
      user: `请开始检索：主题「${context.topic}」`,
      tools: [tool],
      maxRounds: MAX_RESEARCH_ROUNDS,
      onStatus,
      toolHandler: async (name, args) => {
        if (name !== "web_search") return "未知工具。";
        const query = String((args as { query?: string }).query ?? "").trim();
        if (!query) return "缺少检索词。";
        rounds++;
        onStatus(`第 ${rounds} 轮检索：正在搜索「${query}」`);
        const results = await this.webSearch!.search(query);
        onStatus(`第 ${rounds} 轮检索：找到 ${results.length} 条资料`);
        for (const r of results) accumulated.push({ title: r.title, url: r.url, snippet: r.snippet, sourceType: "public" });
        return JSON.stringify(results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })));
      }
    });
    return rounds;
  }

  private async dispatchPlanner(provider: string, context: WebResearchContext, accumulated: SearchSourceForPrompt[], round: number, maxRounds: number, onStatus: (m: string) => void): Promise<{ action: "search" | "done"; query?: string }> {
    const prompt = buildPlannerPrompt(context, accumulated, round, maxRounds);
    const result = await this.dispatchStructured<{ action: string; query?: string }>(provider, {
      task: "research",
      skillId: "web-research",
      prompt,
      outputSchema: {
        type: "object",
        properties: { action: { type: "string", enum: ["search", "done"] }, query: { type: "string" } },
        required: ["action"],
        additionalProperties: false
      },
      timeoutMs: 60_000,
      parse: (value) => value as { action: string; query?: string },
      prependInstructions: true,
      onStatus
    });
    const value = result.value;
    return { action: value.action === "done" ? "done" : "search", query: value.query };
  }

  private async dispatchResearchSynthesis(provider: string, prompt: string, onStatus: (m: string) => void): Promise<GenerateStructuredResult<ResearchCard>> {
    return this.dispatchStructured<ResearchCard>(provider, {
      task: "research",
      skillId: "web-research",
      prompt,
      outputSchema: RESEARCH_SCHEMA as object,
      timeoutMs: 240_000,
      parse: (value) => researchOutput.parse(value) as ResearchCard,
      prependInstructions: false,
      onStatus
    });
  }

  private providerSupportsTools(provider: string): boolean {
    return ["openai", "openrouter", "nous", "nvidia_build"].includes(provider);
  }

  /** OpenAI-compatible tool loop: runs until the model stops emitting tool
   *  calls, executing our handler each time. */
  private async generateWithTools(
    provider: string,
    params: {
      system: string;
      user: string;
      tools: Array<{ name: string; description: string; parameters: object }>;
      toolHandler: (name: string, args: unknown) => Promise<string>;
      maxRounds?: number;
      onStatus: (message: string) => void;
    }
  ): Promise<{ finalText: string }> {
    const connection = this.connections.get(provider as ModelProviderId);
    if (!connection.enabled) throw new WebSearchError(`${connection.displayName} 连接已停用。`);
    const apiKey = this.connections.getCredential(provider as ModelProviderId);
    const baseUrl = connection.baseUrl.replace(/\/+$/, "");
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: params.system },
      { role: "user", content: params.user }
    ];
    const maxRounds = params.maxRounds ?? MAX_RESEARCH_ROUNDS;
    for (let i = 0; i < maxRounds; i++) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: connection.modelId,
          messages,
          tools: params.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
          tool_choice: "auto"
        }),
        signal: AbortSignal.timeout(180_000)
      });
      if (!res.ok) throw new WebSearchError(`${connection.displayName} 工具调用失败（HTTP ${res.status}）。`);
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new WebSearchError("工具调用未返回有效响应。");
      messages.push(msg as Record<string, unknown>);
      if (msg.tool_calls && msg.tool_calls.length) {
        for (const tc of msg.tool_calls) {
          let args: unknown = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            args = {};
          }
          const resultText = await params.toolHandler(tc.function.name, args);
          messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
        }
        continue;
      }
      return { finalText: msg.content ?? "" };
    }
    throw new WebSearchError("工具调用检索超过最大轮数。");
  }

  // --- dispatch ---------------------------------------------------------------

  private async dispatchStructured<T>(provider: string, request: GenerateStructuredRequest<T>, meta?: { prompt: string }): Promise<GenerateStructuredResult<T>> {
    const enrichedPrompt = request.prependInstructions === false
      ? request.prompt
      : `请遵循以下 ContentFerry 技能说明：\n\n${this.skills.instructionsFor(request.skillId ?? "wechat-writing", request.prompt)}\n\n本次任务：\n${request.prompt}`;
    // Record the prompt that actually reaches the model (with skill instructions)
    // so the audit log reflects reality, not just the caller-supplied text.
    if (meta) meta.prompt = enrichedPrompt;
    const enriched: GenerateStructuredRequest<T> = { ...request, prompt: enrichedPrompt };
    if (provider === "openai_codex") {
      return this.codexProvider.generateStructured({ ...enriched, modelId: this.connections.get("openai_codex").modelId, onStatus: request.onStatus });
    }
    if (provider === "openai" || provider === "openrouter" || provider === "nous" || provider === "nvidia_build") {
      return this.generateOpenAiCompatible(provider, enriched);
    }
    if (provider === "github_copilot") return this.generateWithCopilot(enriched);
    throw new ModelProviderUnavailableError(`当前选择的 ${provider} 不能用于文本生成。`);
  }

  /** Wraps a model call so the full prompt/response are recorded when audit is on.
   *  Re-entrancy is guarded so the structured fallback inside generateMarkdownStream
   *  is not double-logged. */
  private auditInFlight = false;
  private async withAudit<T>(
    meta: { task: string; skillId: string; prompt: string; provider?: string; model?: string; retrieval?: { rounds: number; sources: number; provider: string | null } | null },
    body: () => Promise<GenerateStructuredResult<T>>
  ): Promise<GenerateStructuredResult<T>> {
    if (!this.auditLog || this.auditInFlight) return body();
    const start = Date.now();
    this.auditInFlight = true;
    try {
      const result = await body();
      this.auditLog.record({
        task: meta.task,
        skillId: meta.skillId,
        prompt: meta.prompt,
        provider: result.provider ?? meta.provider ?? null,
        model: result.model ?? (meta.model || null),
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        cachedInputTokens: result.usage?.cachedInputTokens ?? null,
        reasoningOutputTokens: result.usage?.reasoningOutputTokens ?? null,
        durationMs: Date.now() - start,
        ok: true,
        response: JSON.stringify(result.value),
        error: null,
        retrieval: meta.retrieval ?? null
      });
      return result;
    } catch (error) {
      this.auditLog.record({
        task: meta.task,
        skillId: meta.skillId,
        prompt: meta.prompt,
        provider: meta.provider ?? null,
        model: meta.model || null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningOutputTokens: null,
        durationMs: Date.now() - start,
        ok: false,
        response: null,
        error: error instanceof Error ? error.message : String(error),
        retrieval: meta.retrieval ?? null
      });
      throw error;
    } finally {
      this.auditInFlight = false;
    }
  }

  /** Resolves the configured model id for a provider so the audit log can show
   *  which model was targeted even when the call fails before reaching the API. */
  private modelIdFor(provider: string): string {
    const known: ModelProviderId[] = [
      "openai_codex", "openai", "openrouter", "nous", "nvidia_build", "github_copilot"
    ];
    return known.includes(provider as ModelProviderId)
      ? this.connections.get(provider as ModelProviderId).modelId || ""
      : "";
  }

  private async generateOpenAiCompatible<T>(
    provider: "openai" | "openrouter" | "nous" | "nvidia_build",
    request: GenerateStructuredRequest<T>
  ): Promise<GenerateStructuredResult<T>> {
    const connection = this.connections.get(provider);
    if (!connection.enabled) throw new ModelProviderUnavailableError(`${connection.displayName} 连接已停用。`);
    const apiKey = this.connections.getCredential(provider);
    const baseUrl = connection.baseUrl.replace(/\/+$/, "");
    const messages = [
      {
        role: "system" as const,
        content: "你是 ContentFerry 的内容工作流模型。严格按照给定 JSON Schema 返回 JSON，不要使用 Markdown 代码块。"
      },
      {
        role: "user" as const,
        content: `${request.prompt}\n\n返回值必须符合此 JSON Schema：\n${JSON.stringify(request.outputSchema)}`
      }
    ];
    const buildBody = (withSchema: boolean): string => JSON.stringify({
      model: connection.modelId,
      messages,
      ...(withSchema && provider !== "nvidia_build" ? {
        response_format: {
          type: "json_schema",
          json_schema: { name: `contentferry_${request.task}`, strict: true, schema: request.outputSchema }
        }
      } : {})
    });
    const post = async (withSchema: boolean): Promise<{ response: Response; text: string }> => {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(provider === "openrouter" ? {
            "HTTP-Referer": "https://contentferry.local",
            "X-Title": "ContentFerry"
          } : {})
        },
        body: buildBody(withSchema),
        signal: AbortSignal.timeout(request.timeoutMs ?? 180_000)
      });
      return { response, text: await response.text() };
    };

    let { response, text } = await post(true);
    // Some OpenAI-compatible models (e.g. open-weights behind OpenRouter/Nous)
    // do not support structured outputs. When the API says so, retry once
    // without response_format — the JSON instruction is already in the prompt.
    if (!response.ok && provider !== "nvidia_build" && isStructuredOutputUnsupported(response.status, text)) {
      const retried = await post(false);
      response = retried.response;
      text = retried.text;
    }
    if (!response.ok) {
      throw new ModelProviderUnavailableError(`${connection.displayName} 请求失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
    }
    const payload = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new ModelProviderUnavailableError(`${connection.displayName} 没有返回可用内容。`);
    const value = parseStructured(content, request.parse);
    return {
      value,
      provider,
      model: connection.modelId || null,
      usage: payload.usage ? {
        inputTokens: payload.usage.prompt_tokens ?? 0,
        cachedInputTokens: 0,
        outputTokens: payload.usage.completion_tokens ?? 0,
        reasoningOutputTokens: 0
      } : null
    };
  }

  private async generateWithCopilot<T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> {
    const connection = this.connections.get("github_copilot");
    if (!connection.enabled) throw new ModelProviderUnavailableError("GitHub Copilot 连接已停用。");
    const token = connection.credentialConfigured
      ? this.connections.getCredential("github_copilot")
      : undefined;
    const { CopilotClient } = await importEsm("@github/copilot-sdk");
    const client = new CopilotClient({
      ...(token ? { gitHubToken: token, useLoggedInUser: false } : { useLoggedInUser: true }),
      logLevel: "error"
    });
    try {
      await client.start();
      const session = await client.createSession({
        model: connection.modelId || "gpt-5",
        systemMessage: {
          mode: "replace",
          content: "你是 ContentFerry 的内容工作流模型。不要调用工具。严格返回符合用户提供 JSON Schema 的 JSON，不要使用 Markdown 代码块。"
        }
      });
      try {
        const result = await session.sendAndWait({
          prompt: `${request.prompt}\n\n返回值必须符合此 JSON Schema：\n${JSON.stringify(request.outputSchema)}`
        }, request.timeoutMs ?? 180_000);
        const content = result?.data.content;
        if (!content) throw new ModelProviderUnavailableError("GitHub Copilot 没有返回可用内容。");
        return {
          value: parseStructured(content, request.parse),
          provider: "github_copilot",
          model: connection.modelId || null,
          usage: null
        };
      } finally {
        await session.disconnect();
      }
    } catch (error) {
      if (error instanceof ModelProviderUnavailableError) throw error;
      throw new ModelProviderUnavailableError(`GitHub Copilot 生成失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.stop().catch(() => []);
    }
  }
}

function parseStructured<T>(content: string, parse: (value: unknown) => T): T {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return parse(JSON.parse(normalized));
  } catch (error) {
    throw new ModelProviderUnavailableError("模型返回的结构不完整，请重新生成。", { cause: error });
  }
}

/** True when a failed chat/completions call is due to the model not supporting
 *  OpenAI-style structured outputs, so we can fall back to a plain JSON prompt. */
function isStructuredOutputUnsupported(status: number, body: string): boolean {
  if (status !== 400) return false;
  return /structured output|response_format|INVALID_REQUEST_BODY|json_schema|not support/i.test(body);
}

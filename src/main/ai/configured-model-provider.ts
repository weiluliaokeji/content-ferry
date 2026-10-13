import { CUSTOM_PROVIDER_PREFIX, type ModelConnection, type ModelConnectionRepository } from "./model-connection-repository";
import {
  ModelProviderUnavailableError,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type GenerateMarkdownStreamRequest,
  type ReviewImageRequest,
  type ModelProvider,
  type WebResearchOptions
} from "./model-provider";
import type { SkillRegistry } from "../skills/skill-registry";
import { type AiAuditLog } from "./ai-audit-log";
import {
  type WebSearchClient,
  WebSearchError
} from "./web-search";
import { ToolRunner } from "../agent/tool-runner";
import {
  buildPlannerPrompt,
  formatResearchSearchHistory,
  buildResearchSynthesisPrompt,
  buildResearchFollowUpSynthesisPrompt,
  type ResearchCard,
  type SearchSourceForPrompt,
  type WebResearchContext,
  RESEARCH_SCHEMA,
  researchOutput
} from "./research-prompts";

import { ProxyAgent, fetch as undiciFetch } from "undici";
import { createHash, randomUUID } from "node:crypto";
import type { ResearchDepth, ResearchExecution, ResearchSearchAttempt } from "../../shared/research-state";
import type { ResearchEvidence, ResearchEvidenceSnapshot } from "../../shared/research-evidence";
import { loadAppSettings } from "../config/first-run";

const RESEARCH_ROUNDS_BY_DEPTH: Record<ResearchDepth, number> = { quick: 1, balanced: 3, deep: 5 };
type AuditMeta = { task: string; skillId: string; prompt: string; provider?: string; model?: string; correlationId?: string; retrieval?: { rounds: number; sources: number; provider: string | null } | null };

export class ConfiguredModelProvider implements ModelProvider {
  readonly id = "configured";

  constructor(
    private readonly connections: ModelConnectionRepository,
    private readonly skills: SkillRegistry,
    private readonly codexProvider: ModelProvider,
    private readonly auditLog?: AiAuditLog,
    private readonly webSearch?: WebSearchClient
  ) {
    this.researchTools = new ToolRunner([{
      id: "web_search",
      run: async (input) => {
        const query = String((input as { query?: unknown }).query ?? "").trim();
        if (!query) throw new WebSearchError("缺少检索词。");
        if (!this.webSearch) throw new WebSearchError("联网检索服务未初始化。");
        return this.webSearch.search(query);
      }
    }]);
  }

  private readonly researchTools: ToolRunner;

  /** Calls the OpenAI-compatible /chat/completions endpoint. Honors the connection's
   *  proxyUrl (via undici ProxyAgent) and surfaces the underlying network error cause
   *  (DNS/TLS/connection) instead of the opaque "fetch failed". */
  private async callChatCompletions(connection: ModelConnection, init: RequestInit): Promise<Response> {
    const baseUrl = connection.baseUrl.replace(/\/+$/, "");
    const proxyUrl = connection.proxyUrl.trim();
    const url = `${baseUrl}/chat/completions`;
    const perform = proxyUrl
      ? () => undiciFetch(url, { ...init, dispatcher: new ProxyAgent(proxyUrl) } as Parameters<typeof undiciFetch>[1])
      : () => fetch(url, init);
    try {
      return await perform();
    } catch (error) {
      const base = `${connection.displayName} 无法连接到模型服务（${url}）`;
      const cause = error instanceof Error && (error as { cause?: unknown }).cause instanceof Error
        ? (error as { cause: Error }).cause.message
        : error instanceof Error ? error.message : String(error);
      throw new ModelProviderUnavailableError(`${base}：${cause}`);
    }
  }

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> {
    const skillId = request.skillId ?? (request.task === "revision"
      ? "humanize-selection"
      : request.task === "summary"
        ? "article-summary"
        : "wechat-writing");
    // The audit envelope wraps the whole call, so failures that happen *before*
    // the model call (skill disabled) are recorded too — not just errors
    // coming back from the model.
    const meta: AuditMeta = { task: request.task, skillId, prompt: request.prompt, correlationId: randomUUID() };
    const skill = this.skills.get(skillId);
    if (!skill.enabled) {
      return this.withAudit(meta, async () => {
        throw new ModelProviderUnavailableError(`“${skill.name}”技能已停用。`);
      });
    }
    const provider = skill.provider ?? "openai_codex";
    meta.provider = provider;
    meta.model = this.modelIdFor(provider);
    return provider.startsWith(CUSTOM_PROVIDER_PREFIX) && this.connections.get(provider).enabled
      ? this.dispatchStructured(provider, request, meta)
      : this.withAudit(meta, () => this.dispatchStructured(provider, request, meta));
  }

  async generateMarkdownStream(request: GenerateMarkdownStreamRequest): Promise<GenerateStructuredResult<{ markdown: string }>> {
    const skillId = request.skillId ?? "wechat-writing";
    const meta: AuditMeta = { task: request.task, skillId, prompt: request.prompt, correlationId: randomUUID() };
    const skill = this.skills.get(skillId);
    if (!skill.enabled) {
      return this.withAudit(meta, async () => {
        throw new ModelProviderUnavailableError(`“${skill.name}”技能已停用。`);
      });
    }
    meta.provider = skill.provider ?? "openai_codex";
    meta.model = this.modelIdFor(meta.provider);
    if (skill.provider === "openai_codex" || !skill.provider) {
      if (this.codexProvider.generateMarkdownStream) {
        return this.withAudit(meta, async () => {
          const enriched = { ...request, prompt: `请遵循以下 ContentFerry 技能说明：\n\n${this.skills.instructionsFor(skillId, request.prompt)}\n\n本次任务：\n${request.prompt}` };
          return this.codexProvider.generateMarkdownStream!({ ...enriched, modelId: this.connections.get("openai_codex").modelId });
        });
      }
      request.onStatus?.("当前模型不支持流式输出，正在改用普通生成模式…");
      const generated = await this.generateStructured({
        task: request.task,
        skillId,
        prompt: request.prompt,
        outputSchema: { type: "object", properties: { markdown: { type: "string" } }, required: ["markdown"], additionalProperties: false },
        parse: (value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)
            || typeof (value as Record<string, unknown>).markdown !== "string") {
            throw new Error("模型没有返回 Markdown 正文。");
          }
          return { markdown: (value as { markdown: string }).markdown };
        },
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        onStatus: request.onStatus
      });
      request.onDelta(generated.value.markdown);
      return generated;
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
  }

  async reviewImage<T>(request: ReviewImageRequest<T>): Promise<GenerateStructuredResult<T>> {
    const settings = loadAppSettings();
    if (settings.imageReviewMode === "disabled") {
      throw new ModelProviderUnavailableError("图片视觉初审尚未启用，请先在“技能与模型”中配置。");
    }
    const currentProvider = this.skills.get("awen-assistant").provider ?? "openai_codex";
    const provider = settings.imageReviewMode === "specific"
      ? settings.imageReviewProvider
      : currentProvider;
    if (!provider) throw new ModelProviderUnavailableError("图片视觉初审没有可用的模型连接。");
    const connection = this.connections.get(provider);
    if (!connection.enabled) throw new ModelProviderUnavailableError(`${connection.displayName} 连接已停用。`);
    if (connection.visionInputSupport === "unsupported") {
      throw new ModelProviderUnavailableError(`${connection.displayName} 当前不支持图片输入。`);
    }
    if (provider !== "openai_codex" || !this.codexProvider.reviewImage) {
      throw new ModelProviderUnavailableError(`${connection.displayName} 的图片输入能力尚未完成适配，已回退人工判断。`);
    }
    const meta: AuditMeta = {
      task: "image_review",
      skillId: "image-review",
      prompt: request.prompt,
      provider,
      model: connection.modelId,
      correlationId: randomUUID()
    };
    return this.withAudit(meta, () => this.codexProvider.reviewImage!({
      ...request,
      modelId: connection.modelId
    }));
  }

  /** Model-agnostic web research: app-owned retrieval + LLM synthesis.
   *  Multi-round exploration is preserved — scheme B (text planner) is the
   *  universal path; scheme A (model tool-calling) is used when the selected
   *  provider supports tools, and falls back to scheme B if it stalls. */
  async webResearch(context: WebResearchContext, onStatus?: (message: string) => void, options?: WebResearchOptions): Promise<GenerateStructuredResult<ResearchCard>> {
    options?.signal?.throwIfAborted();
    const skillId = "web-research";
    const correlationId = randomUUID();
    const meta: AuditMeta = { task: "research-orchestration", skillId, prompt: JSON.stringify(context), correlationId };
    if (!this.webSearch) return this.failResearch(meta, new ModelProviderUnavailableError("联网检索服务未初始化。"));
    const skill = this.skills.get(skillId);
    if (!skill.enabled) return this.failResearch(meta, new ModelProviderUnavailableError(`“${skill.name}”技能已停用。`));
    // After the web-research decoupling, synthesis can run on ANY configured
    // text model — there is no reason to silently fall back to Codex. Require
    // an explicit per-skill provider so the model used always matches what the
    // user picked in 技能与模型.
    if (!skill.provider) return this.failResearch(meta, new ModelProviderUnavailableError(`“${skill.name}”尚未指定模型。请在“技能与模型”中为该技能选择一个模型连接后再试。`));
    const provider = skill.provider;
    meta.provider = provider;
    meta.model = this.modelIdFor(provider);
    const instructions = this.skills.instructionsFor(skillId, "");
    const onStatusHook = onStatus ?? (() => {});
    const maxRounds = RESEARCH_ROUNDS_BY_DEPTH[options?.depth ?? "balanced"];
    // Keep one round available for recovery when body extraction reveals that
    // the search results were not actually usable evidence.
    const initialSearchRounds = maxRounds > 1 ? maxRounds - 1 : maxRounds;

    const accumulated: SearchSourceForPrompt[] = [];
    const searchHistory: ResearchSearchAttempt[] = [];
    for (const attempt of [...(context.searchHistory ?? []), ...(options?.previousSearches ?? [])]) {
      const normalized = normalizeResearchQuery(attempt.query);
      if (!searchHistory.some((item) => normalizeResearchQuery(item.query) === normalized)) searchHistory.push(attempt);
    }
    const researchContext = { ...context, searchHistory };
    let rounds = 0;

    if (this.providerSupportsTools(provider)) {
      try {
        rounds += await this.gatherSchemeA(provider, researchContext, accumulated, onStatusHook, initialSearchRounds, correlationId, options?.signal,
          (attempt) => options?.onSearchCompleted?.(attempt));
      } catch (error) {
        options?.signal?.throwIfAborted();
        const reason = error instanceof Error ? error.message.slice(0, 160) : "未知错误";
        onStatusHook(`工具调用检索未成功（${reason}），改用规划式检索继续补充资料…`);
      }
    }
    if (accumulated.length === 0 || (context.coverageGaps?.length && rounds < initialSearchRounds)) {
      rounds += await this.gatherSchemeB(provider, researchContext, accumulated, onStatusHook, initialSearchRounds - rounds, correlationId, options?.signal,
        (attempt) => options?.onSearchCompleted?.(attempt));
    }

    const specifiedSources = (context.specifiedSourceUrls ?? []).map((url) => ({
      title: "用户指定来源",
      url,
      snippet: "用户指定来源，必须直接核验正文。",
      sourceType: "public" as const
    }));
    // Put user-required URLs first so they are not delayed behind a long list
    // of discovered candidates.
    let candidates = [...specifiedSources, ...accumulated];
    if (candidates.length === 0 && rounds < maxRounds) {
      researchContext.coverageGaps = [
        ...(researchContext.coverageGaps ?? []),
        "前序搜索没有返回候选网页；请尝试不同关键词或官方资料入口，不要重复既有查询。"
      ];
      onStatusHook("当前查询没有找到候选网页，正在尝试另一种检索方向…");
      rounds += await this.gatherSchemeB(provider, researchContext, accumulated, onStatusHook, maxRounds - rounds, correlationId, options?.signal,
        (attempt) => options?.onSearchCompleted?.(attempt), rounds, maxRounds);
      candidates = [...specifiedSources, ...accumulated];
    }
    if (candidates.length === 0) return this.failResearch(meta, new ModelProviderUnavailableError(
      rounds >= maxRounds
        ? "联网检索没有找到候选网页；已用完本次检索轮次，请调整主题或稍后重试。"
        : "联网检索没有找到候选网页，规划器也没有可用的新检索方向。请补充关键词或指定来源后重试。"
    ));

    const extraction = await this.extractResearchSources(candidates, onStatusHook, options?.signal);
    let verifiedSources = extraction.verified;
    if (extraction.failures.length > 0 && rounds < maxRounds) {
      // Search snippets and extraction errors are never promoted to facts.
      // They only tell the planner to pivot to a different source/query.
      researchContext.coverageGaps = [
        ...(researchContext.coverageGaps ?? []),
        `上一轮有 ${extraction.failures.length} 个候选网页未能取得可核验正文；请改换来源或查询方向，不能使用搜索摘要代替正文。`
      ];
      const attemptedUrls = new Set(candidates.map((source) => canonicalUrl(source.url)));
      onStatusHook("候选网页正文未能全部核验，正在调整检索方向并寻找其他来源…");
      rounds += await this.gatherSchemeB(provider, researchContext, accumulated, onStatusHook, maxRounds - rounds, correlationId, options?.signal,
        (attempt) => options?.onSearchCompleted?.(attempt), rounds, maxRounds);
      const recoveryCandidates = accumulated.filter((source) => !attemptedUrls.has(canonicalUrl(source.url)));
      const recovery = await this.extractResearchSources(recoveryCandidates, onStatusHook, options?.signal);
      verifiedSources = [...verifiedSources, ...recovery.verified];
      extraction.failures.push(...recovery.failures);
    }
    if (verifiedSources.length === 0) return this.failResearch(meta, new ModelProviderUnavailableError(
      extraction.failures.length
        ? `已找到搜索候选，但所有网页正文提取均失败；系统已尝试调整检索方向，仍未取得可核验正文。请检查网络、搜索服务或指定来源后重试。`
        : "联网检索没有找到可核验的网页正文，请调整主题或检查搜索服务后重试。"
    ));
    const synthesisPrompt = options?.instruction
      ? buildResearchFollowUpSynthesisPrompt(context, verifiedSources, options.instruction, instructions)
      : buildResearchSynthesisPrompt(context, verifiedSources, instructions);
    meta.retrieval = { rounds, sources: verifiedSources.length, provider: this.webSearch.activeProviderId };
    const generated = await this.dispatchResearchSynthesis(provider, synthesisPrompt, onStatusHook, meta.retrieval, correlationId, options?.signal);
    options?.signal?.throwIfAborted();
    const verifiedUrls = new Set(verifiedSources.map((source) => canonicalUrl(source.url)));
    const specifiedSourceResults = (context.specifiedSourceUrls ?? []).map((url) => ({
      url,
      status: verifiedUrls.has(canonicalUrl(url)) ? "extracted" as const : "failed" as const,
      ...(verifiedUrls.has(canonicalUrl(url)) ? {} : { reason: "正文提取失败或正文为空，请打开来源后重试。" })
    }));
    return withResearchExecution({ ...generated, value: { ...generated.value, sources: attachVerifiedEvidence(generated.value.sources, verifiedSources), specifiedSourceResults } }, { rounds, maxRounds, budgetExhausted: rounds >= maxRounds });
  }

  // --- research retrieval schemes -------------------------------------------

  /** Scheme B: app drives the loop; the model returns a JSON plan each round. */
  private async gatherSchemeB(provider: string, context: WebResearchContext, accumulated: SearchSourceForPrompt[], onStatus: (m: string) => void, maxRounds: number, correlationId: string, signal?: AbortSignal,
    onSearchCompleted?: (attempt: ResearchSearchAttempt) => void, roundOffset = 0, totalRoundBudget = maxRounds): Promise<number> {
    let rounds = 0;
    const attemptedQueries = new Set((context.searchHistory ?? []).map((item) => normalizeResearchQuery(item.query)));
    for (let localRound = 1; localRound <= maxRounds; localRound++) {
      signal?.throwIfAborted();
      const round = roundOffset + localRound;
      onStatus(`第 ${round} 轮研究：规划检索方向…`);
      const plan = await this.dispatchPlanner(provider, context, accumulated, round, totalRoundBudget, onStatus, correlationId, signal);
      if (plan.action === "done") break;
      const query = (plan.query ?? "").trim();
      if (!query) break;
      const normalizedQuery = normalizeResearchQuery(query);
      if (attemptedQueries.has(normalizedQuery)) {
        onStatus(`规划器再次提出已执行过的检索「${query}」；未重复搜索，本轮补研停止。`);
        break;
      }
      attemptedQueries.add(normalizedQuery);
      rounds++;
      onStatus(`第 ${round} 轮研究：检索「${query}」`);
      const results = await this.webSearch!.search(query);
      signal?.throwIfAborted();
      onStatus(`第 ${round} 轮研究：找到 ${results.length} 条资料`);
      appendUniqueResearchCandidates(accumulated, results);
      context.searchHistory?.push({ query, resultCount: results.length, resultUrls: results.slice(0, 8).map((result) => result.url) });
      onSearchCompleted?.({ query, resultCount: results.length, resultUrls: results.slice(0, 8).map((result) => result.url) });
    }
    return rounds;
  }

  /** Scheme A: the model calls our web_search tool; we execute it and feed
   *  results back, looping until the model stops calling tools. */
  private async gatherSchemeA(provider: string, context: WebResearchContext, accumulated: SearchSourceForPrompt[], onStatus: (m: string) => void, maxRounds: number, correlationId: string, signal?: AbortSignal,
    onSearchCompleted?: (attempt: ResearchSearchAttempt) => void): Promise<number> {
    const tool = {
      name: "web_search",
      description: "检索网页，返回相关结果的标题、URL 与摘要，用于为文章补研查找官方与公开资料。",
      parameters: { type: "object", properties: { query: { type: "string", description: "检索词" } }, required: ["query"], additionalProperties: false }
    };
    let rounds = 0;
    await this.generateWithTools(provider, {
      system: `你是阿文，正在为一篇中文自媒体文章做联网补研。你拥有 web_search 工具，主动调用它查找官方与公开资料，必要时多次检索，覆盖事实、限制、反例与使用路径。不得重复已尝试的相同或实质等价查询；结果不足时要换明确不同的来源或检索方向。资料足够或没有有意义的新方法时，停止调用工具并说明缺口。检索词应提炼文章主题、核心角度和待补缺口中的实体及问题；不要把“编写/写一篇/公众号文章”等写作指令拼进查询。\n文章主题：${context.topic}\n作者原始创作要求（仅用于理解范围）：${context.creationIdea ?? context.topic}\n写作目标：${context.objective}\n核心角度：${context.angle}\n已尝试查询（仅用于避免重复，不是核验依据）：\n${formatResearchSearchHistory(context.searchHistory ?? [])}`,
      user: `请围绕文章主题「${context.topic}」开始检索；按实际缺口构造具体查询词。`,
      tools: [tool],
      maxRounds,
      onStatus,
      correlationId,
      signal,
      toolHandler: async (name, args) => {
        signal?.throwIfAborted();
        if (name !== "web_search") return "未知工具。";
        const query = String((args as { query?: string }).query ?? "").trim();
        if (!query) return "缺少检索词。";
        const normalizedQuery = normalizeResearchQuery(query);
        if ((context.searchHistory ?? []).some((item) => normalizeResearchQuery(item.query) === normalizedQuery)) {
          return "本任务的当前或前序补研已经执行过相同查询；不要再次调用，请换成确实不同的检索方法或结束并如实说明缺口。";
        }
        rounds++;
        onStatus(`第 ${rounds} 轮检索：正在搜索「${query}」`);
        const execution = await this.researchTools.run({
          toolId: "web_search",
          action: "network_read",
          risk: "low",
          defaultAllow: true,
          input: { query }
        }, []);
        signal?.throwIfAborted();
        if (execution.status !== "completed") return execution.status === "denied" ? "当前任务未获联网检索授权。" : "等待用户授权联网检索。";
        const results = execution.output as Awaited<ReturnType<WebSearchClient["search"]>>;
        onStatus(`第 ${rounds} 轮检索：找到 ${results.length} 条资料`);
        appendUniqueResearchCandidates(accumulated, results);
        const attempt = { query, resultCount: results.length, resultUrls: results.slice(0, 8).map((result) => result.url) };
        context.searchHistory?.push(attempt);
        onSearchCompleted?.(attempt);
        return JSON.stringify(results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet })));
      }
    });
    return rounds;
  }

  private async extractResearchSources(candidates: SearchSourceForPrompt[], onStatus: (message: string) => void, signal?: AbortSignal): Promise<{ verified: SearchSourceForPrompt[]; failures: string[] }> {
    const unique = [...new Map(candidates.map((source) => [canonicalUrl(source.url), source])).values()];
    const verified = new Array<SearchSourceForPrompt | undefined>(unique.length);
    const failed = new Array<string | undefined>(unique.length);
    let completed = 0;
    onStatus(`正在核验 ${unique.length} 个候选网页的正文…`);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        if (signal?.aborted) return;
        const index = nextIndex++;
        const source = unique[index];
        if (!source) return;
        try {
          const content = (await this.webSearch!.extract(source.url)).content.trim();
          signal?.throwIfAborted();
          if (!content) failed[index] = `${source.title}（正文为空）`;
          else {
            const capturedAt = new Date().toISOString();
            verified[index] = {
              ...source,
              bodyExcerpt: content.slice(0, 1600),
              capturedAt,
              sha256: createHash("sha256").update(content).digest("hex")
            };
          }
        } catch (error) {
          failed[index] = `${source.title}（${error instanceof Error ? error.message.slice(0, 120) : "提取失败"}）`;
        } finally {
          completed += 1;
          onStatus(`正文核验进度：${completed}/${unique.length}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, unique.length) }, () => worker()));
    signal?.throwIfAborted();
    const verifiedSources = verified.filter((source): source is SearchSourceForPrompt => Boolean(source));
    const failedSources = failed.filter((message): message is string => Boolean(message));
    if (failedSources.length) onStatus(`有 ${failedSources.length} 个网页正文核验失败，可重试：${failedSources.slice(0, 3).join("；")}${failedSources.length > 3 ? "；其余失败已省略" : ""}`);
    onStatus(`已核验 ${verifiedSources.length} 个网页正文。`);
    return { verified: verifiedSources, failures: failedSources };
  }

  private async dispatchPlanner(provider: string, context: WebResearchContext, accumulated: SearchSourceForPrompt[], round: number, maxRounds: number, onStatus: (m: string) => void, correlationId: string, signal?: AbortSignal): Promise<{ action: "search" | "done"; query?: string }> {
    const prompt = buildPlannerPrompt(context, accumulated, round, maxRounds);
    const request: GenerateStructuredRequest<{ action: string; query?: string }> = {
      task: "research",
      skillId: "web-research",
      prompt,
      outputSchema: {
        type: "object",
        properties: { action: { type: "string", enum: ["search", "done"] }, query: { type: "string" } },
        required: ["action", "query"],
        additionalProperties: false
      },
      timeoutMs: 60_000,
      signal,
      parse: (value) => value as { action: string; query?: string },
      prependInstructions: true,
      onStatus
    };
    const meta: AuditMeta = { task: "research", skillId: "web-research", prompt, provider, model: this.modelIdFor(provider), correlationId };
    const result = provider.startsWith(CUSTOM_PROVIDER_PREFIX)
      ? await this.dispatchStructured(provider, request, meta)
      : await this.withAudit(meta, () => this.dispatchStructured(provider, request, meta));
    const value = result.value;
    return { action: value.action === "done" ? "done" : "search", query: value.query };
  }

  private async dispatchResearchSynthesis(provider: string, prompt: string, onStatus: (m: string) => void, retrieval: { rounds: number; sources: number; provider: string | null } | undefined, correlationId: string, signal?: AbortSignal): Promise<GenerateStructuredResult<ResearchCard>> {
    const request: GenerateStructuredRequest<ResearchCard> = {
      task: "research",
      skillId: "web-research",
      prompt,
      outputSchema: RESEARCH_SCHEMA as object,
      timeoutMs: 240_000,
      signal,
      parse: (value) => researchOutput.parse(value) as ResearchCard,
      prependInstructions: false,
      onStatus
    };
    const meta: AuditMeta = { task: "research", skillId: "web-research", prompt, provider, model: this.modelIdFor(provider), retrieval: retrieval ?? null, correlationId };
    return provider.startsWith(CUSTOM_PROVIDER_PREFIX)
      ? this.dispatchStructured(provider, request, meta)
      : this.withAudit(meta, () => this.dispatchStructured(provider, request, meta));
  }

  private providerSupportsTools(provider: string): boolean {
    return provider.startsWith(CUSTOM_PROVIDER_PREFIX);
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
      correlationId: string;
      signal?: AbortSignal;
    }
  ): Promise<{ finalText: string }> {
    const connection = this.connections.get(provider);
    if (!connection.enabled) throw new WebSearchError(`${connection.displayName} 连接已停用。`);
    const apiKey = this.connections.getCredential(provider);
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: params.system },
      { role: "user", content: params.user }
    ];
    const maxRounds = params.maxRounds ?? RESEARCH_ROUNDS_BY_DEPTH.balanced;
    for (let i = 0; i < maxRounds; i++) {
      params.signal?.throwIfAborted();
      const startedAt = Date.now();
      const prompt = JSON.stringify({ messages, tools: params.tools, tool_choice: "auto" });
      let responseText: string | null = null;
      let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
      let failure: unknown = null;
      try {
        const res = await this.callChatCompletions(connection, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: connection.modelId, messages, tools: params.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: "auto" }),
          signal: params.signal ? AbortSignal.any([AbortSignal.timeout(180_000), params.signal]) : AbortSignal.timeout(180_000)
        });
        responseText = await res.text();
        if (!res.ok) throw new WebSearchError(`${connection.displayName} 工具调用失败（HTTP ${res.status}）。`);
        const data = JSON.parse(responseText) as { choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>; usage?: typeof usage };
        usage = data.usage;
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
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        this.recordRawAudit({ task: "research-tool-call", skillId: "web-research", provider, model: connection.modelId || null, prompt, response: responseText, usage, error: failure, durationMs: Date.now() - startedAt, correlationId: params.correlationId });
      }
    }
    throw new WebSearchError("工具调用检索超过最大轮数。");
  }

  // --- dispatch ---------------------------------------------------------------

  private async dispatchStructured<T>(provider: string, request: GenerateStructuredRequest<T>, meta?: AuditMeta): Promise<GenerateStructuredResult<T>> {
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
    if (provider.startsWith(CUSTOM_PROVIDER_PREFIX)) {
      return this.generateOpenAiCompatible(provider, enriched, meta);
    }
    throw new ModelProviderUnavailableError(`当前选择的 ${provider} 不能用于文本生成。`);
  }

  /** Wraps one model call so the full prompt/response are recorded when audit is on. */
  private async withAudit<T>(
    meta: AuditMeta,
    body: () => Promise<GenerateStructuredResult<T>>,
    options?: { retrieval?: (result: GenerateStructuredResult<T>) => AuditMeta["retrieval"] }
  ): Promise<GenerateStructuredResult<T>> {
    if (!this.auditLog) return body();
    const start = Date.now();
    try {
      const result = await body();
      this.auditLog.record({
        task: meta.task,
        skillId: meta.skillId,
        correlationId: meta.correlationId,
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
        retrieval: options?.retrieval?.(result) ?? meta.retrieval ?? null
      });
      return result;
    } catch (error) {
      this.auditLog.record({
        task: meta.task,
        skillId: meta.skillId,
        correlationId: meta.correlationId,
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
        error: error instanceof Error
          ? error.message + ((error as { cause?: unknown }).cause instanceof Error ? ` · ${(error as { cause: Error }).cause.message}` : "")
          : String(error),
        retrieval: meta.retrieval ?? null
      });
      throw error;
    }
  }

  private recordRawAudit(input: {
    task: string;
    skillId: string;
    correlationId?: string;
    retrieval?: AuditMeta["retrieval"];
    provider: string;
    model: string | null;
    prompt: string;
    response: string | null;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error: unknown;
    durationMs: number;
  }): void {
    if (!this.auditLog) return;
    this.auditLog.record({
      task: input.task,
      skillId: input.skillId,
      correlationId: input.correlationId,
      provider: input.provider,
      model: input.model,
      inputTokens: input.usage?.prompt_tokens ?? null,
      outputTokens: input.usage?.completion_tokens ?? null,
      cachedInputTokens: null,
      reasoningOutputTokens: null,
      durationMs: input.durationMs,
      ok: !input.error,
      prompt: input.prompt,
      response: input.response,
      error: input.error instanceof Error ? input.error.message : input.error ? String(input.error) : null,
      retrieval: input.retrieval ?? null
    });
  }

  private recordAuditFailure(meta: AuditMeta, error: unknown): void {
    if (!this.auditLog) return;
    this.auditLog.record({
      task: meta.task,
      skillId: meta.skillId,
      correlationId: meta.correlationId,
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      reasoningOutputTokens: null,
      durationMs: 0,
      ok: false,
      prompt: meta.prompt,
      response: null,
      error: error instanceof Error ? error.message : String(error),
      retrieval: meta.retrieval ?? null
    });
  }

  private failResearch(meta: AuditMeta, error: Error): never {
    this.recordAuditFailure(meta, error);
    throw error;
  }

  /** Resolves the configured model id for a provider so the audit log can show
   *  which model was targeted even when the call fails before reaching the API. */
  private modelIdFor(provider: string): string {
    return this.connections.get(provider).modelId || "";
  }

  private async generateOpenAiCompatible<T>(
    provider: string,
    request: GenerateStructuredRequest<T>,
    auditMeta?: AuditMeta
  ): Promise<GenerateStructuredResult<T>> {
    const connection = this.connections.get(provider);
    if (!connection.enabled) throw new ModelProviderUnavailableError(`${connection.displayName} 连接已停用。`);
    const apiKey = this.connections.getCredential(provider);
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
    type DraftRetryMode = "incomplete_json" | "near_output_budget";
    const buildBody = (withSchema: boolean, retryMode?: DraftRetryMode): string => JSON.stringify({
      model: connection.modelId,
      messages: retryMode
        ? [...messages, {
          role: "user",
          content: retryMode === "near_output_budget"
            ? nearOutputBudgetRetryInstruction()
            : incompleteJsonRetryInstruction(request.task)
        }]
        : messages,
      // Do not leave the provider's output budget implicit. In particular,
      // free OpenAI-compatible endpoints can close a long structured request
      // instead of returning a useful 4xx response when their default output
      // budget is exceeded.
      // A truncated full-article JSON cannot be repaired by repeating the same
      // output limit. Let the second attempt use more room; an endpoint that
      // cannot provide it should fail visibly instead of silently shrinking prose.
      max_tokens: retryMode && request.task === "draft" ? 12_000 : maxTokensForTask(request.task),
      ...(withSchema ? {
        response_format: {
          type: "json_schema",
          json_schema: { name: `contentferry_${request.task}`, strict: true, schema: request.outputSchema }
        }
      } : {})
    });
    const post = async (withSchema: boolean, retryMode?: DraftRetryMode): Promise<{ response: Response; text: string }> => {
      const body = buildBody(withSchema, retryMode);
      const startedAt = Date.now();
      let responseText: string | null = null;
      let failure: unknown = null;
      try {
        const response = await this.callChatCompletions(connection, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json"
          },
          body,
          signal: request.signal
            ? AbortSignal.any([AbortSignal.timeout(request.timeoutMs ?? 180_000), request.signal])
            : AbortSignal.timeout(request.timeoutMs ?? 180_000)
        });
        responseText = await response.text();
        if (!response.ok) failure = new ModelProviderUnavailableError(`${connection.displayName} 请求失败（HTTP ${response.status}）。`);
        return { response, text: responseText };
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        this.recordRawAudit({
          task: request.task,
          skillId: request.skillId ?? "wechat-writing",
          correlationId: auditMeta?.correlationId,
          retrieval: auditMeta?.retrieval,
          provider,
          model: connection.modelId || null,
          prompt: body,
          response: responseText,
          usage: readUsage(responseText),
          error: failure,
          durationMs: Date.now() - startedAt
        });
      }
    };

    let { response, text } = await post(true);
    // Some OpenAI-compatible models (e.g. open-weights behind gateways)
    // do not support structured outputs. When the API says so, retry once
    // without response_format — the JSON instruction is already in the prompt.
    if (!response.ok && isStructuredOutputUnsupported(response.status, text)) {
      const retried = await post(false);
      response = retried.response;
      text = retried.text;
    }
    if (!response.ok) {
      throw new ModelProviderUnavailableError(`${connection.displayName} 请求失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
    }
    let completion = readChatCompletion(text, connection.displayName);
    let retriedForOutputBoundary = false;
    const initialDraftBudget = maxTokensForTask("draft");
    const shouldRetryNearOutputBudget = request.task === "draft"
      && !isOutputLengthLimit(completion.finishReason)
      && isNearOutputBudget(completion.usage, initialDraftBudget);
    if (request.task === "draft" && (isOutputLengthLimit(completion.finishReason) || shouldRetryNearOutputBudget)) {
      const retryMode: DraftRetryMode = shouldRetryNearOutputBudget ? "near_output_budget" : "incomplete_json";
      const retried = await post(false, retryMode);
      if (!retried.response.ok) {
        throw new ModelProviderUnavailableError(`${connection.displayName} 扩展输出重试失败（HTTP ${retried.response.status}）：${retried.text.slice(0, 300)}`);
      }
      completion = readChatCompletion(retried.text, connection.displayName);
      retriedForOutputBoundary = true;
      if (isOutputLengthLimit(completion.finishReason)) {
        throw new ModelProviderUnavailableError(`${connection.displayName} 正文在扩展输出重试后仍达到长度上限；已拒绝将可能不完整的候选正文交给评审。`);
      }
      if (isNearOutputBudget(completion.usage, 12_000)) {
        throw new ModelProviderUnavailableError(`${connection.displayName} 正文在扩展输出重试后仍接近输出上限；已拒绝将可能压缩的候选交给评审。`);
      }
    }
    let value: T;
    try {
      value = parseStructured(completion.content, request.parse);
    } catch (error) {
      // A reasoning model occasionally reaches its output boundary after it has
      // started a JSON string. Retry once with task-specific guidance.
      if (!isIncompleteJson(error) || retriedForOutputBoundary) throw error;
      const retried = await post(false, "incomplete_json");
      if (!retried.response.ok) {
        throw new ModelProviderUnavailableError(`${connection.displayName} 紧凑重试失败（HTTP ${retried.response.status}）：${retried.text.slice(0, 300)}`);
      }
      completion = readChatCompletion(retried.text, connection.displayName);
      if (request.task === "draft" && isOutputLengthLimit(completion.finishReason)) {
        throw new ModelProviderUnavailableError(`${connection.displayName} 正文在扩展输出重试后仍达到长度上限；已拒绝将可能不完整的候选正文交给评审。`);
      }
      if (request.task === "draft" && isNearOutputBudget(completion.usage, 12_000)) {
        throw new ModelProviderUnavailableError(`${connection.displayName} 正文在扩展输出重试后仍接近输出上限；已拒绝将可能压缩的候选交给评审。`);
      }
      value = parseStructured(completion.content, request.parse);
    }
    return {
      value,
      provider,
      model: connection.modelId || null,
      usage: completion.usage ? {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        cachedInputTokens: 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
        reasoningOutputTokens: 0
      } : null
    };
  }
}

function maxTokensForTask(task: GenerateStructuredRequest<unknown>["task"]): number {
  switch (task) {
    case "draft":
      // Match full guide drafts without forcing a second complete generation:
      // the observed DSH guide used 7.4k output tokens. Keep headroom here and
      // retain the 12k recovery path for drafts that genuinely need more.
      return 8_000;
    case "research":
      return 8_192;
    case "outline":
      return 2_000;
    default:
      return 1_600;
  }
}

function incompleteJsonRetryInstruction(task: GenerateStructuredRequest<unknown>["task"]): string {
  const base = "上一次输出不是完整 JSON。请从头重新输出符合原始 JSON Schema 的完整对象；不要解释、不要 Markdown、不要展开推理。";
  if (task === "research") {
    return `${base} 资料卡数量由独立证据决定，同质来源必须合并；每条摘要不超过 120 个汉字，每条最多 2 个 keyClaims。`;
  }
  if (task === "draft") {
    return `${base} markdown 字段必须保留已确认提纲的全部章节和各节的具体内容；不要为缩短 JSON 而压缩正文、删减步骤或合并章节。`;
  }
  return base;
}

function readUsage(text: string | null): { prompt_tokens?: number; completion_tokens?: number } | undefined {
  if (!text) return undefined;
  try {
    const usage = (JSON.parse(text) as { usage?: unknown }).usage;
    if (!usage || typeof usage !== "object") return undefined;
    const value = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
    return {
      ...(typeof value.prompt_tokens === "number" ? { prompt_tokens: value.prompt_tokens } : {}),
      ...(typeof value.completion_tokens === "number" ? { completion_tokens: value.completion_tokens } : {})
    };
  } catch {
    return undefined;
  }
}

/** Reads both classic OpenAI string content and the content-part arrays used by
 * several OpenAI-compatible gateways. Reasoning-only fields are deliberately
 * not treated as a final answer. */
function extractChatText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!Array.isArray(value)) return null;
  const parts = value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!part || typeof part !== "object") return [];
    const candidate = part as { text?: unknown; content?: unknown };
    if (typeof candidate.text === "string") return [candidate.text];
    if (typeof candidate.content === "string") return [candidate.content];
    return [];
  }).join("").trim();
  return parts || null;
}

function describeEmptyChatChoice(choice: {
  message?: { content?: unknown; text?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
  finish_reason?: string | null;
} | undefined): string {
  if (!choice) return " 服务未返回 choices。";
  const details: string[] = [];
  if (choice.finish_reason) details.push(`finish_reason=${choice.finish_reason}`);
  if (choice.message?.reasoning_content) details.push("仅返回了 reasoning_content");
  if (choice.message?.tool_calls) details.push("返回了 tool_calls 而非正文");
  return details.length > 0 ? `（${details.join("；")}）` : " 返回结构中没有 message.content。";
}

type OpenAiCompatibleChoice = {
  message?: { content?: unknown; text?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
  delta?: { content?: unknown; text?: unknown };
  finish_reason?: string | null;
};

function readChatCompletion(text: string, displayName: string): {
  content: string;
  finishReason?: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
} {
  const payload = JSON.parse(text) as {
    choices?: OpenAiCompatibleChoice[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const firstChoice = payload.choices?.[0];
  const content = extractChatText(firstChoice?.message?.content)
    ?? extractChatText(firstChoice?.message?.text)
    ?? extractChatText(firstChoice?.delta?.content)
    ?? extractChatText(firstChoice?.delta?.text);
  if (!content) throw new ModelProviderUnavailableError(
    `${displayName} 没有返回可用内容。${describeEmptyChatChoice(firstChoice)}`
  );
  return { content, finishReason: firstChoice?.finish_reason, usage: payload.usage };
}

function isOutputLengthLimit(finishReason: string | null | undefined): boolean {
  return typeof finishReason === "string" && /^(?:length|max_tokens)$/iu.test(finishReason.trim());
}

function isNearOutputBudget(usage: { completion_tokens?: number } | undefined, budget: number): boolean {
  return typeof usage?.completion_tokens === "number" && usage.completion_tokens >= Math.ceil(budget * 0.95);
}

function nearOutputBudgetRetryInstruction(): string {
  return "上一版正文触及本轮输出预算上限附近。请从头重新输出完整正文，逐项兑现已确认提纲的读者承诺；不要为了适应上次预算而压缩章节、步骤、案例或解释。";
}

function isIncompleteJson(error: unknown): boolean {
  const syntaxError = error instanceof SyntaxError
    ? error
    : error instanceof Error && (error as { cause?: unknown }).cause instanceof SyntaxError
      ? (error as { cause: SyntaxError }).cause
      : null;
  return Boolean(syntaxError && /unterminated|string|unexpected end/i.test(syntaxError.message));
}

function parseStructured<T>(content: string, parse: (value: unknown) => T): T {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return parse(JSON.parse(normalized));
  } catch (error) {
    throw new ModelProviderUnavailableError("模型返回的结构不完整，请重新生成。", { cause: error });
  }
}

function withResearchExecution(
  generated: GenerateStructuredResult<ResearchCard>,
  execution: ResearchExecution
): GenerateStructuredResult<ResearchCard> {
  return { ...generated, value: { ...generated.value, execution } };
}

function attachVerifiedEvidence(sources: ResearchCard["sources"], verified: SearchSourceForPrompt[]): ResearchCard["sources"] {
  const byUrl = new Map(verified.map((source) => [canonicalUrl(source.url), source]));
  const grouped = new Map<string, ResearchCard["sources"][number]>();
  for (const source of sources) {
    const matched = [...new Set(source.sourceUrls.map(canonicalUrl))]
      .map((url) => byUrl.get(url))
      .filter((item): item is SearchSourceForPrompt => Boolean(item));
    if (matched.length === 0) continue;
    const snapshots: ResearchEvidenceSnapshot[] = matched.map((item) => ({
      url: item.url,
      excerpt: item.bodyExcerpt ?? item.snippet,
      capturedAt: item.capturedAt ?? "",
      sha256: item.sha256 ?? ""
    }));
    const evidence: ResearchEvidence = {
      claim: source.claim,
      recommendation: source.recommendation,
      qualityReason: source.qualityReason,
      freshness: source.freshness,
      boundary: source.boundary,
      kind: source.evidenceKind,
      sourceUrls: snapshots.map((snapshot) => snapshot.url),
      snapshots
    };
    const card = { ...source, url: matched[0].url, evidence };
    const key = `${evidence.kind}\u0000${evidence.claim}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, card);
      continue;
    }
    const mergedSnapshots = [...existing.evidence!.snapshots, ...snapshots]
      .filter((snapshot, index, all) => all.findIndex((item) => item.url === snapshot.url) === index);
    existing.evidence = { ...existing.evidence!, sourceUrls: mergedSnapshots.map((snapshot) => snapshot.url), snapshots: mergedSnapshots };
  }
  return [...grouped.values()];
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function appendUniqueResearchCandidates(
  accumulated: SearchSourceForPrompt[],
  results: Array<{ title: string; url: string; snippet: string }>
): void {
  const knownUrls = new Set(accumulated.map((source) => canonicalUrl(source.url)));
  for (const result of results) {
    const normalizedUrl = canonicalUrl(result.url);
    if (knownUrls.has(normalizedUrl)) continue;
    knownUrls.add(normalizedUrl);
    accumulated.push({ title: result.title, url: result.url, snippet: result.snippet, sourceType: "public" });
  }
}

function normalizeResearchQuery(query: string): string {
  return query.normalize("NFKC").toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1")
    .trim().replace(/\s+/gu, " ");
}

/** True when a failed chat/completions call is due to the model not supporting
 *  OpenAI-style structured outputs, so we can fall back to a plain JSON prompt. */
function isStructuredOutputUnsupported(status: number, body: string): boolean {
  if (status !== 400) return false;
  return /structured output|response_format|INVALID_REQUEST_BODY|json_schema|not support/i.test(body);
}

import type { ModelConnectionRepository, ModelProviderId } from "./model-connection-repository";
import {
  ModelProviderUnavailableError,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type GenerateMarkdownStreamRequest,
  type ModelProvider
} from "./model-provider";
import type { SkillRegistry } from "../skills/skill-registry";
import { type AiAuditLog } from "./ai-audit-log";

type CopilotSdk = typeof import("@github/copilot-sdk");
const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<CopilotSdk>;

export class ConfiguredModelProvider implements ModelProvider {
  readonly id = "configured";

  constructor(
    private readonly connections: ModelConnectionRepository,
    private readonly skills: SkillRegistry,
    private readonly codexProvider: ModelProvider,
    private readonly auditLog?: AiAuditLog
  ) {}

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> {
    const skillId = request.skillId ?? (request.task === "revision"
      ? "humanize-selection"
      : request.task === "summary"
        ? "article-summary"
        : "wechat-writing");
    // The audit envelope wraps the whole call, so failures that happen *before*
    // the model call (skill disabled, the research-provider guard) are recorded
    // too — not just errors coming back from the model.
    const meta: { task: string; skillId: string; prompt: string; provider?: string; model?: string } = { task: request.task, skillId, prompt: request.prompt };
    return this.withAudit(meta, () => {
      const skill = this.skills.get(skillId);
      if (!skill.enabled) throw new ModelProviderUnavailableError(`“${skill.name}”技能已停用。`);
      const provider = skill.provider ?? "openai_codex";
      meta.provider = provider;
      meta.model = this.modelIdFor(provider);
      if (request.task === "research" && provider !== "openai_codex") {
        throw new ModelProviderUnavailableError("当前“联网资料补研”使用 Codex 的实时网页检索；请在技能与模型中选择 OpenAI Codex。 ");
      }
      const instructions = this.skills.instructionsFor(skillId, request.prompt);
      const enrichedRequest = {
        ...request,
        prompt: `请遵循以下 ContentFerry 技能说明：\n\n${instructions}\n\n本次任务：\n${request.prompt}`
      };
      meta.prompt = enrichedRequest.prompt;
      if (provider === "openai_codex") {
        return this.codexProvider.generateStructured({ ...enrichedRequest, modelId: this.connections.get("openai_codex").modelId, onStatus: request.onStatus });
      }
      if (provider === "openai" || provider === "openrouter" || provider === "nous" || provider === "nvidia_build") return this.generateOpenAiCompatible(provider, enrichedRequest);
      if (provider === "github_copilot") return this.generateWithCopilot(enrichedRequest);
      throw new ModelProviderUnavailableError(`“${skill.name}”当前选择的 ${provider} 不能用于文本生成。`);
    });
  }

  async generateMarkdownStream(request: GenerateMarkdownStreamRequest): Promise<GenerateStructuredResult<{ markdown: string }>> {
    const skillId = request.skillId ?? "wechat-writing";
    // Wrap the whole call (skill lookup included) so a disabled skill is audited too.
    const meta: { task: string; skillId: string; prompt: string; provider?: string; model?: string } = { task: request.task, skillId, prompt: request.prompt };
    return this.withAudit(meta, async () => {
      const skill = this.skills.get(skillId);
      if (!skill.enabled) throw new ModelProviderUnavailableError(`“${skill.name}”技能已停用。`);
      meta.provider = skill.provider ?? "openai_codex";
      meta.model = this.modelIdFor(meta.provider);
      const instructions = this.skills.instructionsFor(skillId, request.prompt);
      const enriched = { ...request, prompt: `请遵循以下 ContentFerry 技能说明：\n\n${instructions}\n\n本次任务：\n${request.prompt}` };
      meta.prompt = enriched.prompt;
      if (skill.provider === "openai_codex" || !skill.provider) {
        if (!this.codexProvider.generateMarkdownStream) throw new ModelProviderUnavailableError("当前 Codex 连接不支持流式生成。");
        return this.codexProvider.generateMarkdownStream!({ ...enriched, modelId: this.connections.get("openai_codex").modelId });
      }
      // Other providers retain the existing structured path for now. The UI still
      // remains cancellable; their final Markdown is appended as one completed chunk.
      // Note: generateStructured wraps itself in withAudit, but auditInFlight is
      // already true here, so it will not double-log.
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

  /** Wraps a model call so the full prompt/response are recorded when audit is on.
   *  Re-entrancy is guarded so the structured fallback inside generateMarkdownStream
   *  is not double-logged. */
  private auditInFlight = false;
  private async withAudit<T>(
    meta: { task: string; skillId: string; prompt: string; provider?: string; model?: string },
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
        error: null
      });
      return result;
    } catch (error) {
      this.auditLog.record({
        task: meta.task,
        skillId: meta.skillId,
        prompt: meta.prompt,
        // On failure (e.g. the research-provider guard or a disabled skill) the
        // model was never called, so fall back to the provider/model we *would*
        // have used — that is still the most useful thing to record.
        provider: meta.provider ?? null,
        model: meta.model || null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningOutputTokens: null,
        durationMs: Date.now() - start,
        ok: false,
        response: null,
        error: error instanceof Error ? error.message : String(error)
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

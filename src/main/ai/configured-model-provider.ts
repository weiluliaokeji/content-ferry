import type { ModelConnectionRepository } from "./model-connection-repository";
import {
  ModelProviderUnavailableError,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type GenerateMarkdownStreamRequest,
  type ModelProvider
} from "./model-provider";
import type { SkillRegistry } from "../skills/skill-registry";

type CopilotSdk = typeof import("@github/copilot-sdk");
const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<CopilotSdk>;

export class ConfiguredModelProvider implements ModelProvider {
  readonly id = "configured";

  constructor(
    private readonly connections: ModelConnectionRepository,
    private readonly skills: SkillRegistry,
    private readonly codexProvider: ModelProvider
  ) {}

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> {
    const skillId = request.skillId ?? (request.task === "revision"
      ? "humanize-selection"
      : request.task === "summary"
        ? "article-summary"
        : "wechat-writing");
    const skill = this.skills.get(skillId);
    if (!skill.enabled) throw new ModelProviderUnavailableError(`“${skill.name}”技能已停用。`);
    const provider = skill.provider ?? "openai_codex";
    if (request.task === "research" && provider !== "openai_codex") {
      throw new ModelProviderUnavailableError("当前“联网资料补研”使用 Codex 的实时网页检索；请在技能与模型中选择 OpenAI Codex。 ");
    }
    const instructions = this.skills.instructionsFor(skillId, request.prompt);
    const enrichedRequest = {
      ...request,
      prompt: `请遵循以下 ContentFerry 技能说明：\n\n${instructions}\n\n本次任务：\n${request.prompt}`
    };
    if (provider === "openai_codex") {
      return this.codexProvider.generateStructured({ ...enrichedRequest, modelId: this.connections.get("openai_codex").modelId });
    }
    if (provider === "openai" || provider === "openrouter" || provider === "nous" || provider === "nvidia_build") return this.generateOpenAiCompatible(provider, enrichedRequest);
    if (provider === "github_copilot") return this.generateWithCopilot(enrichedRequest);
    throw new ModelProviderUnavailableError(`“${skill.name}”当前选择的 ${provider} 不能用于文本生成。`);
  }

  async generateMarkdownStream(request: GenerateMarkdownStreamRequest): Promise<GenerateStructuredResult<{ markdown: string }>> {
    const skillId = request.skillId ?? "wechat-writing";
    const skill = this.skills.get(skillId);
    if (!skill.enabled) throw new ModelProviderUnavailableError(`“${skill.name}”技能已停用。`);
    const instructions = this.skills.instructionsFor(skillId, request.prompt);
    const enriched = { ...request, prompt: `请遵循以下 ContentFerry 技能说明：\n\n${instructions}\n\n本次任务：\n${request.prompt}` };
    if (skill.provider === "openai_codex" || !skill.provider) {
      if (!this.codexProvider.generateMarkdownStream) throw new ModelProviderUnavailableError("当前 Codex 连接不支持流式生成。");
      return this.codexProvider.generateMarkdownStream({ ...enriched, modelId: this.connections.get("openai_codex").modelId });
    }
    // Other providers retain the existing structured path for now. The UI still
    // remains cancellable; their final Markdown is appended as one completed chunk.
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

  private async generateOpenAiCompatible<T>(
    provider: "openai" | "openrouter" | "nous" | "nvidia_build",
    request: GenerateStructuredRequest<T>
  ): Promise<GenerateStructuredResult<T>> {
    const connection = this.connections.get(provider);
    if (!connection.enabled) throw new ModelProviderUnavailableError(`${connection.displayName} 连接已停用。`);
    const apiKey = this.connections.getCredential(provider);
    const baseUrl = connection.baseUrl.replace(/\/+$/, "");
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
      body: JSON.stringify({
        model: connection.modelId,
        messages: [
          {
            role: "system",
            content: "你是 ContentFerry 的内容工作流模型。严格按照给定 JSON Schema 返回 JSON，不要使用 Markdown 代码块。"
          },
          {
            role: "user",
            content: `${request.prompt}\n\n返回值必须符合此 JSON Schema：\n${JSON.stringify(request.outputSchema)}`
          }
        ],
        ...(provider === "nvidia_build" ? {} : {
          response_format: {
            type: "json_schema",
            json_schema: { name: `contentferry_${request.task}`, strict: true, schema: request.outputSchema }
          }
        })
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 180_000)
    });
    const text = await response.text();
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

import fs from "node:fs";
import type { Usage, ThreadEvent } from "@openai/codex-sdk";
import {
  ModelProviderUnavailableError,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type GenerateMarkdownStreamRequest,
  type ModelProvider,
  type WebResearchOptions
} from "./model-provider";
import type { WebResearchContext, ResearchCard } from "./research-prompts";

type CodexSdkModule = typeof import("@openai/codex-sdk");

// The desktop main process currently compiles to CommonJS while the official
// Codex SDK is ESM-only. Keeping the native dynamic import avoids bundling or
// copying any Codex/Hermes runtime code into ContentFerry.
const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<CodexSdkModule>;

export class OpenAICodexProvider implements ModelProvider {
  readonly id = "openai-codex";

  constructor(private readonly sandboxDirectory: string) {
    fs.mkdirSync(sandboxDirectory, { recursive: true });
  }

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<GenerateStructuredResult<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 180_000);

    // Built-in web search is opt-in per call. When on, Codex reaches the
    // network and performs its own retrieval (used by 联网补研 when the
    // connection's built-in search toggle is enabled). Otherwise writing and
    // synthesis stay offline — the app owns retrieval via WebSearchClient.
    const allowWebSearch = request.webSearch === true && request.task === "research";

    try {
      const { Codex } = await importEsm("@openai/codex-sdk");
      const codex = new Codex({ config: { mcp_servers: {} } });
      const thread = codex.startThread({
        workingDirectory: this.sandboxDirectory,
        skipGitRepoCheck: true,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: allowWebSearch,
        webSearchMode: allowWebSearch ? "live" : "disabled",
        ...(request.modelId?.trim() ? { model: request.modelId.trim() } : {}),
        modelReasoningEffort: request.task === "outline" ? "low" : "medium"
      });

      // When the caller wants progress feedback, stream the turn so we can emit
      // lifecycle + live web-search status. Otherwise fall back to the simpler
      // one-shot call to keep non-research tasks exactly as before.
      if (request.onStatus) {
        request.onStatus("已连接模型，开始处理任务…");
        const streamed = await thread.runStreamed(request.prompt, {
          outputSchema: request.outputSchema,
          signal: controller.signal
        });
        const { value, usage } = await consumeStructuredStream(streamed.events, request.onStatus);
        return {
          value: request.parse(value),
          provider: this.id,
          model: request.modelId?.trim() || null,
          usage: mapUsage(usage)
        };
      }

      const turn = await thread.run(request.prompt, {
        outputSchema: request.outputSchema,
        signal: controller.signal
      });

      let decoded: unknown;
      try {
        decoded = JSON.parse(turn.finalResponse);
      } catch (error) {
        throw new ModelProviderUnavailableError("AI 返回的内容格式不完整，请重新生成。", { cause: error });
      }

      return {
        value: request.parse(decoded),
        provider: this.id,
        model: request.modelId?.trim() || null,
        usage: mapUsage(turn.usage)
      };
    } catch (error) {
      if (error instanceof ModelProviderUnavailableError) throw error;
      if (controller.signal.aborted) {
        throw new ModelProviderUnavailableError("AI 生成超时，已安全停止本次任务。", { cause: error });
      }
      throw new ModelProviderUnavailableError(normalizeCodexError(error), { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  async generateMarkdownStream(request: GenerateMarkdownStreamRequest): Promise<GenerateStructuredResult<{ markdown: string }>> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    request.signal?.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, request.timeoutMs ?? 240_000);
    try {
      request.onStatus?.("正在启动 Codex 会话…");
      const { Codex } = await importEsm("@openai/codex-sdk");
      const codex = new Codex({ config: { mcp_servers: {} } });
      const thread = codex.startThread({
        workingDirectory: this.sandboxDirectory,
        skipGitRepoCheck: true,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        ...(request.modelId?.trim() ? { model: request.modelId.trim() } : {}),
        modelReasoningEffort: request.task === "outline" ? "low" : "medium"
      });
      const streamed = await thread.runStreamed(`${request.prompt}\n\n直接逐步输出完整 Markdown，不要输出 JSON、解释或代码围栏。`, { signal: controller.signal });
      let markdown = "";
      let usage: Usage | null = null;
      for await (const event of streamed.events) {
        if (event.type === "thread.started") request.onStatus?.("Codex 会话已建立，正在读取创作要求…");
        if (event.type === "turn.started") request.onStatus?.("正在分析账号定位、创作简报与资料…");
        if (event.type === "item.started" && event.item.type === "reasoning") request.onStatus?.("正在规划文章结构…");
        if (event.type === "item.completed" && event.item.type === "reasoning") request.onStatus?.("结构规划完成，正在撰写提纲…");
        if (event.type === "item.started" && event.item.type === "agent_message") request.onStatus?.("正在整理 Markdown 内容…");
        if ((event.type === "item.updated" || event.type === "item.completed") && event.item.type === "agent_message") {
          const next = event.item.text ?? "";
          if (next.length >= markdown.length) {
            markdown = next;
            request.onDelta(markdown);
          }
        }
        if (event.type === "turn.completed") usage = event.usage;
        if (event.type === "turn.failed") throw new ModelProviderUnavailableError(event.error.message);
        if (event.type === "error") throw new ModelProviderUnavailableError(event.message);
      }
      if (!markdown.trim()) throw new ModelProviderUnavailableError("AI 没有返回可用的 Markdown 内容，请重新生成。");
      return { value: { markdown }, provider: this.id, model: request.modelId?.trim() || null, usage: mapUsage(usage) };
    } catch (error) {
      if (error instanceof ModelProviderUnavailableError) throw error;
      if (controller.signal.aborted) throw new ModelProviderUnavailableError("已停止本次 AI 生成。", { cause: error });
      throw new ModelProviderUnavailableError(normalizeCodexError(error), { cause: error });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", cancel);
    }
  }

  /** Research orchestration (retrieval + multi-round loop) lives in
   *  ConfiguredModelProvider; Codex is only ever used here as a *synthesis*
   *  model via generateStructured. Calling this directly is unsupported. */
  async webResearch(_context: WebResearchContext, _onStatus?: (message: string) => void, _options?: WebResearchOptions): Promise<GenerateStructuredResult<ResearchCard>> {
    throw new ModelProviderUnavailableError("联网补研由 ConfiguredModelProvider 统一编排，请通过其 webResearch 方法调用。");
  }
}

function mapUsage(usage: Usage | null): GenerateStructuredResult<never>["usage"] {
  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens
  };
}

/** Maps a Codex thread event to a short Chinese status line, or null if the
 *  event carries no user-visible progress. Web-search events surface the live
 *  query, which is the most useful signal during 联网补研. */
export function mapCodexEventToStatus(event: ThreadEvent): string | null {
  switch (event.type) {
    case "thread.started":
      return "已建立本地会话";
    case "turn.started":
      return "正在理解任务要求…";
    case "item.started":
      if (event.item.type === "web_search") return `正在检索网页：${event.item.query}`;
      if (event.item.type === "reasoning") return "正在分析并规划内容…";
      if (event.item.type === "agent_message") return "正在整理内容…";
      return null;
    case "item.completed":
      if (event.item.type === "reasoning") return "分析完成，正在生成内容…";
      if (event.item.type === "agent_message") return "正在整理可追溯内容…";
      return null;
    default:
      return null;
  }
}

/** Drains a Codex structured-stream, emitting status along the way and returning
 *  the parsed JSON value plus usage. Extracts the JSON from the final
 *  agent_message text (the streaming equivalent of `turn.finalResponse`). */
export async function consumeStructuredStream(
  events: AsyncGenerator<ThreadEvent>,
  onStatus?: (message: string) => void
): Promise<{ value: unknown; usage: Usage | null }> {
  let value: unknown;
  let usage: Usage | null = null;
  let lastAgentText = "";
  for await (const event of events) {
    const status = mapCodexEventToStatus(event);
    if (status) onStatus?.(status);
    if (event.type === "turn.completed") {
      usage = event.usage;
    } else if (event.type === "turn.failed") {
      throw new ModelProviderUnavailableError(event.error.message);
    } else if (event.type === "error") {
      throw new ModelProviderUnavailableError(event.message);
    } else if ((event.type === "item.completed" || event.type === "item.updated") && event.item.type === "agent_message") {
      if (event.item.text) lastAgentText = event.item.text;
    }
  }
  if (!lastAgentText.trim()) throw new ModelProviderUnavailableError("AI 没有返回可用内容，请重新生成。");
  try {
    value = JSON.parse(lastAgentText);
  } catch (error) {
    throw new ModelProviderUnavailableError("AI 返回的内容格式不完整，请重新生成。", { cause: error });
  }
  return { value, usage };
}

function normalizeCodexError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not logged in|login|authentication|unauthorized|401/i.test(message)) {
    return "OpenAI Codex 尚未登录，请先完成 ChatGPT 登录后重试。";
  }
  if (/network|connect|fetch|timeout|timed out/i.test(message)) {
    return "暂时无法连接 OpenAI Codex，请检查网络后重试。";
  }
  return `OpenAI Codex 生成失败：${message}`;
}

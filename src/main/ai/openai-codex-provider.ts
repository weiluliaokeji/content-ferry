import fs from "node:fs";
import type { Usage } from "@openai/codex-sdk";
import {
  ModelProviderUnavailableError,
  type GenerateStructuredRequest,
  type GenerateStructuredResult,
  type GenerateMarkdownStreamRequest,
  type ModelProvider
} from "./model-provider";

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

    try {
      const { Codex } = await importEsm("@openai/codex-sdk");
      const codex = new Codex({
        config: {
          mcp_servers: {}
        }
      });
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
        if ((event.type === "item.updated" || event.type === "item.completed") && event.item.type === "agent_message") {
          const next = event.item.text ?? "";
          if (next.length >= markdown.length) {
            markdown = next;
            request.onDelta(markdown);
          }
        }
        if (event.type === "turn.completed") usage = event.usage;
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

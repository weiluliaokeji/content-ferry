import type Database from "better-sqlite3";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { ModelConnectionRepository, ModelProviderId } from "../ai/model-connection-repository";
import type { AiAuditLog } from "../ai/ai-audit-log";
import type { LocalAssetStore } from "./local-asset-store";
import type { ContentSourceService } from "./content-source-service";

type ImageMime = "image/jpeg" | "image/png" | "image/webp";
type ExternalExchange = { method: string; url: string; request: string | null; response: string | null; error: string | null };

export class CoverGenerationService {
  constructor(
    private readonly db: Database.Database,
    private readonly connections: ModelConnectionRepository,
    private readonly assets?: LocalAssetStore,
    private readonly contentSources?: ContentSourceService,
    private readonly fetcher: typeof fetch = fetch,
    private readonly auditLog?: AiAuditLog
  ) {}

  async generate(input: {
    workspaceId: string;
    projectId?: string;
    relativePath?: string;
    prompt?: string;
    provider?: ModelProviderId;
  }) {
    this.getArticle(input);
    const provider = input.provider ?? "modelscope";
    if (provider !== "modelscope" && provider !== "gemini") {
      throw new Error("封面生成技能只支持 ModelScope 或 Gemini 图片模型。");
    }
    const prompt = normalizeCoverImagePrompt(input.prompt);
    const exchanges: ExternalExchange[] = [];
    const startedAt = Date.now();
    const connection = this.connections.get(provider);
    try {
      const generated = provider === "gemini"
        ? await this.generateWithGemini(prompt, exchanges)
        : await this.generateWithModelScope(prompt, exchanges);
      const saved = this.save(input, generated.mimeType, generated.base64);
      this.recordAudit({ provider, model: connection.modelId, prompt, exchanges, startedAt, ok: true, error: null });
      return saved;
    } catch (error) {
      this.recordAudit({ provider, model: connection.modelId, prompt, exchanges, startedAt, ok: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async generateWithModelScope(prompt: string, exchanges: ExternalExchange[]): Promise<{ mimeType: ImageMime; base64: string }> {
    const connection = this.connections.get("modelscope");
    const token = this.connections.getCredential("modelscope");
    const baseUrl = connection.baseUrl.replace(/\/+$/, "") || "https://api-inference.modelscope.cn";
    const submitted = await this.requestJson(`${baseUrl}/v1/images/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-modelscope-async-mode": "true"
      },
      body: JSON.stringify({ model: connection.modelId || "Qwen/Qwen-Image-2512", prompt, n: 1, size: "1024x576" })
    }, exchanges) as { task_id?: string };
    if (!submitted.task_id) throw new Error("ModelScope 没有返回生图任务 ID。");

    let imageUrl = "";
    while (true) {
      await delay(3000);
      const task = await this.requestJson(`${baseUrl}/v1/tasks/${encodeURIComponent(submitted.task_id)}`, {
        headers: { authorization: `Bearer ${token}`, "x-modelscope-task-type": "image_generation" }
      }, exchanges) as { task_status?: string; output_images?: string[]; errors?: unknown };
      if (task.task_status === "SUCCEED" && task.output_images?.[0]) {
        imageUrl = task.output_images[0];
        break;
      }
      if (task.task_status === "FAILED") {
        throw new Error(`ModelScope 生图失败：${JSON.stringify(task.errors ?? task)}`);
      }
    }
    const image = await this.requestImage(imageUrl, exchanges);
    return {
      mimeType: normalizeImageMime(image.headers.get("content-type")),
      base64: Buffer.from(await image.arrayBuffer()).toString("base64")
    };
  }

  private async generateWithGemini(prompt: string, exchanges: ExternalExchange[]): Promise<{ mimeType: ImageMime; base64: string }> {
    const connection = this.connections.get("gemini");
    const apiKey = this.connections.getCredential("gemini");
    const baseUrl = connection.baseUrl.replace(/\/+$/, "") || "https://generativelanguage.googleapis.com";
    const model = connection.modelId || "gemini-3.1-flash-image";
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: "16:9" }
        }
      })
    };
    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    let response: Response;
    let text = "";
    try {
      response = connection.proxyUrl.trim()
        ? await undiciFetch(url, { ...init, dispatcher: new ProxyAgent(connection.proxyUrl.trim()) })
        : await this.fetcher(url, init);
      text = await response.text();
      exchanges.push({ method: "POST", url: auditUrl(url), request: auditBody(init.body), response: auditText(text), error: null });
    } catch (error) {
      exchanges.push({ method: "POST", url: auditUrl(url), request: auditBody(init.body), response: null, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    if (!response.ok) throw new Error(`Gemini 生图请求失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
    const payload = JSON.parse(text) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { mimeType?: string; data?: string };
            inline_data?: { mime_type?: string; data?: string };
          }>;
        };
      }>;
    };
    for (const part of payload.candidates?.[0]?.content?.parts ?? []) {
      const inline = part.inlineData
        ?? (part.inline_data ? { mimeType: part.inline_data.mime_type, data: part.inline_data.data } : undefined);
      if (inline?.data) return { mimeType: normalizeImageMime(inline.mimeType ?? null), base64: inline.data };
    }
    throw new Error("Gemini 已返回结果，但其中没有可用的图片。请调整提示词或模型后重试。");
  }

  private save(
    input: { workspaceId: string; projectId?: string; relativePath?: string },
    mimeType: ImageMime,
    base64: string
  ) {
    if (input.projectId) {
      if (!this.assets) throw new Error("本地素材库尚未启用。");
      return this.assets.save(input.projectId, mimeType, base64);
    }
    if (!input.relativePath || !this.contentSources) throw new Error("VitePress 文章库尚未启用。");
    return this.contentSources.saveArticleAsset(input.workspaceId, input.relativePath, mimeType, base64);
  }

  private getArticle(input: {
    workspaceId: string;
    projectId?: string;
    relativePath?: string;
  }): { title: string; markdown: string } {
    if (input.projectId) {
      const row = this.db.prepare(`SELECT p.topic, d.markdown FROM content_projects p
        JOIN content_drafts d ON d.project_id = p.id WHERE p.id = ? AND p.workspace_id = ?`)
        .get(input.projectId, input.workspaceId) as { topic: string; markdown: string } | undefined;
      if (!row) throw new Error("找不到要生成封面的正文。");
      return { title: row.topic, markdown: row.markdown };
    }
    if (!input.relativePath || !this.contentSources) throw new Error("没有指定文章。");
    const article = this.contentSources.getArticle(input.workspaceId, input.relativePath);
    return { title: article.title ?? input.relativePath, markdown: article.markdown };
  }

  private async requestJson(url: string, init: RequestInit, exchanges: ExternalExchange[]): Promise<unknown> {
    let response: Response;
    let text = "";
    try {
      response = await this.fetcher(url, init);
      text = await response.text();
      exchanges.push({ method: init.method ?? "GET", url: auditUrl(url), request: auditBody(init.body), response: auditText(text), error: null });
    } catch (error) {
      exchanges.push({ method: init.method ?? "GET", url: auditUrl(url), request: auditBody(init.body), response: null, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    if (!response.ok) throw new Error(`ModelScope 请求失败（HTTP ${response.status}）：${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("ModelScope 返回了无法解析的结果。");
    }
  }

  private async requestImage(url: string, exchanges: ExternalExchange[]): Promise<Response> {
    try {
      const response = await this.fetcher(url);
      exchanges.push({ method: "GET", url: auditUrl(url), request: null, response: JSON.stringify({ status: response.status, contentType: response.headers.get("content-type") }), error: null });
      if (!response.ok) throw new Error(`生成的封面下载失败（HTTP ${response.status}）。`);
      return response;
    } catch (error) {
      if (!exchanges.some((entry) => entry.method === "GET" && entry.url === auditUrl(url) && entry.error)) {
        exchanges.push({ method: "GET", url: auditUrl(url), request: null, response: null, error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    }
  }

  private recordAudit(input: { provider: ModelProviderId; model: string; prompt: string; exchanges: ExternalExchange[]; startedAt: number; ok: boolean; error: string | null }): void {
    this.auditLog?.record({
      task: "cover_generation", skillId: "cover-generation", provider: input.provider, model: input.model || null,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningOutputTokens: null,
      durationMs: Date.now() - input.startedAt, ok: input.ok, prompt: input.prompt,
      response: JSON.stringify({ exchanges: input.exchanges }),
      error: input.error
    });
  }
}

function auditUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}${parsed.search ? "?[redacted]" : ""}`;
  } catch { return value; }
}

function auditBody(value: RequestInit["body"]): string | null {
  return typeof value === "string" ? auditText(value) : null;
}

function auditText(value: string): string {
  try { return JSON.stringify(redactAuditValue(JSON.parse(value))); }
  catch { return value.replace(/https?:\/\/[^\s"']+\?[^\s"']+/g, (url) => `${url.split("?")[0]}?[redacted]`); }
}

function redactAuditValue(value: unknown): unknown {
  if (typeof value === "string") return /^https?:\/\//.test(value) ? auditUrl(value) : value;
  if (Array.isArray(value)) return value.map(redactAuditValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|key|authorization/i.test(key) ? "[redacted]" : redactAuditValue(item)]));
}

export function normalizeCoverImagePrompt(prompt: string | undefined): string {
  const normalized = prompt?.trim() ?? "";
  if (!normalized) throw new Error("请先让 AI 根据正文生成封面提示词，或自行填写提示词。");
  return normalized;
}

function normalizeImageMime(value: string | null): ImageMime {
  if (value?.includes("jpeg")) return "image/jpeg";
  if (value?.includes("webp")) return "image/webp";
  return "image/png";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

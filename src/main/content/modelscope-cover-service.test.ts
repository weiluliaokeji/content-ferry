import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { ModelConnectionRepository } from "../ai/model-connection-repository";
import type { ContentSourceService } from "./content-source-service";
import type { LocalAssetStore } from "./local-asset-store";
import type { AiAuditLog } from "../ai/ai-audit-log";
import { CoverGenerationService, normalizeCoverImagePrompt } from "./modelscope-cover-service";

describe("cover image prompt", () => {
  it("passes the user's confirmed prompt through without adding article content or restrictions", () => {
    const prompt = "  极简摄影风格，一艘渡船穿过蓝色数据河流，画面右侧带文章标题  ";
    expect(normalizeCoverImagePrompt(prompt)).toBe("极简摄影风格，一艘渡船穿过蓝色数据河流，画面右侧带文章标题");
  });

  it("requires a confirmed prompt before invoking the image model", () => {
    expect(() => normalizeCoverImagePrompt("  ")).toThrow("请先让 AI 根据正文生成封面提示词");
  });
});

function buildService(fetcher: typeof fetch) {
  const db = { prepare: () => ({ get: () => undefined }) } as unknown as Database.Database;
  const connections = {
    get: () => ({ provider: "modelscope", displayName: "ModelScope", modelId: "Tongyi-MAI/Z-Image-Turbo", baseUrl: "https://api-inference.modelscope.cn", proxyUrl: "", enabled: true, builtInSearch: true }),
    getCredential: () => "test-token"
  } as unknown as ModelConnectionRepository;
  const contentSources = {
    getArticle: () => ({ title: "T", markdown: "M" }),
    saveArticleAsset: (_ws: string, _path: string, _mime: string, base64: string) => ({ assetUrl: `asset://${base64.length}` })
  } as unknown as ContentSourceService;
  const assets = undefined as unknown as LocalAssetStore;
  const auditLog = undefined as unknown as AiAuditLog;
  return new CoverGenerationService(db, connections, assets, contentSources, fetcher, auditLog);
}

describe("ModelScope 429 backoff retry", () => {
  it("retries once after a 429 on submit, then completes the full flow", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 429, text: async () => JSON.stringify({ errors: { message: "insufficient balance" }, request_id: "r1" }) } as Response;
      }
      if (calls === 2) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ task_id: "task-1" }) } as Response;
      }
      if (calls === 3) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ task_status: "SUCCEED", output_images: ["https://img/x.png"] }) } as Response;
      }
      return { ok: true, status: 200, headers: { get: () => "image/png" }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown as Response;
    }) as unknown as typeof fetch;

    const service = buildService(fetcher);
    const result = await service.generate({ workspaceId: "ws", relativePath: "a/b.md", prompt: "a cover", provider: "modelscope" });
    expect(result.assetUrl.startsWith("asset://")).toBe(true);
    // 1) submit 429 -> 2) submit 200 -> 3) poll SUCCEED -> 4) image download
    expect(calls).toBe(4);
  }, 15000);

  it("rethrows the 429 after the single retry still fails", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return { ok: false, status: 429, text: async () => JSON.stringify({ errors: { message: "insufficient balance" } }) } as Response;
    }) as unknown as typeof fetch;

    const service = buildService(fetcher);
    await expect(service.generate({ workspaceId: "ws", relativePath: "a/b.md", prompt: "a cover", provider: "modelscope" })).rejects.toThrow(/HTTP 429/);
    expect(calls).toBe(2);
  });

  it("does not retry on non-429 errors (e.g. invalid credential)", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return { ok: false, status: 401, text: async () => JSON.stringify({ errors: { message: "unauthorized" } }) } as Response;
    }) as unknown as typeof fetch;

    const service = buildService(fetcher);
    await expect(service.generate({ workspaceId: "ws", relativePath: "a/b.md", prompt: "a cover", provider: "modelscope" })).rejects.toThrow(/HTTP 401/);
    expect(calls).toBe(1);
  });
});

import { z } from "zod";
import { imageReviewInput, imageSearchHistoryInput, imageSearchHistoryQuery, imageSearchInput } from "./schemas";
import type { ServerContext } from "./server-context";

export function registerImageSearchRoutes(ctx: ServerContext): void {
  ctx.server.get("/api/image-candidates/preview", async (request, reply) => {
    const input = z.object({ url: z.string().url().max(4000) }).strict().parse(request.query);
    try {
      const image = await ctx.remoteImages.downloadForReview(input.url);
      return reply
        .header("Cache-Control", "private, max-age=300")
        .type(image.mimeType)
        .send(image.bytes);
    } catch {
      return reply.code(404).send();
    }
  });

  ctx.server.get("/api/image-candidates/history", async (request) => {
    const input = imageSearchHistoryQuery.parse(request.query);
    return { items: ctx.imageSearchHistory.list(input.contextKey) };
  });

  ctx.server.post("/api/image-candidates/history", async (request) => {
    const input = imageSearchHistoryInput.parse(request.body);
    return { item: ctx.imageSearchHistory.add(input.contextKey, input.query, input.provider, input.items) };
  });

  ctx.server.post("/api/image-candidates/search", async (request, reply) => {
    const input = imageSearchInput.parse(request.body);
    if (!ctx.webSearch.searchImages) {
      return reply.code(503).send({ error: "图片检索服务尚未启用，请先配置 Tavily。" });
    }
    try {
      const items = await ctx.webSearch.searchImages(input.query, input.limit);
      return { query: input.query, provider: ctx.webSearch.activeProviderId, items };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "图片检索失败。" });
    }
  });

  ctx.server.post("/api/image-candidates/review", async (request) => {
    const input = imageReviewInput.parse(request.body);
    const reviewed = await ctx.imageCandidateReview.review(input.query, input.items);
    return { query: input.query, ...reviewed };
  });
}

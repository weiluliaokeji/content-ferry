import path from "node:path";
import { z } from "zod";
import {
  contentAssetInput, contentSourceArchiveBeforeInput, contentSourceArchiveInput, contentSourceArticleInput, contentSourceArticleQuery,
  contentSourceAssetInput, contentSourceInput, remoteImageImportInput
} from "./schemas";
import type { ServerContext } from "./server-context";

export function registerContentSourceRoutes(ctx: ServerContext): void {
  const { server, assetStore, accounts, contentSources, remoteImages } = ctx;

  server.get("/api/content-source", async () => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    return { rootPath: contentSources.getSource(workspace.id) };
  });

  server.post("/api/content-assets", async (request, reply) => {
    if (!assetStore) return reply.code(503).send({ error: "本地素材服务尚未启用。" });
    const input = contentAssetInput.parse(request.body);
    return reply.code(201).send(assetStore.save(input.contextId, input.mimeType, input.base64));
  });

  server.post("/api/content-assets/import-remote", async (request, reply) => {
    const input = remoteImageImportInput.parse(request.body);
    if (!input.contextId) return reply.code(400).send({ error: "缺少素材上下文。" });
    return reply.code(201).send(await remoteImages.importForProject(input.contextId, input.url));
  });

  server.get("/api/content-assets/:contextId/:fileName", async (request, reply) => {
    if (!assetStore) return reply.code(404).send();
    const params = z.object({
      contextId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
      fileName: z.string().regex(/^[A-Fa-f0-9-]{36}\.(jpg|png|gif|webp)$/)
    }).parse(request.params);
    try {
      const asset = assetStore.read(params.contextId, params.fileName);
      return reply.type(asset.mimeType).send(asset.stream);
    } catch {
      return reply.code(404).send();
    }
  });

  server.put("/api/content-source", async (request) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    return { rootPath: contentSources.setSource(workspace.id, contentSourceInput.parse(request.body).rootPath) };
  });

  server.get("/api/content-source/preview", async () => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    return contentSources.preview(workspace.id);
  });

  server.get("/api/content-source/article", async (request) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const query = contentSourceArticleQuery.parse(request.query);
    return contentSources.getArticle(workspace.id, query.path);
  });

  server.put("/api/content-source/article", async (request) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const input = contentSourceArticleInput.parse(request.body);
    return contentSources.saveArticle(workspace.id, input.path, input.markdown);
  });

  server.put("/api/content-source/article/archive", async (request) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const input = contentSourceArchiveInput.parse(request.body);
    return contentSources.setArchived(workspace.id, input.path, input.archived);
  });

  server.post("/api/content-source/archive-before", async (request) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const input = contentSourceArchiveBeforeInput.parse(request.body);
    return contentSources.archiveArticlesBefore(workspace.id, input.cutoff);
  });

  server.post("/api/content-source/article-asset", async (request, reply) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const input = contentSourceAssetInput.parse(request.body);
    return reply.code(201).send(contentSources.saveArticleAsset(workspace.id, input.path, input.mimeType, input.base64));
  });

  server.post("/api/content-source/article-asset/import-remote", async (request, reply) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const input = remoteImageImportInput.parse(request.body);
    if (!input.path) return reply.code(400).send({ error: "缺少文章路径。" });
    return reply.code(201).send(await remoteImages.importForArticle(workspace.id, input.path, input.url));
  });

  server.get("/api/content-source/article-asset", async (request, reply) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const query = z.object({
      path: z.string().trim().min(1).max(1000),
      file: z.string().regex(/^[A-Fa-f0-9-]{36}\.(jpg|png|gif|webp)$/)
    }).parse(request.query);
    try {
      const asset = contentSources.readArticleAsset(workspace.id, query.path, query.file);
      return reply.type(asset.mimeType).send(asset.stream);
    } catch {
      return reply.code(404).send();
    }
  });

  server.get("/api/content-source/article-resource", async (request, reply) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const query = z.object({
      path: z.string().trim().min(1).max(1000),
      src: z.string().trim().min(1).max(2000)
    }).parse(request.query);
    try {
      const asset = contentSources.readArticleResource(workspace.id, query.path, query.src);
      return reply.type(asset.mimeType).send(asset.stream);
    } catch {
      return reply.code(404).send();
    }
  });

}

import { z } from "zod";
import { wechatDraftInput, wechatSourceDraftInput, wechatSubmitInput } from "./schemas";
import type { ServerContext } from "./server-context";

export function registerWechatRoutes(ctx: ServerContext): void {
  const { server, accounts, wechat, wechatCallbacks } = ctx;

  server.post("/api/integrations/wechat/accounts/:accountId/test", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    return wechat.testConnection(params.accountId);
  });

  server.get("/api/integrations/wechat/jobs", async () => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    return { items: wechat.list(workspace.id) };
  });

  server.delete("/api/integrations/wechat/jobs/:jobId", async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    wechat.deleteJob(params.jobId);
    return reply.code(204).send();
  });

  server.get("/api/integrations/wechat/accounts/:accountId/materials/images", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const query = z.object({ offset: z.coerce.number().int().min(0).default(0), count: z.coerce.number().int().min(1).max(20).default(20) }).parse(request.query);
    return wechat.listImageMaterials(params.accountId, query.offset, query.count);
  });

  server.get("/api/integrations/wechat/accounts/:accountId/materials/images/:mediaId", async (request, reply) => {
    const params = z.object({
      accountId: z.string().uuid(),
      mediaId: z.string().trim().min(1).max(256)
    }).parse(request.params);
    const material = await wechat.getImageMaterial(params.accountId, params.mediaId);
    return reply.header("cache-control", "private, max-age=300").type(material.mimeType).send(material.bytes);
  });

  server.post("/api/integrations/wechat/drafts", async (request, reply) => {
    return reply.code(201).send(await wechat.createProjectDraft(wechatDraftInput.parse(request.body)));
  });

  server.post("/api/integrations/wechat/source-drafts", async (request, reply) => {
    return reply.code(201).send(await wechat.createSourceDraft(wechatSourceDraftInput.parse(request.body)));
  });

    server.post("/api/integrations/wechat/jobs/:jobId/submit", async (request) => {
      const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
      return wechat.submit(params.jobId, wechatSubmitInput.parse(request.body).mode);
    });

    server.post("/api/integrations/wechat/jobs/:jobId/browser-assist", async (request) => {
      const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
      return wechat.startBrowserAssistedPublishing(params.jobId);
    });

  server.patch("/api/integrations/wechat/jobs/:jobId/status", async (request) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const input = z.object({
      status: z.enum(["published", "failed", "cancelled"]),
      reason: z.string().trim().max(500)
    }).parse(request.body);
    return wechat.correctStatus(params.jobId, input.status, input.reason);
  });

  server.get("/wechat/callback/:accountId", async (request, reply) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const query = z.object({
      signature: z.string().min(1),
      timestamp: z.string().min(1),
      nonce: z.string().min(1),
      echostr: z.string().min(1)
    }).parse(request.query);
    if (!wechatCallbacks.verify(params.accountId, query.signature, query.timestamp, query.nonce)) {
      return reply.code(403).send("invalid signature");
    }
    return reply.type("text/plain; charset=utf-8").send(query.echostr);
  });

  server.post("/wechat/callback/:accountId", async (request, reply) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const query = z.object({
      signature: z.string().min(1),
      timestamp: z.string().min(1),
      nonce: z.string().min(1)
    }).parse(request.query);
    wechatCallbacks.accept(params.accountId, query.signature, query.timestamp, query.nonce, String(request.body ?? ""));
    return reply.type("text/plain; charset=utf-8").send("success");
  });
  server.all("/wechat/callback", async (_request, reply) => {
    return reply.code(503).send({ error: "请使用带账号 ID 的微信回调地址。" });
  });

}

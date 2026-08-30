import { z } from "zod";
import { CnblogsChannelError } from "../cnblogs/cnblogs-channel-service";
import { CsdnChannelError } from "../csdn/csdn-channel-service";
import { JuejinChannelError } from "../juejin/juejin-channel-service";
import { FiftyoneCtoChannelError } from "../fiftyone-cto/fiftyone-cto-channel-service";
import {
  cnblogsChannelDraftInput, cnblogsChannelDraftSaveInput, cnblogsPublishOptionsInput,
  csdnChannelDraftInput, csdnChannelDraftSaveInput, juejinChannelDraftInput,
  juejinChannelDraftSaveInput, juejinPublishOptionsInput,
  fiftyoneCtoChannelDraftInput, fiftyoneCtoChannelDraftSaveInput, fiftyoneCtoPublishOptionsInput,
  type CsdnBrowserConfirmResult
} from "./schemas";
import type { ServerContext } from "./server-context";

export function registerChannelsRoutes(ctx: ServerContext): void {
  const { server, accounts, csdnChannels, cnblogsChannels, juejinChannels, fiftyoneCtoChannels, csdnBrowserConfirm } = ctx;

  server.get("/api/integrations/csdn/capabilities/:accountId", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const account = accounts.requireAccount(params.accountId);
    if (account.platform !== "csdn") throw new CsdnChannelError("请选择一个 CSDN 账号。");
    return csdnChannels.capabilities(account.id);
  });

  server.get("/api/integrations/csdn/channel-drafts", async (request) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const query = z.object({ accountId: z.string().uuid().optional() }).parse(request.query);
    return { items: csdnChannels.listDrafts(workspace.id, query.accountId) };
  });

  server.post("/api/integrations/csdn/channel-drafts", async (request, reply) => {
    const input = csdnChannelDraftInput.parse(request.body);
    return reply.code(201).send(await csdnChannels.createFromSource(input));
  });

  server.post("/api/integrations/csdn/channel-drafts/:draftId/approve", async (request) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    return csdnChannels.approveDraft(params.draftId);
  });

  server.put("/api/integrations/csdn/channel-drafts/:draftId", async (request) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    return csdnChannels.saveDraft(params.draftId, csdnChannelDraftSaveInput.parse(request.body));
  });

  server.delete("/api/integrations/csdn/channel-drafts/:draftId", async (request, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    csdnChannels.deleteDraft(params.draftId);
    return reply.code(204).send();
  });

  server.get("/api/integrations/csdn/jobs", async () => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    return { items: csdnChannels.listJobs(workspace.id) };
  });

  server.post("/api/integrations/csdn/channel-drafts/:draftId/jobs", async (request, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    return reply.code(201).send(csdnChannels.createPublishJob(params.draftId));
  });

  server.get("/api/integrations/csdn/jobs/:jobId", async (request) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const job = csdnChannels.getJob(params.jobId);
    // Images are resolved to data URLs here; the actual upload to CSDN's image
    // hosting happens inside the already-logged-in editor page (which exposes
    // `window.csdn.upload.uploadImg`), so no cookie or token plumbing is needed.
    const draft = await csdnChannels.getBrowserDraft(params.jobId);
    return { job, draft };
  });

  server.post("/api/integrations/csdn/jobs/:jobId/browser-assist", async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    return reply.code(201).send(csdnChannels.startBrowserAssist(params.jobId));
  });

  server.post("/api/integrations/csdn/jobs/:jobId/fill", async (request) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      verifiedFields: z.array(z.enum(["account", "title", "summary", "tags", "cover", "asset_count", "content"])).default([]),
      state: z.enum(["ready_for_final_confirmation", "needs_user", "failed_before_submit"]),
      reason: z.string().max(500).optional()
    }).parse(request.body);
    return csdnChannels.recordFill(params.jobId, body);
  });

  server.post("/api/integrations/csdn/jobs/:jobId/confirm", async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    if (!csdnBrowserConfirm) throw new CsdnChannelError("当前环境未启用 CSDN 浏览器发布能力。");
    csdnChannels.beginSubmit(params.jobId);
    let receipt: CsdnBrowserConfirmResult | null;
    try {
      receipt = await csdnBrowserConfirm(params.jobId);
    } catch (cause) {
      throw cause instanceof CsdnChannelError ? cause : new CsdnChannelError(cause instanceof Error ? cause.message : "CSDN 浏览器确认失败。");
    }
    if (!receipt) {
      return csdnChannels.recordSubmission(params.jobId, { remoteUrl: null, remoteContentId: null, state: "needs_manual_reconciliation", reason: "未能自动读取 CSDN 文章链接。" });
    }
    return reply.code(201).send(csdnChannels.recordSubmission(params.jobId, { ...receipt, state: "published" }));
  });

  server.post("/api/integrations/csdn/jobs/:jobId/record-submission", async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      remoteUrl: z.string().url().nullable(),
      remoteContentId: z.string().nullable()
    }).parse(request.body);
    return reply.code(201).send(csdnChannels.recordSubmission(params.jobId, { ...body, state: "published" }));
  });

  server.post("/api/integrations/csdn/jobs/:jobId/status", async (request) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      status: z.enum(["published", "failed", "cancelled"]),
      reason: z.string().max(500).default("")
    }).parse(request.body);
    return csdnChannels.correctStatus(params.jobId, body.status, body.reason);
  });

  server.get("/api/integrations/cnblogs/capabilities/:accountId", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const account = accounts.requireAccount(params.accountId);
    if (account.platform !== "cnblogs") throw new CnblogsChannelError("请选择一个博客园账号。");
    return cnblogsChannels.capabilities(account.id);
  });

  server.get("/api/integrations/cnblogs/channel-drafts", async (request) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const query = z.object({ accountId: z.string().uuid().optional() }).parse(request.query);
    return { items: cnblogsChannels.listDrafts(workspace.id, query.accountId) };
  });

  server.post("/api/integrations/cnblogs/channel-drafts", async (request, reply) => {
    const input = cnblogsChannelDraftInput.parse(request.body);
    return reply.code(201).send(await cnblogsChannels.createFromSource(input));
  });

  server.post("/api/integrations/cnblogs/channel-drafts/:draftId/approve", async (request) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    return cnblogsChannels.approveDraft(params.draftId);
  });

  server.put("/api/integrations/cnblogs/channel-drafts/:draftId", async (request) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    return cnblogsChannels.saveDraft(params.draftId, cnblogsChannelDraftSaveInput.parse(request.body));
  });

  server.delete("/api/integrations/cnblogs/channel-drafts/:draftId", async (request, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    cnblogsChannels.deleteDraft(params.draftId);
    return reply.code(204).send();
  });

  server.get("/api/integrations/cnblogs/jobs", async () => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    return { items: cnblogsChannels.listJobs(workspace.id) };
  });

  server.post("/api/integrations/cnblogs/channel-drafts/:draftId/jobs", async (request, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    const options = cnblogsPublishOptionsInput.parse(request.body ?? {});
    return reply.code(201).send({ job: cnblogsChannels.createPublishJob(params.draftId, options) });
  });

  server.get("/api/integrations/cnblogs/jobs/:jobId", async (request) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const job = cnblogsChannels.getJob(params.jobId);
    const draft = cnblogsChannels.getDraftForJob(params.jobId);
    return { job, draft };
  });

  server.post("/api/integrations/cnblogs/jobs/:jobId/confirm", async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    return reply.code(201).send({ job: await cnblogsChannels.confirmPublish(params.jobId) });
  });

  server.post("/api/integrations/cnblogs/jobs/:jobId/record-submission", async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      remoteUrl: z.string().url().nullable(),
      remoteContentId: z.string().nullable(),
      state: z.enum(["published", "needs_manual_reconciliation"]).default("published"),
      reason: z.string().max(500).optional()
    }).parse(request.body);
    return reply.code(201).send(cnblogsChannels.recordSubmission(params.jobId, { ...body, state: body.state }));
  });

  server.post("/api/integrations/cnblogs/jobs/:jobId/status", async (request) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      status: z.enum(["published", "failed", "cancelled"]),
      reason: z.string().max(500).default("")
    }).parse(request.body);
    return { job: cnblogsChannels.correctStatus(params.jobId, body.status, body.reason) };
  });

  server.get("/api/integrations/juejin/capabilities/:accountId", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const account = accounts.requireAccount(params.accountId);
    if (account.platform !== "juejin") throw new JuejinChannelError("请选择一个掘金账号。");
    return juejinChannels.capabilities(account.id);
  });

  server.get("/api/integrations/juejin/tags/:accountId", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const account = accounts.requireAccount(params.accountId);
    if (account.platform !== "juejin") throw new JuejinChannelError("请选择一个掘金账号。");
    return { items: await juejinChannels.listTags(account.id) };
  });

  server.get("/api/integrations/juejin/channel-drafts", async (request) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const query = z.object({ accountId: z.string().uuid().optional() }).parse(request.query);
    return { items: juejinChannels.listDrafts(workspace.id, query.accountId) };
  });

  server.post("/api/integrations/juejin/channel-drafts", async (request, reply) => {
    const input = juejinChannelDraftInput.parse(request.body);
    return reply.code(201).send(await juejinChannels.createFromSource(input));
  });

  server.post("/api/integrations/juejin/channel-drafts/:draftId/approve", async (request) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    return juejinChannels.approveDraft(params.draftId);
  });

  server.put("/api/integrations/juejin/channel-drafts/:draftId", async (request) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    return juejinChannels.saveDraft(params.draftId, juejinChannelDraftSaveInput.parse(request.body));
  });

  server.delete("/api/integrations/juejin/channel-drafts/:draftId", async (request, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    juejinChannels.deleteDraft(params.draftId);
    return reply.code(204).send();
  });

  server.get("/api/integrations/juejin/jobs", async () => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    return { items: juejinChannels.listJobs(workspace.id) };
  });

  server.post("/api/integrations/juejin/channel-drafts/:draftId/jobs", async (request, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    const options = juejinPublishOptionsInput.parse(request.body ?? {});
    return reply.code(201).send({ job: juejinChannels.createPublishJob(params.draftId, options) });
  });

  server.get("/api/integrations/juejin/jobs/:jobId", async (request) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const job = juejinChannels.getJob(params.jobId);
    const draft = juejinChannels.getDraftForJob(params.jobId);
    return { job, draft };
  });

  server.post("/api/integrations/juejin/jobs/:jobId/confirm", async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    return reply.code(201).send({ job: await juejinChannels.confirmPublish(params.jobId) });
  });

  server.post("/api/integrations/juejin/jobs/:jobId/record-submission", async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      remoteUrl: z.string().url().nullable(),
      remoteContentId: z.string().nullable(),
      state: z.enum(["published", "needs_manual_reconciliation"]).default("published"),
      reason: z.string().max(500).optional()
    }).parse(request.body);
    return reply.code(201).send(juejinChannels.recordSubmission(params.jobId, { ...body, state: body.state }));
  });

  server.post("/api/integrations/juejin/jobs/:jobId/status", async (request) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      status: z.enum(["published", "failed", "cancelled"]),
      reason: z.string().max(500).default("")
    }).parse(request.body);
    return { job: juejinChannels.correctStatus(params.jobId, body.status, body.reason) };
  });

  server.get("/api/integrations/51cto/capabilities/:accountId", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const account = accounts.requireAccount(params.accountId);
    if (account.platform !== "51cto") throw new FiftyoneCtoChannelError("请选择一个 51CTO 账号。");
    return fiftyoneCtoChannels.capabilities(account.id);
  });

  server.get("/api/integrations/51cto/channel-drafts", async (request) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const query = z.object({ accountId: z.string().uuid().optional() }).parse(request.query);
    return { items: fiftyoneCtoChannels.listDrafts(workspace.id, query.accountId) };
  });

  server.post("/api/integrations/51cto/channel-drafts", async (request, reply) => {
    const input = fiftyoneCtoChannelDraftInput.parse(request.body);
    return reply.code(201).send(await fiftyoneCtoChannels.createFromSource(input));
  });

  server.post("/api/integrations/51cto/channel-drafts/:draftId/approve", async (request) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    return fiftyoneCtoChannels.approveDraft(params.draftId);
  });

  server.put("/api/integrations/51cto/channel-drafts/:draftId", async (request) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    return fiftyoneCtoChannels.saveDraft(params.draftId, fiftyoneCtoChannelDraftSaveInput.parse(request.body));
  });

  server.delete("/api/integrations/51cto/channel-drafts/:draftId", async (request, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    fiftyoneCtoChannels.deleteDraft(params.draftId);
    return reply.code(204).send();
  });

  server.get("/api/integrations/51cto/jobs", async () => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    return { items: fiftyoneCtoChannels.listJobs(workspace.id) };
  });

  server.post("/api/integrations/51cto/channel-drafts/:draftId/jobs", async (request, reply) => {
    const params = z.object({ draftId: z.string().uuid() }).parse(request.params);
    const options = fiftyoneCtoPublishOptionsInput.parse(request.body ?? {});
    return reply.code(201).send({ job: fiftyoneCtoChannels.createPublishJob(params.draftId, options) });
  });

  server.get("/api/integrations/51cto/jobs/:jobId", async (request) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const job = fiftyoneCtoChannels.getJob(params.jobId);
    const draft = fiftyoneCtoChannels.getDraftForJob(params.jobId);
    return { job, draft };
  });

  server.post("/api/integrations/51cto/jobs/:jobId/confirm", async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    return reply.code(201).send({ job: await fiftyoneCtoChannels.confirmPublish(params.jobId) });
  });

  server.post("/api/integrations/51cto/jobs/:jobId/record-submission", async (request, reply) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      remoteUrl: z.string().url().nullable(),
      remoteContentId: z.string().nullable(),
      state: z.enum(["published", "needs_manual_reconciliation"]).default("published"),
      reason: z.string().max(500).optional()
    }).parse(request.body);
    return reply.code(201).send(fiftyoneCtoChannels.recordSubmission(params.jobId, { ...body, state: body.state }));
  });

  server.post("/api/integrations/51cto/jobs/:jobId/status", async (request) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      status: z.enum(["published", "failed", "cancelled"]),
      reason: z.string().max(500).default("")
    }).parse(request.body);
    return { job: fiftyoneCtoChannels.correctStatus(params.jobId, body.status, body.reason) };
  });

}

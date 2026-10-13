import { z } from "zod";
import { accountInput, accountRenameInput, credentialInput, profileInput } from "./schemas";
import type { ServerContext } from "./server-context";
import { AccountStyleSampleService } from "../accounts/account-style-sample-service";
import { AccountStyleProfileService } from "../accounts/account-style-profile-service";

const optionalDateQuery = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "日期格式应为 YYYY-MM-DD。")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "日期无效。")
  .optional();

export function registerAccountsRoutes(ctx: ServerContext): void {
  const { server, vault, accounts, wechat } = ctx;
  const styleSamples = new AccountStyleSampleService(ctx.database.connection, accounts, ctx.contentSources);
  const styleProfiles = new AccountStyleProfileService(ctx.database.connection, accounts, ctx.contentSources, ctx.effectiveModelProvider);

  server.get("/api/media-accounts", async () => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    return { items: accounts.listAccounts(workspace.id) };
  });

  server.post("/api/media-accounts", async (request, reply) => {
    const input = accountInput.parse(request.body);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const account = accounts.createAccount({ workspaceId: workspace.id, ...input });
    return reply.code(201).send(account);
  });

  server.put("/api/media-accounts/:accountId", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const input = accountRenameInput.parse(request.body);
    const updated = accounts.updateDisplayName(params.accountId, input.displayName);
    if (input.externalAccountId !== undefined) return accounts.updateExternalAccountId(params.accountId, input.externalAccountId);
    return updated;
  });

  server.put("/api/media-accounts/:accountId/profile", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    return accounts.updateProfile(params.accountId, profileInput.parse(request.body));
  });

  server.get("/api/media-accounts/:accountId/style-samples", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const query = z.object({ createdFrom: optionalDateQuery, createdTo: optionalDateQuery }).strict().refine(
      (value) => !value.createdFrom || !value.createdTo || value.createdFrom <= value.createdTo,
      { message: "开始日期不能晚于结束日期。" }
    ).parse(request.query);
    return styleSamples.list(params.accountId, query);
  });

  server.put("/api/media-accounts/:accountId/style-samples", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const input = z.object({
      selectedPaths: z.array(z.string().trim().min(1).max(1000)).max(100),
      authorConfirmedPaths: z.array(z.string().trim().min(1).max(1000)).max(100)
    }).strict().parse(request.body);
    return styleSamples.saveSelection(params.accountId, input);
  });

  server.get("/api/media-accounts/:accountId/style-profile", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    return styleProfiles.getState(params.accountId);
  });

  server.put("/api/media-accounts/:accountId/style-profile/active", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const input = z.object({ basedOnVersionId: z.string().uuid(), profile: z.unknown() }).strict().parse(request.body);
    return styleProfiles.updateActiveProfile(params.accountId, input.basedOnVersionId, input.profile);
  });

  server.post("/api/media-accounts/:accountId/style-profile/proposals", async (request, reply) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    const proposal = await styleProfiles.createProposal(params.accountId);
    return reply.code(201).send(proposal);
  });

  server.put("/api/media-accounts/:accountId/style-profile/proposals/:proposalId", async (request) => {
    const params = z.object({ accountId: z.string().uuid(), proposalId: z.string().uuid() }).parse(request.params);
    const body = z.object({ commonVoice: z.string(), genreTraits: z.array(z.object({ genre: z.string(), traits: z.string() }).strict()), visualTraits: z.string().default("") }).strict().parse(request.body);
    return styleProfiles.updateProposal(params.accountId, params.proposalId, body);
  });

  server.post("/api/media-accounts/:accountId/style-profile/proposals/:proposalId/confirm", async (request) => {
    const params = z.object({ accountId: z.string().uuid(), proposalId: z.string().uuid() }).parse(request.params);
    return styleProfiles.confirmProposal(params.accountId, params.proposalId);
  });

  server.post("/api/media-accounts/:accountId/style-profile/proposals/:proposalId/reject", async (request, reply) => {
    const params = z.object({ accountId: z.string().uuid(), proposalId: z.string().uuid() }).parse(request.params);
    styleProfiles.rejectProposal(params.accountId, params.proposalId);
    return reply.code(204).send();
  });

  server.put("/api/media-accounts/:accountId/credentials/:credentialKind", async (request, reply) => {
    const params = z.object({ accountId: z.string().uuid(), credentialKind: z.string().trim().min(1).max(80) }).parse(request.params);
    accounts.saveCredential(params.accountId, params.credentialKind, credentialInput.parse(request.body).secret, vault);
    // The secret is accepted once and is never echoed, logged, or exposed through account reads.
    return reply.code(204).send();
  });

  server.get("/api/media-accounts/:accountId/credentials/status", async (request) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    return {
      ...accounts.credentialStatus(params.accountId, vault),
      localCallbackUrl: `http://127.0.0.1:4317/wechat/callback/${params.accountId}`
    };
  });

  server.delete("/api/media-accounts/:accountId", async (request, reply) => {
    const params = z.object({ accountId: z.string().uuid() }).parse(request.params);
    accounts.deleteAccount(params.accountId);
    return reply.code(204).send();
  });

}

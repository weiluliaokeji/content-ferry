import { z } from "zod";
import { accountInput, accountRenameInput, credentialInput, profileInput } from "./schemas";
import type { ServerContext } from "./server-context";

export function registerAccountsRoutes(ctx: ServerContext): void {
  const { server, vault, accounts, wechat } = ctx;

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

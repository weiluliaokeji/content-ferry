import { z } from "zod";
import { JuejinChannelError } from "../juejin/juejin-channel-service";
import { JuejinCookieGrabber } from "../juejin/juejin-cookie-grab";
import type { ServerContext } from "./server-context";

/**
 * Juejin cookie grab routes.
 *
 * POST /api/integrations/juejin/cookie-grab/start  { accountId }
 *   → opens/reuses the login window, returns { grabId }.
 * GET  /api/integrations/juejin/cookie-grab/status?grabId=...
 *   → waiting_login | grabbing | success | cancelled | error,
 *     plus cookie/aid/uuid/verified when success.
 */
export function registerJuejinRoutes(ctx: ServerContext): void {
  const { server, accounts } = ctx;
  const grabber = new JuejinCookieGrabber();

  server.post("/api/integrations/juejin/cookie-grab/start", async (request, reply) => {
    const body = z.object({ accountId: z.string().uuid() }).parse(request.body);
    const account = accounts.requireAccount(body.accountId);
    if (account.platform !== "juejin") throw new JuejinChannelError("请选择一个掘金账号。");
    return reply.code(201).send({ grabId: grabber.start(account.id) });
  });

  server.get("/api/integrations/juejin/cookie-grab/status", async (request) => {
    const query = z.object({ grabId: z.string().min(1) }).parse(request.query);
    const snapshot = grabber.getStatus(query.grabId);
    if (!snapshot) throw new JuejinChannelError("抓取任务不存在或已过期。");
    return snapshot;
  });
}

import { z } from "zod";
import { FiftyoneCtoChannelError } from "../fiftyone-cto/fiftyone-cto-channel-error";
import { FiftyoneCtoCookieGrabber } from "../fiftyone-cto/fiftyone-cto-cookie-grab";
import type { ServerContext } from "./server-context";

/**
 * 51CTO cookie grab routes.
 *
 * POST /api/integrations/51cto/cookie-grab/start  { accountId }
 *   → opens/reuses the login window, returns { grabId }.
 * GET  /api/integrations/51cto/cookie-grab/status?grabId=...
 *   → waiting_login | grabbing | success | cancelled | error,
 *     plus cookie/verified when success.
 */
export function registerFiftyoneCtoRoutes(ctx: ServerContext): void {
  const { server, accounts } = ctx;
  const grabber = new FiftyoneCtoCookieGrabber();

  server.post("/api/integrations/51cto/cookie-grab/start", async (request, reply) => {
    const body = z.object({ accountId: z.string().uuid() }).parse(request.body);
    const account = accounts.requireAccount(body.accountId);
    if (account.platform !== "51cto") throw new FiftyoneCtoChannelError("请选择一个 51CTO 账号。");
    return reply.code(201).send({ grabId: grabber.start(account.id) });
  });

  server.get("/api/integrations/51cto/cookie-grab/status", async (request) => {
    const query = z.object({ grabId: z.string().min(1) }).parse(request.query);
    const snapshot = grabber.getStatus(query.grabId);
    if (!snapshot) throw new FiftyoneCtoChannelError("抓取任务不存在或已过期。");
    return snapshot;
  });
}

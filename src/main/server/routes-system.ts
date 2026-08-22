import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { WorkspaceResponse } from "../../shared/contracts";
import { dailyLogFilePath, listRuntimeLogFiles } from "../logging/daily-log-stream";
import { redactLogValue } from "./helpers";
import type { ServerContext } from "./server-context";

export function registerSystemRoutes(ctx: ServerContext): void {
  const { server, database, accounts, logFilePath } = ctx;

  server.get("/api/runtime-logs", async (request) => {
    const query = z.object({
      limit: z.coerce.number().int().min(20).max(500).default(200),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      scope: z.enum(["all", "errors", "wechat", "callbacks"]).default("all"),
      search: z.string().trim().max(120).default("")
    }).parse(request.query);
    const logDirectory = logFilePath ? path.dirname(logFilePath) : "";
    const allFiles = logDirectory ? listRuntimeLogFiles(logDirectory) : [];
    const files = query.date
      ? allFiles.filter((filePath) => path.basename(filePath).startsWith(`contentferry-${query.date}`))
      : allFiles;
    const maxBytes = 2 * 1024 * 1024;
    let remainingBytes = maxBytes;
    let text = "";
    let truncated = false;
    for (const filePath of files) {
      if (remainingBytes <= 0) {
        truncated = true;
        break;
      }
      const stat = fs.statSync(filePath);
      const length = Math.min(stat.size, remainingBytes);
      const start = stat.size - length;
      const handle = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(length);
      try {
        fs.readSync(handle, buffer, 0, length, start);
      } finally {
        fs.closeSync(handle);
      }
      let part = buffer.toString("utf8");
      if (start > 0) {
        part = part.replace(/^[^\n]*(?:\n|$)/, "");
        truncated = true;
      }
      text = `${part}\n${text}`;
      remainingBytes -= length;
    }
    const parsedFileItems = text.split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          const value = JSON.parse(line) as {
            time?: number; level?: number; msg?: string; reqId?: string;
            req?: { method?: string; url?: string };
            res?: { statusCode?: number };
            responseTime?: number;
            err?: { message?: string; stack?: string; code?: string };
          };
          return {
            time: value.time ?? null,
            level: value.level ?? 30,
            message: `${value.msg ?? ""}${value.reqId ? ` · requestId ${value.reqId}` : ""}`,
            requestId: value.reqId ?? "",
            method: value.req?.method ?? "",
            url: redactLogValue(value.req?.url ?? ""),
            statusCode: value.res?.statusCode ?? null,
            responseTime: value.responseTime ?? null,
            error: redactLogValue(value.err?.stack ?? value.err?.message ?? value.err?.code ?? "").slice(0, 4000)
          };
        } catch {
          return { time: null, level: 30, message: redactLogValue(line), requestId: "", method: "", url: "", statusCode: null, responseTime: null, error: "" };
        }
      });
    const callbackItems = query.date
      ? database.connection.prepare(`SELECT account_id, signature_status, received_at, processed_at
          FROM callback_events WHERE received_at LIKE ? ORDER BY received_at DESC LIMIT ?`)
        .all(`${query.date}%`, 500) as Array<{ account_id: string; signature_status: string; received_at: string; processed_at: string | null }>
      : database.connection.prepare(`SELECT account_id, signature_status, received_at, processed_at
          FROM callback_events ORDER BY received_at DESC LIMIT ?`)
        .all(500) as Array<{ account_id: string; signature_status: string; received_at: string; processed_at: string | null }>;
    const callbackLogItems = callbackItems.map((event) => ({
      time: Date.parse(event.received_at),
      level: event.signature_status === "valid" ? 30 : 50,
      message: event.processed_at ? "微信回调已接收并处理" : "微信回调已接收，尚未完成处理",
      requestId: "",
      method: "POST",
      url: `/wechat/callback/${event.account_id}`,
      statusCode: event.processed_at ? 200 : null,
      responseTime: null,
      error: event.signature_status === "valid" ? "" : "微信回调签名验证失败"
    }));
    const matchesScope = (entry: { level: number; message: string; method: string; url: string; statusCode: number | null; error: string }): boolean => {
      const combined = `${entry.message} ${entry.error}`;
      const matchesSearch = !query.search || `${entry.method} ${entry.url} ${combined}`.toLocaleLowerCase().includes(query.search.toLocaleLowerCase());
      if (!matchesSearch) return false;
      if (query.scope === "errors") return entry.level >= 40 || (entry.statusCode ?? 0) >= 400 || Boolean(entry.error);
      if (query.scope === "callbacks") return entry.url.includes("/wechat/callback");
      if (query.scope === "wechat") return entry.url.includes("/wechat/") || entry.url.includes("/integrations/wechat") || /微信|Wechat/i.test(combined);
      return true;
    };
    const matchedItems = [...parsedFileItems, ...callbackLogItems].filter(matchesScope);
    const items = matchedItems
      .sort((left, right) => (right.time ?? 0) - (left.time ?? 0))
      .slice(0, query.limit);
    return {
      filePath: logDirectory ? (query.date ? dailyLogFilePath(logDirectory, new Date(`${query.date}T12:00:00`)) : dailyLogFilePath(logDirectory)) : "",
      logDirectory,
      availableDates: [...new Set(allFiles.map((filePath) => /^contentferry-(\d{4}-\d{2}-\d{2})/.exec(path.basename(filePath))?.[1]).filter((value): value is string => Boolean(value)))],
      items,
      totalMatched: matchedItems.length,
      hasMore: matchedItems.length > query.limit,
      sourceTruncated: truncated,
      readWindowBytes: maxBytes
    };
  });

  server.get<{ Reply: WorkspaceResponse }>("/api/workspaces/default", async () => accounts.getOrCreateDefaultWorkspace());

  server.get("/api/article-settings", async (request) => {
    const query = z.object({ contextKey: z.string().trim().min(1).max(1200) }).parse(request.query);
    const row = database.connection.prepare("SELECT author, digest, cover_source, cover_prompt, account_id, need_open_comment, only_fans_can_comment, declare_original, enable_reward, collection_name FROM article_settings WHERE context_key = ?")
      .get(query.contextKey) as { author: string; digest: string; cover_source: string; cover_prompt: string; account_id: string | null; need_open_comment: number; only_fans_can_comment: number; declare_original: number; enable_reward: number; collection_name: string } | undefined;
    const projectId = query.contextKey.startsWith("project:") ? query.contextKey.slice("project:".length) : "";
    const sourcePath = query.contextKey.startsWith("source:") ? query.contextKey.slice("source:".length) : "";
    const project = projectId
      ? database.connection.prepare("SELECT target_account_id FROM content_projects WHERE id = ?").get(projectId) as { target_account_id: string | null } | undefined
      : sourcePath
        ? database.connection.prepare("SELECT target_account_id FROM content_projects WHERE source_relative_path = ? ORDER BY updated_at DESC LIMIT 1").get(sourcePath) as { target_account_id: string | null } | undefined
        : undefined;
    return {
      author: row?.author ?? "",
      digest: row?.digest ?? "",
      coverSource: row?.cover_source ?? "",
      coverPrompt: row?.cover_prompt ?? "",
      accountId: project?.target_account_id ?? row?.account_id ?? "",
      needOpenComment: row ? row.need_open_comment === 1 : true,
      onlyFansCanComment: row ? row.only_fans_can_comment === 1 : false,
      declareOriginal: row ? row.declare_original === 1 : false,
      enableReward: row ? row.enable_reward === 1 : false,
      collectionName: row?.collection_name ?? ""
    };
  });

  server.put("/api/article-settings", async (request) => {
    const input = z.object({
      contextKey: z.string().trim().min(1).max(1200),
      author: z.string().max(16),
      digest: z.string().max(200),
      coverSource: z.string().max(2000),
      coverPrompt: z.string().max(2000).default(""),
      accountId: z.string().uuid().or(z.literal("")).default(""),
      needOpenComment: z.boolean().default(true),
      onlyFansCanComment: z.boolean().default(false),
      declareOriginal: z.boolean().default(false),
      enableReward: z.boolean().default(false),
      collectionName: z.string().trim().max(80).default("")
    }).parse(request.body);
    const now = new Date().toISOString();
    database.connection.prepare(`INSERT INTO article_settings
      (context_key, author, digest, cover_source, cover_prompt, account_id, need_open_comment, only_fans_can_comment, declare_original, enable_reward, collection_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(context_key) DO UPDATE SET author = excluded.author, digest = excluded.digest,
        cover_source = excluded.cover_source, cover_prompt = excluded.cover_prompt, account_id = excluded.account_id,
        need_open_comment = excluded.need_open_comment, only_fans_can_comment = excluded.only_fans_can_comment,
        declare_original = excluded.declare_original, enable_reward = excluded.enable_reward, collection_name = excluded.collection_name,
        updated_at = excluded.updated_at`)
      .run(input.contextKey, input.author, input.digest, input.coverSource, input.coverPrompt, input.accountId || null,
        input.needOpenComment ? 1 : 0, input.needOpenComment && input.onlyFansCanComment ? 1 : 0,
        input.declareOriginal ? 1 : 0, input.enableReward ? 1 : 0, input.collectionName, now);
    if (input.contextKey.startsWith("project:")) {
      database.connection.prepare("UPDATE content_projects SET target_account_id = ?, updated_at = ? WHERE id = ?")
        .run(input.accountId || null, now, input.contextKey.slice("project:".length));
    } else if (input.contextKey.startsWith("source:")) {
      database.connection.prepare("UPDATE content_projects SET target_account_id = ?, updated_at = ? WHERE source_relative_path = ?")
        .run(input.accountId || null, now, input.contextKey.slice("source:".length));
    }
    return {
      author: input.author,
      digest: input.digest,
      coverSource: input.coverSource,
      coverPrompt: input.coverPrompt,
      accountId: input.accountId,
      needOpenComment: input.needOpenComment,
      onlyFansCanComment: input.needOpenComment && input.onlyFansCanComment,
      declareOriginal: input.declareOriginal,
      enableReward: input.enableReward,
      collectionName: input.collectionName
    };
  });

  server.get("/api/article-settings/authors", async () => ({
    items: (database.connection.prepare(`SELECT author, MAX(updated_at) AS last_used
      FROM article_settings WHERE author <> '' GROUP BY author ORDER BY last_used DESC LIMIT 20`).all() as Array<{ author: string }>)
      .map((row) => row.author)
  }));

  server.get("/api/article-settings/collections", async (request) => {
    const query = z.object({ accountId: z.string().uuid().optional() }).parse(request.query);
    const accountId = query.accountId ?? "";
    const rows = database.connection.prepare(`
      SELECT name, MAX(last_used) AS last_used FROM (
        SELECT name, observed_at AS last_used
        FROM wechat_collections
        WHERE ? <> '' AND account_id = ?
        UNION ALL
        SELECT collection_name AS name, updated_at AS last_used
        FROM article_settings
        WHERE collection_name <> '' AND (? = '' OR account_id = ?)
        UNION ALL
        SELECT collection_name AS name, updated_at AS last_used
        FROM wechat_publish_jobs
        WHERE collection_name <> '' AND (? = '' OR account_id = ?)
      ) GROUP BY name ORDER BY last_used DESC LIMIT 50
    `).all(accountId, accountId, accountId, accountId, accountId, accountId) as Array<{ name: string }>;
    const syncedAtRow = accountId
      ? database.connection.prepare("SELECT MAX(observed_at) AS observed_at FROM wechat_collections WHERE account_id = ?")
        .get(accountId) as { observed_at: string | null }
      : undefined;
    return { items: rows.map((row) => row.name), syncedAt: syncedAtRow?.observed_at ?? null };
  });

  server.get("/api/article-quality-check", async (request) => {
    const query = z.object({ contextKey: z.string().trim().min(1).max(1200) }).parse(request.query);
    const row = database.connection.prepare("SELECT ai_check_result, ai_check_report, override_reason, updated_at FROM article_quality_checks WHERE context_key = ?")
      .get(query.contextKey) as { ai_check_result: string; ai_check_report: string; override_reason: string; updated_at: string } | undefined;
    return {
      aiCheckResult: row?.ai_check_result ?? "",
      aiCheckReport: row?.ai_check_report ?? "",
      overrideReason: row?.override_reason ?? "",
      updatedAt: row?.updated_at ?? null
    };
  });

  server.put("/api/article-quality-check", async (request) => {
    const input = z.object({
      contextKey: z.string().trim().min(1).max(1200),
      aiCheckResult: z.string().max(10000).default(""),
      aiCheckReport: z.string().max(500_000).default(""),
      overrideReason: z.string().max(1000).default("")
    }).parse(request.body);
    const updatedAt = new Date().toISOString();
    database.connection.prepare(`INSERT INTO article_quality_checks
      (context_key, ai_check_result, ai_check_report, override_reason, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(context_key) DO UPDATE SET ai_check_result = excluded.ai_check_result,
        ai_check_report = excluded.ai_check_report, override_reason = excluded.override_reason, updated_at = excluded.updated_at`)
      .run(input.contextKey, input.aiCheckResult, input.aiCheckReport, input.overrideReason, updatedAt);
    return { ...input, updatedAt };
  });

}

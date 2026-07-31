import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/database";
import { AccountAlreadyExistsError, AccountRepository } from "../accounts/account-repository";
import { ContentSourceError, ContentSourceService } from "../content/content-source-service";
import { ContentProjectRepository } from "../content/content-project-repository";
import { ContentBriefRepository } from "../content/content-brief-repository";
import { ContentOutlineRepository } from "../content/content-outline-repository";
import { ContentDraftRepository } from "../content/content-draft-repository";
import { ContentResearchRepository } from "../content/content-research-repository";
import { ContentReviewRepository } from "../content/content-review-repository";
import { LocalAssetStore } from "../content/local-asset-store";
import { RemoteImageImportService } from "../content/remote-image-import-service";
import { AiContentService } from "../ai/ai-content-service";
import { createWebSearchClient, TavilyProvider, type VisibleBrowserSearch } from "../ai/web-search";
import { ModelProviderUnavailableError, UnavailableModelProvider, type ModelProvider } from "../ai/model-provider";
import type { CredentialVault } from "../security/credential-vault";
import type { HealthResponse, WorkspaceResponse } from "../../shared/contracts";
import { WechatApiError, WechatPublishingService } from "../wechat/wechat-publishing-service";
import { CsdnChannelError, CsdnChannelService } from "../csdn/csdn-channel-service";
import { WechatCallbackService } from "../wechat/wechat-callback-service";
import { createDailyLogStream, dailyLogFilePath, listRuntimeLogFiles } from "../logging/daily-log-stream";
import { AppCredentialRepository } from "../security/app-credential-repository";
import { CoverGenerationService } from "../content/modelscope-cover-service";
import { ModelConnectionRepository, modelProviderIds } from "../ai/model-connection-repository";
import { SkillRegistry } from "../skills/skill-registry";
import { ConfiguredModelProvider } from "../ai/configured-model-provider";
import { AiAuditLog, auditLogDirectory } from "../ai/ai-audit-log";
import {
  detectCodexBinary,
  loadAppSettings,
  markCodexBinaryMissing,
  markCodexLoginRequired,
  markCodexReady,
  markFirstRunCompleted,
  resolveDataDir,
  saveAppSettings
} from "../config/first-run";
import type {
  AppSettings as AppSettingsContract,
  CodexStatus as CodexStatusContract
} from "../../shared/contracts";

const accountInput = z.object({
  platform: z.enum(["wechat_official", "csdn"]),
  displayName: z.string().trim().min(1).max(100),
  externalAccountId: z.string().trim().min(1).max(200).optional()
});
const accountRenameInput = z.object({ displayName: z.string().trim().min(1).max(100) });

const profileInput = z.object({
  positioning: z.string().max(4000).default(""),
  targetAudience: z.string().max(4000).default(""),
  prohibitedTopics: z.string().max(4000).default(""),
  writingStyle: z.string().max(4000).default(""),
  regularColumns: z.string().max(4000).default("")
});

const credentialInput = z.object({ secret: z.string().min(1).max(10000) });
const contentSourceInput = z.object({ rootPath: z.string().trim().min(1).max(1000) });
const contentSourceArticleQuery = z.object({ path: z.string().trim().min(1).max(1000) });
const contentSourceArticleInput = z.object({ path: z.string().trim().min(1).max(1000), markdown: z.string().max(500000) });
const contentSourceAssetInput = z.object({
  path: z.string().trim().min(1).max(1000),
  mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  base64: z.string().min(1).max(21_000_000)
});
const contentProjectInput = z.object({
  topic: z.string().trim().min(1).max(12000),
  title: z.string().trim().min(1).max(120).optional(),
  targetAccountId: z.string().uuid().optional(),
  objective: z.string().max(4000).optional(),
  audience: z.string().max(4000).optional(),
  angle: z.string().max(4000).optional(),
  sourceNotes: z.string().max(12000).optional()
});
const contentProjectTitleInput = z.object({ title: z.string().trim().min(1).max(120) });
const contentBriefInput = z.object({ topic: z.string().trim().min(1).max(12000).optional(), objective: z.string().max(4000), audience: z.string().max(4000), angle: z.string().max(4000), sourceNotes: z.string().max(12000) });
const titleSuggestionInput = contentBriefInput;
const contentOutlineInput = z.object({ markdown: z.string().trim().min(1).max(30000) });
const contentDraftInput = z.object({ markdown: z.string().trim().min(1).max(100000) });
const researchSelectionInput = z.object({ selected: z.boolean() });
const researchFollowUpInput = z.object({ message: z.string().trim().min(1).max(4000) });
const contentRevisionInput = z.object({ aiCheckResult: z.string().max(4000), guidance: z.string().max(8000) });
const contentAssetInput = z.object({
  contextId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  base64: z.string().min(1).max(21_000_000)
});
const remoteImageImportInput = z.object({
  url: z.string().url().max(4000),
  contextId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  path: z.string().trim().min(1).max(1000).optional()
}).superRefine((value, context) => {
  if (Boolean(value.contextId) === Boolean(value.path)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "必须提供文章路径或素材上下文。" });
  }
});
const contentReviewInput = z.object({ status: z.enum(["pending", "needs_revision", "approved"]), factChecked: z.boolean(), accountFitChecked: z.boolean(), aiCheckResult: z.string().max(4000), notes: z.string().max(8000) });
const wechatDraftInput = z.object({
  accountId: z.string().uuid(),
  projectId: z.string().uuid(),
  author: z.string().max(16).optional(),
  digest: z.string().max(120).optional(),
  thumbMediaId: z.string().max(256).optional(),
  coverSource: z.string().max(2000).optional(),
  needOpenComment: z.boolean().default(true),
  onlyFansCanComment: z.boolean().default(false),
  declareOriginal: z.boolean().default(false),
  enableReward: z.boolean().default(false),
  collectionName: z.string().trim().max(80).default("")
});
const wechatSourceDraftInput = z.object({
  accountId: z.string().uuid(),
  relativePath: z.string().trim().min(1).max(1000),
  author: z.string().max(16).optional(),
  digest: z.string().max(120).optional(),
  thumbMediaId: z.string().max(256).optional(),
  coverSource: z.string().max(2000).optional(),
  needOpenComment: z.boolean().default(true),
  onlyFansCanComment: z.boolean().default(false),
  declareOriginal: z.boolean().default(false),
  enableReward: z.boolean().default(false),
  collectionName: z.string().trim().max(80).default("")
});
const wechatSubmitInput = z.object({ mode: z.enum(["publish", "mass"]) });
const csdnChannelDraftInput = z.object({
  accountId: z.string().uuid(),
  relativePath: z.string().trim().min(1).max(1000),
  projectId: z.string().uuid().optional(),
  generationMode: z.enum(["rewrite", "source"]).default("rewrite")
});
const csdnChannelDraftSaveInput = z.object({
  title: z.string().trim().min(1).max(120),
  markdown: z.string().trim().min(1).max(100_000),
  author: z.string().trim().max(16).optional(),
  digest: z.string().trim().max(200).optional(),
  coverSource: z.string().trim().max(2000).optional()
});
const modelProviderSchema = z.enum(modelProviderIds);
const modelConnectionInput = z.object({
  displayName: z.string().trim().min(1).max(100),
  modelId: z.string().trim().max(200).default(""),
  baseUrl: z.string().trim().max(1000).default(""),
  proxyUrl: z.string().trim().max(1000).default(""),
  enabled: z.boolean().default(true),
  builtInSearch: z.boolean().default(true),
  credential: z.string().max(10000).optional()
});
const tavilySettingsInput = z.object({ apiKey: z.string().trim().min(1).max(10000) });
const tavilyTestInput = z.object({ apiKey: z.string().trim().min(1).max(10000).optional() });
const skillInput = z.object({
  markdown: z.string().min(1).max(100000),
  enabled: z.boolean(),
  provider: modelProviderSchema.nullable()
});
const skillFileQuery = z.object({ path: z.string().trim().min(1).max(500) });
const skillFileInput = z.object({ path: z.string().trim().min(1).max(500), content: z.string().max(200000) });
const articleSummaryInput = z.object({
  platform: z.enum(["wechat_official", "csdn"]),
  title: z.string().trim().max(500).default(""),
  markdown: z.string().trim().min(1).max(500000)
});
const articleSummaryOutput = z.object({ summary: z.string().trim().min(1).max(500) });
const selectionEditInput = z.object({
  action: z.enum(["rewrite", "expand", "shorten", "example", "humanize"]),
  contextKey: z.string().trim().min(1).max(1200).optional(),
  selectedText: z.string().min(1).max(20000),
  beforeText: z.string().max(6000).default(""),
  afterText: z.string().max(6000).default(""),
  title: z.string().max(500).default(""),
  instruction: z.string().trim().max(1000).default("")
});
const selectionEditOutput = z.object({ replacement: z.string().min(1).max(50000) });
const coverPromptInput = z.object({
  title: z.string().trim().max(500).default(""),
  markdown: z.string().trim().min(1).max(500000)
});
const coverPromptOutput = z.object({ prompt: z.string().trim().min(1).max(2000) });
const articleChatQuery = z.object({ contextKey: z.string().trim().min(1).max(1200) });
const articleChatInput = z.object({
  contextKey: z.string().trim().min(1).max(1200),
  clientMessageId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  title: z.string().trim().max(500).default(""),
  markdown: z.string().max(500000),
  message: z.string().trim().min(1).max(12000)
});
const articleChatSuggestion = z.object({
  original: z.string().trim().min(6).max(2000),
  replacement: z.string().trim().min(1).max(3000),
  reason: z.string().trim().min(1).max(500),
  status: z.enum(["pending", "accepted", "rejected", "unavailable"]).default("pending")
});
const articleChatOutput = z.object({ reply: z.string().trim().min(1).max(20000), memorySuggestion: z.string().trim().max(1000).default(""), writingMemorySuggestion: z.string().trim().max(1000).default(""), suggestions: z.array(articleChatSuggestion).max(5).default([]) });
const articleChatMemoryInput = z.object({ contextKey: z.string().trim().min(1).max(1200), memory: z.string().trim().min(1).max(1000) });
const articleChatSuggestionParams = z.object({
  messageId: z.string().uuid(),
  suggestionIndex: z.coerce.number().int().min(0).max(4)
});
const articleChatSuggestionStatusInput = z.object({ status: z.enum(["accepted", "rejected", "unavailable"]) });

export interface CsdnBrowserConfirmResult {
  remoteUrl: string | null;
  remoteContentId: string | null;
}

export function buildServer(
  startedAt: string,
  database: AppDatabase,
  vault: CredentialVault,
  modelProvider: ModelProvider = new UnavailableModelProvider(),
  assetStore?: LocalAssetStore,
  options?: {
    logFilePath?: string;
    skillsDirectory?: string;
    visibleBrowserSearch?: VisibleBrowserSearch;
    csdnBrowserConfirm?: (jobId: string) => Promise<CsdnBrowserConfirmResult | null>;
  }
) {
  const server = Fastify({
    bodyLimit: 22 * 1024 * 1024,
    logger: options?.logFilePath
      ? { level: "info", stream: createDailyLogStream(path.dirname(options.logFilePath)) }
      : true
  });
  const accounts = new AccountRepository(database.connection);
  const contentSources = new ContentSourceService(database.connection);
  const contentProjects = new ContentProjectRepository(database.connection);
  const contentBriefs = new ContentBriefRepository(database.connection);
  const contentOutlines = new ContentOutlineRepository(database.connection);
  const contentDrafts = new ContentDraftRepository(database.connection);
  const contentResearch = new ContentResearchRepository(database.connection);
  const contentReviews = new ContentReviewRepository(database.connection);
  const remoteImages = new RemoteImageImportService(assetStore, contentSources);
  const wechat = new WechatPublishingService(database.connection, accounts, vault, assetStore, contentSources);
  const wechatCallbacks = new WechatCallbackService(database.connection, accounts, vault);
  const appCredentials = new AppCredentialRepository(database.connection, vault);
  const getTavilyApiKey = (): string | undefined => {
    if (appCredentials.configured("web_search:tavily_api_key")) {
      return appCredentials.get("web_search:tavily_api_key");
    }
    return process.env.TAVILY_API_KEY?.trim() || undefined;
  };
  const getResearchProxyUrl = (): string => loadAppSettings().researchProxyUrl?.trim() ?? "";
  const modelConnections = new ModelConnectionRepository(database.connection, appCredentials);
  const skills = options?.skillsDirectory ? new SkillRegistry(database.connection, options.skillsDirectory) : undefined;
  const aiAuditLog = skills ? new AiAuditLog(loadAppSettings().dataDir, () => loadAppSettings().auditAiCalls) : undefined;
  const effectiveModelProvider = skills
    ? new ConfiguredModelProvider(
      modelConnections,
      skills,
      modelProvider,
      aiAuditLog,
      createWebSearchClient({
        getTavilyApiKey,
        getResearchProxyUrl,
        visibleBrowserSearch: options?.visibleBrowserSearch
      })
    )
    : modelProvider;
  const aiContent = new AiContentService(database.connection, effectiveModelProvider);
  const csdnChannels = new CsdnChannelService(database.connection, accounts, contentSources, effectiveModelProvider);
  const coverGenerator = new CoverGenerationService(database.connection, modelConnections, assetStore, contentSources, fetch, aiAuditLog);

  server.addContentTypeParser(["text/xml", "application/xml"], { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  // The desktop UI normally shares the Electron origin. During development it
  // runs at Vite's fixed local address, so only that origin may call this API.
  server.register(cors, {
    origin: "http://127.0.0.1:5175",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"]
  });

  server.setErrorHandler((error, request, reply) => {
    if (error instanceof AccountAlreadyExistsError) {
      return reply.code(409).send({ error: error.message });
    }
    if (error instanceof ContentSourceError) {
      request.log.warn({ err: error }, "Content source request rejected");
      return reply.code(400).send({ error: error.message });
    }
    if (error instanceof ModelProviderUnavailableError) {
      return reply.code(503).send({ error: error.message });
    }
    if (error instanceof WechatApiError) {
      return reply.code(400).send({ error: error.message, errcode: error.errcode });
    }
    if (error instanceof CsdnChannelError) {
      return reply.code(400).send({ error: error.message });
    }
    if (error instanceof z.ZodError) {
      const fields = [...new Set(error.issues.map((issue) => issue.path.join(".") || "请求内容"))];
      request.log.warn({ fields, codes: error.issues.map((issue) => issue.code) }, "Local API input validation failed");
      return reply.code(400).send({ error: `提交的信息不符合要求：${describeValidationIssue(error.issues[0])}` });
    }
    if ((error as { statusCode?: number }).statusCode === 413) {
      return reply.code(413).send({ error: "图片文件过大，请选择 15 MB 以内的图片。" });
    }
    request.log.error({ err: error }, "Unhandled local API request error");
    const sqliteCode = (error as { code?: string }).code;
    if (sqliteCode === "SQLITE_BUSY" || sqliteCode === "SQLITE_LOCKED") {
      return reply.code(409).send({ error: "本地数据库正在被另一个 ContentFerry 进程占用。请关闭其他 ContentFerry 窗口，重新启动后再试。" });
    }
    if (sqliteCode?.startsWith("SQLITE_CONSTRAINT")) {
      return reply.code(409).send({ error: "该账号仍有关联数据，暂时无法删除。详细原因已写入本地日志。" });
    }
    return reply.code(500).send({ error: "本地服务处理请求时发生错误。" });
  });

  server.get<{ Reply: HealthResponse }>("/api/health", async () => ({
    status: "ok",
    database: "ready",
    startedAt
  }));

  const appSettingsInput = z
    .object({
      dataDir: z.string().trim().min(1).max(1000).optional(),
      aiInitStatus: z
        .enum(["not_initialized", "ready", "login_required", "binary_missing"])
        .optional(),
      codexBinaryPath: z.string().trim().max(2000).nullable().optional(),
      auditAiCalls: z.boolean().optional(),
      firstRunCompleted: z.boolean().optional()
    })
    .strict();

  server.get<{ Reply: AppSettingsContract }>("/api/app/settings", async () => loadAppSettings());

  server.put<{ Body: unknown; Reply: AppSettingsContract }>(
    "/api/app/settings",
    async (request, reply) => {
      const patch = appSettingsInput.parse(request.body);
      if (patch.dataDir !== undefined) {
        const resolved = resolveDataDir(patch.dataDir);
        if (!resolved.ok) {
          return reply.code(400).send({ error: resolved.reason ?? "数据目录不可用。" } as never);
        }
        patch.dataDir = resolved.path;
      }
      return saveAppSettings(patch);
    }
  );

  server.post<{ Reply: { directory: string } }>("/api/app/audit-log/clear", async () => {
    const auditLog = new AiAuditLog(loadAppSettings().dataDir, () => loadAppSettings().auditAiCalls);
    auditLog.clear();
    return { directory: auditLogDirectory(loadAppSettings().dataDir) };
  });

  server.get<{ Reply: { directory: string; enabled: boolean } }>("/api/app/audit-log", async () => {
    const settings = loadAppSettings();
    return { directory: auditLogDirectory(settings.dataDir), enabled: settings.auditAiCalls };
  });

  server.post<{ Reply: AppSettingsContract }>("/api/app/settings/complete-first-run", async (request, reply) => {
    const body = z
      .object({ dataDir: z.string().trim().min(1).max(1000) })
      .safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "缺少 dataDir 字段。" } as never);
    }
    return markFirstRunCompleted(body.data.dataDir);
  });

  server.get<{ Reply: CodexStatusContract }>("/api/app/codex-status", async () => detectCodexBinary());

  server.post<{ Body: unknown; Reply: CodexStatusContract }>(
    "/api/app/codex-status/refresh",
    async (_request, reply) => {
      const status = detectCodexBinary();
      if (status.ok && status.binaryPath) {
        markCodexReady(status.binaryPath);
      } else {
        markCodexBinaryMissing();
      }
      return status;
    }
  );

  server.post<{ Reply: { ok: boolean; message?: string } }>("/api/app/codex-login", async (_request, reply) => {
    const status = detectCodexBinary();
    if (!status.ok || !status.binaryPath) {
      markCodexBinaryMissing();
      return reply.code(404).send({ ok: false, message: status.reason ?? "codex 二进制缺失" });
    }
    markCodexLoginRequired();
    return { ok: true, message: "已记录登录请求，请在浏览器中完成 ChatGPT 登录。" };
  });

  server.get("/api/runtime-logs", async (request) => {
    const query = z.object({
      limit: z.coerce.number().int().min(20).max(500).default(200),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      scope: z.enum(["all", "errors", "wechat", "callbacks"]).default("all"),
      search: z.string().trim().max(120).default("")
    }).parse(request.query);
    const logFilePath = options?.logFilePath;
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
    const draft = csdnChannels.getDraftForJob(params.jobId);
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
    if (!options?.csdnBrowserConfirm) throw new CsdnChannelError("当前环境未启用 CSDN 浏览器发布能力。");
    csdnChannels.beginSubmit(params.jobId);
    let receipt: CsdnBrowserConfirmResult | null;
    try {
      receipt = await options.csdnBrowserConfirm(params.jobId);
    } catch (cause) {
      throw cause instanceof CsdnChannelError ? cause : new CsdnChannelError(cause instanceof Error ? cause.message : "CSDN 浏览器确认失败。");
    }
    if (!receipt) {
      return csdnChannels.recordSubmission(params.jobId, { remoteUrl: null, remoteContentId: null, state: "needs_manual_reconciliation", reason: "未能自动读取 CSDN 文章链接。" });
    }
    return reply.code(201).send(csdnChannels.recordSubmission(params.jobId, { ...receipt, state: "published" }));
  });

  server.post("/api/integrations/csdn/jobs/:jobId/status", async (request) => {
    const params = z.object({ jobId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      status: z.enum(["published", "failed", "cancelled"]),
      reason: z.string().max(500).default("")
    }).parse(request.body);
    return csdnChannels.correctStatus(params.jobId, body.status, body.reason);
  });

  server.get("/api/content-projects", async () => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    return { items: contentProjects.list(workspace.id) };
  });

  server.post("/api/content-projects", async (request, reply) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const input = contentProjectInput.parse(request.body);
    const articleTitle = initialArticleTitle(input.topic, input.title);
    const article = contentSources.createArticle(workspace.id, articleTitle);
    const project = database.connection.transaction(() => {
      const created = contentProjects.create({
        workspaceId: workspace.id,
        // The project title is the canonical article title used by the dashboard,
        // outline and VitePress front matter. The longer initial idea is stored in
        // the creation brief rather than competing with the displayed title.
        topic: articleTitle,
        targetAccountId: input.targetAccountId,
        sourceRelativePath: article.relativePath
      });
      if (input.objective !== undefined || input.audience !== undefined || input.angle !== undefined || input.sourceNotes !== undefined) {
        contentBriefs.save(created.id, {
          topic: input.topic,
          objective: input.objective ?? "",
          audience: input.audience ?? "",
          angle: input.angle ?? "",
          sourceNotes: input.sourceNotes ?? ""
        });
      }
      return created;
    })();
    return reply.code(201).send(project);
  });

  server.delete("/api/content-projects/:projectId", async (request, reply) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const project = contentProjects.require(params.projectId);
    if (!project.sourceRelativePath) throw new ContentSourceError("这篇旧草稿尚未迁移到 VitePress 文章库，请先打开正文完成迁移。");
    const staged = contentSources.stageArticleDeletion(project.workspaceId, project.sourceRelativePath);
    try {
      csdnChannels.deleteDraftsBySource(project.workspaceId, project.sourceRelativePath, assetStore);
      database.connection.transaction(() => {
        database.connection.prepare("UPDATE wechat_publish_jobs SET project_id = NULL WHERE project_id = ?").run(project.id);
        database.connection.prepare("DELETE FROM article_settings WHERE context_key IN (?, ?)")
          .run(`project:${project.id}`, `source:${project.sourceRelativePath}`);
        database.connection.prepare("DELETE FROM content_projects WHERE id = ?").run(project.id);
      })();
      staged.finalize();
      return reply.code(204).send();
    } catch (error) {
      staged.rollback();
      throw error;
    }
  });

  server.get("/api/content-projects/:projectId/brief", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return contentBriefs.get(params.projectId);
  });

  server.put("/api/content-projects/:projectId/brief", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const input = contentBriefInput.parse(request.body);
    return contentBriefs.save(params.projectId, { ...input, topic: input.topic ?? contentBriefs.get(params.projectId).topic });
  });

  server.get("/api/content-projects/:projectId/research", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    contentProjects.require(params.projectId);
    return contentResearch.get(params.projectId);
  });

  server.post("/api/content-projects/:projectId/research/generate", async (request, reply) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return streamResearchGeneration(request, reply, params.projectId,
      (onStatus) => aiContent.generateResearch(params.projectId, onStatus),
      (value) => contentResearch.save(params.projectId, value as never)
    );
  });

  server.post("/api/content-projects/:projectId/research/follow-up", async (request, reply) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const input = researchFollowUpInput.parse(request.body);
    const project = contentProjects.require(params.projectId);
    return streamResearchGeneration(request, reply, params.projectId,
      (onStatus) => aiContent.generateResearchFollowUp(params.projectId, input.message, onStatus),
      (value) => {
        const research = contentResearch.append(params.projectId, value as never);
        persistResearchConversation(database, project.sourceRelativePath ? `source:${project.sourceRelativePath}` : `project:${project.id}`, input.message, (value as { planMarkdown: string }).planMarkdown, (value as { sources: Array<{ title: string; url: string }> }).sources);
        return research;
      }
    );
  });

  server.patch("/api/content-projects/:projectId/research/sources/:sourceId", async (request) => {
    const params = z.object({ projectId: z.string().uuid(), sourceId: z.string().uuid() }).parse(request.params);
    const input = researchSelectionInput.parse(request.body);
    return contentResearch.updateSelection(params.projectId, params.sourceId, input.selected);
  });

  server.post("/api/content-projects/:projectId/title/suggest", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const brief = titleSuggestionInput.parse(request.body);
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const historicalSeries = extractHistoricalSeries(contentSources.preview(workspace.id).items.map((item) => item.title));
    const generated = await aiContent.suggestTitles(params.projectId, historicalSeries, { ...brief, creationTopic: brief.topic ?? contentBriefs.get(params.projectId).topic });
    return { projectId: params.projectId, titles: generated.value.titles, historicalSeries, provider: generated.provider, usage: generated.usage };
  });

  server.put("/api/content-projects/:projectId/title", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const { title } = contentProjectTitleInput.parse(request.body);
    const project = contentProjects.require(params.projectId);
    const article = contentSources.getArticle(project.workspaceId, project.sourceRelativePath!);
    const markdown = /^#\s+.+$/m.test(article.markdown)
      ? article.markdown.replace(/^#\s+.+$/m, `# ${title}`)
      : `# ${title}\n\n${article.markdown}`;
    const saved = contentSources.saveArticle(project.workspaceId, project.sourceRelativePath!, markdown);
    contentProjects.updateTopic(project.id, title);
    return { ...contentProjects.require(project.id), sourceRelativePath: saved.relativePath };
  });

  server.get("/api/content-projects/:projectId/outline", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return contentOutlines.get(params.projectId);
  });

  server.post("/api/content-projects/:projectId/outline/generate", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const generated = await aiContent.generateOutline(params.projectId);
    return {
      projectId: params.projectId,
      markdown: generated.value.markdown,
      generatedFromBrief: true,
      provider: generated.provider,
      usage: generated.usage
    };
  });

  server.post("/api/content-projects/:projectId/outline/generate/stream", async (request, reply) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return streamMarkdownGeneration(request, reply, (onDelta, onStatus, signal) => aiContent.generateOutlineStream(params.projectId, onDelta, onStatus, signal), params.projectId);
  });

  server.put("/api/content-projects/:projectId/outline", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return contentOutlines.save(params.projectId, contentOutlineInput.parse(request.body).markdown);
  });

  server.get("/api/content-projects/:projectId/draft", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const project = ensureProjectArticle(params.projectId);
    const draft = contentDrafts.get(params.projectId);
    if (project.draftReady && project.sourceRelativePath) {
      const article = contentSources.getArticle(project.workspaceId, project.sourceRelativePath);
      if (article.markdown !== draft.markdown) return { ...contentDrafts.save(project.id, article.markdown), sourceRelativePath: project.sourceRelativePath };
    }
    return { ...draft, sourceRelativePath: project.sourceRelativePath };
  });

  server.post("/api/content-projects/:projectId/draft/generate", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const project = ensureProjectArticle(params.projectId);
    const generated = await aiContent.generateDraft(params.projectId);
    return {
      projectId: params.projectId,
      markdown: generated.value.markdown,
      generatedFromOutline: true,
      sourceRelativePath: project.sourceRelativePath,
      provider: generated.provider,
      usage: generated.usage
    };
  });

  server.post("/api/content-projects/:projectId/draft/generate/stream", async (request, reply) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const project = ensureProjectArticle(params.projectId);
    return streamMarkdownGeneration(request, reply, (onDelta, onStatus, signal) => aiContent.generateDraftStream(params.projectId, onDelta, onStatus, signal), params.projectId, project.sourceRelativePath);
  });

  server.put("/api/content-projects/:projectId/draft", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const markdown = contentDraftInput.parse(request.body).markdown;
    const project = ensureProjectArticle(params.projectId);
    const saved = contentDrafts.save(params.projectId, markdown);
    const article = contentSources.saveArticle(project.workspaceId, project.sourceRelativePath!, markdown);
    // VitePress uses the front-matter title / leading H1 as the article's source
    // of truth. Keep the workflow card in sync after a user or AI changes it.
    if (article.title && article.title !== project.topic) contentProjects.updateTopic(project.id, article.title);
    const updated = contentProjects.require(project.id);
    return { ...saved, sourceRelativePath: updated.sourceRelativePath };
  });

  server.post("/api/content-projects/:projectId/draft/revise", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    const input = contentRevisionInput.parse(request.body);
    const generated = await aiContent.reviseDraft(params.projectId, input.aiCheckResult, input.guidance);
    return {
      projectId: params.projectId,
      markdown: generated.value.markdown,
      generatedFromOutline: false,
      provider: generated.provider,
      usage: generated.usage
    };
  });

  server.get("/api/content-projects/:projectId/review", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return contentReviews.get(params.projectId);
  });

  server.put("/api/content-projects/:projectId/review", async (request) => {
    const params = z.object({ projectId: z.string().uuid() }).parse(request.params);
    return contentReviews.save(params.projectId, contentReviewInput.parse(request.body));
  });

  function ensureProjectArticle(projectId: string) {
    let project = contentProjects.require(projectId);
    if (!project.sourceRelativePath) {
      const article = contentSources.createArticle(project.workspaceId, project.topic);
      contentProjects.attachSource(project.id, article.relativePath);
      project = contentProjects.require(projectId);
      const existing = database.connection.prepare("SELECT markdown FROM content_drafts WHERE project_id = ?")
        .get(projectId) as { markdown: string } | undefined;
      if (existing?.markdown) contentSources.saveArticle(project.workspaceId, article.relativePath, existing.markdown);
    }
    return project;
  }

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
    return accounts.updateDisplayName(params.accountId, accountRenameInput.parse(request.body).displayName);
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

  server.get("/api/settings/modelscope", async () => ({ configured: appCredentials.configured("modelscope_api_key") }));

  server.put("/api/settings/modelscope", async (request, reply) => {
    const input = credentialInput.parse(request.body);
    appCredentials.save("modelscope_api_key", input.secret);
    return reply.code(204).send();
  });

  server.post("/api/covers/modelscope", async (request, reply) => {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const input = z.object({
      projectId: z.string().uuid().optional(),
      relativePath: z.string().trim().min(1).max(1000).optional(),
      prompt: z.string().max(2000).optional()
    }).refine((value) => Boolean(value.projectId) !== Boolean(value.relativePath), "必须指定一篇文章。").parse(request.body);
    try {
      return await coverGenerator.generate({ workspaceId: workspace.id, provider: "modelscope", ...input });
    } catch (error) {
      request.log.warn({ err: error, provider: "modelscope" }, "Cover generation failed");
      return reply.code(400).send({ error: error instanceof Error ? error.message : "ModelScope 生成封面失败。" });
    }
  });

  server.get("/api/model-connections", async () => ({ items: modelConnections.list() }));

  server.get("/api/web-search/settings", async () => ({
    tavilyConfigured: appCredentials.configured("web_search:tavily_api_key") || Boolean(process.env.TAVILY_API_KEY?.trim()),
    tavilyCredentialSource: appCredentials.configured("web_search:tavily_api_key")
      ? "local"
      : process.env.TAVILY_API_KEY?.trim() ? "environment" : "none",
    researchProxyUrl: loadAppSettings().researchProxyUrl?.trim() ?? ""
  }));

  server.put("/api/web-search/tavily", async (request) => {
    const { apiKey } = tavilySettingsInput.parse(request.body);
    appCredentials.save("web_search:tavily_api_key", apiKey);
    return { tavilyConfigured: true, tavilyCredentialSource: "local" };
  });

  server.delete("/api/web-search/tavily", async () => {
    appCredentials.remove("web_search:tavily_api_key");
    return {
      tavilyConfigured: Boolean(process.env.TAVILY_API_KEY?.trim()),
      tavilyCredentialSource: process.env.TAVILY_API_KEY?.trim() ? "environment" : "none"
    };
  });

  const researchProxyInput = z.object({
    proxyUrl: z
      .string()
      .trim()
      .max(1000)
      .refine((value) => {
        if (value === "") return true;
        try {
          const parsed = new URL(value);
          return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "socks5:";
        } catch {
          return false;
        }
      }, "代理地址格式无效，应为 http://、https:// 或 socks5:// 开头的完整地址。")
  });
  server.put("/api/web-search/proxy", async (request) => {
    const { proxyUrl } = researchProxyInput.parse(request.body);
    saveAppSettings({ researchProxyUrl: proxyUrl });
    return { researchProxyUrl: loadAppSettings().researchProxyUrl?.trim() ?? "" };
  });
  server.delete("/api/web-search/proxy", async () => {
    saveAppSettings({ researchProxyUrl: "" });
    return { researchProxyUrl: "" };
  });

  server.post("/api/web-search/tavily/test", async (request, reply) => {
    try {
      const { apiKey } = tavilyTestInput.parse(request.body);
      const key = apiKey ?? getTavilyApiKey();
      if (!key) return reply.code(400).send({ error: "请先填写 Tavily API Key。" });
      const results = await new TavilyProvider(key).search("ContentFerry 文渡", 1);
      return { ok: true, resultCount: results.length };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Tavily 连接测试失败。" });
    }
  });

  server.put("/api/model-connections/:provider", async (request) => {
    const params = z.object({ provider: modelProviderSchema }).parse(request.params);
    const input = modelConnectionInput.parse(request.body);
    return modelConnections.save({ provider: params.provider, ...input });
  });

  server.get("/api/skills", async (_request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    return { items: skills.list() };
  });

  server.put("/api/skills/:skillId", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const params = z.object({ skillId: z.string().regex(/^[a-z0-9-]+$/) }).parse(request.params);
    return skills.save(params.skillId, skillInput.parse(request.body));
  });

  server.get("/api/skills/:skillId/file", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const params = z.object({ skillId: z.string().regex(/^[a-z0-9-]+$/) }).parse(request.params);
    const query = skillFileQuery.parse(request.query);
    return skills.readFile(params.skillId, query.path);
  });

  server.put("/api/skills/:skillId/file", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const params = z.object({ skillId: z.string().regex(/^[a-z0-9-]+$/) }).parse(request.params);
    const input = skillFileInput.parse(request.body);
    return skills.saveFile(params.skillId, input.path, input.content);
  });

  server.get("/api/article-chat", async (request) => {
    const { contextKey } = articleChatQuery.parse(request.query);
    const thread = database.connection.prepare("SELECT memory, updated_at FROM article_chat_threads WHERE context_key = ?")
      .get(contextKey) as { memory: string; updated_at: string } | undefined;
    const rows = database.connection.prepare(`SELECT id, role, content, memory_suggestion AS memorySuggestion, suggestions_json AS suggestionsJson, created_at AS createdAt
      FROM article_chat_messages WHERE context_key = ? ORDER BY created_at ASC LIMIT 100`).all(contextKey) as Array<{ id: string; role: "user" | "assistant"; content: string; memorySuggestion: string; suggestionsJson: string; createdAt: string }>;
    const messages = rows.map((item) => ({ ...item, suggestions: parseChatSuggestions(item.suggestionsJson) }));
    return { memory: thread?.memory ?? "", updatedAt: thread?.updated_at ?? null, messages };
  });

  // A suggestion remains part of the conversation after a decision. Only its
  // status changes, allowing the author to review what Awen proposed later.
  server.patch("/api/article-chat/messages/:messageId/suggestions/:suggestionIndex", async (request, reply) => {
    const { messageId, suggestionIndex } = articleChatSuggestionParams.parse(request.params);
    const { status } = articleChatSuggestionStatusInput.parse(request.body);
    const row = database.connection.prepare("SELECT suggestions_json AS suggestionsJson FROM article_chat_messages WHERE id = ? AND role = 'assistant'")
      .get(messageId) as { suggestionsJson: string } | undefined;
    if (!row) return reply.code(404).send({ error: "未找到对应的阿文建议。" });
    const suggestions = parseChatSuggestions(row.suggestionsJson);
    if (!suggestions[suggestionIndex]) return reply.code(404).send({ error: "未找到对应的阿文建议。" });
    suggestions[suggestionIndex] = { ...suggestions[suggestionIndex], status };
    database.connection.prepare("UPDATE article_chat_messages SET suggestions_json = ? WHERE id = ?")
      .run(JSON.stringify(suggestions), messageId);
    return { messageId, suggestions };
  });

  server.post("/api/article-chat/messages", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const skill = skills.get("awen-assistant");
    if (!skill.enabled) return reply.code(409).send({ error: "“阿文 · 文章顾问”技能已停用。" });
    const input = articleChatInput.parse(request.body);
    const now = new Date().toISOString();
    database.connection.prepare(`INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, '', ?)
      ON CONFLICT(context_key) DO UPDATE SET updated_at = excluded.updated_at`).run(input.contextKey, now);
    const userMessage = { id: input.clientMessageId ?? randomUUID(), role: "user" as const, content: input.message, memorySuggestion: "", createdAt: now };
    const existingUserMessage = database.connection.prepare("SELECT id FROM article_chat_messages WHERE id = ? AND context_key = ? AND role = 'user'")
      .get(userMessage.id, input.contextKey) as { id: string } | undefined;
    if (!existingUserMessage) {
      database.connection.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, created_at)
        VALUES (?, ?, ?, ?, '', ?)`).run(userMessage.id, input.contextKey, userMessage.role, userMessage.content, now);
    }
    const thread = database.connection.prepare("SELECT memory FROM article_chat_threads WHERE context_key = ?").get(input.contextKey) as { memory: string };
    const writingMemoryScope = input.accountId ? `account:${input.accountId}` : "workspace:default";
    const writingMemory = database.connection.prepare("SELECT memory FROM writing_memories WHERE scope_key = ?").get(writingMemoryScope) as { memory: string } | undefined;
    const history = database.connection.prepare(`SELECT role, content FROM article_chat_messages
      WHERE context_key = ? ORDER BY created_at DESC LIMIT 16`).all(input.contextKey) as Array<{ role: "user" | "assistant"; content: string }>;
    const historyText = history.reverse().map((item) => `${item.role === "user" ? "用户" : "阿文"}：${item.content}`).join("\n\n");
    const article = input.markdown.length > 100000 ? `${input.markdown.slice(0, 100000)}\n\n[正文过长，已截取前 100000 个字符]` : input.markdown;
    const generated = await effectiveModelProvider.generateStructured({
      task: "assistant",
      skillId: "awen-assistant",
      prompt: `你正在和作者讨论一篇文章。只基于文章、会话与记忆给出专业、具体、可执行的建议；不虚构事实。\n\n文章标题：${input.title || "未命名"}\n\n写作能力记忆（跨本账号文章，用于持续优化表达与修改策略）：\n${writingMemory?.memory || "暂无"}\n\n本文记忆（由系统从已完成会话自动提炼）：\n${thread.memory || "暂无"}\n\n最近会话：\n${historyText}\n\n当前文章全文：\n${article}\n\n请回答用户最后的问题。输出本文记忆摘要：只记录本篇可复用且已明确的事实、决定或未解决事项。输出写作能力记忆摘要：只记录跨文章稳定有效的风格偏好、读者反馈、修改取舍或表达策略；临时想法、未经核实的信息与闲聊必须留空。若用户明确要求修改、改写、优化或给出可执行文字建议，再返回最多 5 条建议。每条建议的 original 必须是正文中一段完全相同且唯一出现的原文，replacement 是替换文本，reason 说明理由；否则 suggestions 为空。`,
      outputSchema: { type: "object", properties: { reply: { type: "string" }, memorySuggestion: { type: "string" }, writingMemorySuggestion: { type: "string" }, suggestions: { type: "array", items: { type: "object", properties: { original: { type: "string" }, replacement: { type: "string" }, reason: { type: "string" } }, required: ["original", "replacement", "reason"], additionalProperties: false } } }, required: ["reply", "memorySuggestion", "writingMemorySuggestion", "suggestions"], additionalProperties: false },
      parse: (value) => articleChatOutput.parse(value)
    });
    const suggestions = generated.value.suggestions.filter((item) => isUniqueArticleSuggestion(input.markdown, item.original));
    const assistantMessage = { id: randomUUID(), role: "assistant" as const, content: generated.value.reply, memorySuggestion: generated.value.memorySuggestion, suggestions, createdAt: new Date().toISOString() };
    database.connection.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(assistantMessage.id, input.contextKey, assistantMessage.role, assistantMessage.content, assistantMessage.memorySuggestion, JSON.stringify(suggestions), assistantMessage.createdAt);
    const memory = assistantMessage.memorySuggestion
      ? mergeArticleMemory(database, input.contextKey, assistantMessage.memorySuggestion)
      : thread.memory;
    const writingMemoryResult = generated.value.writingMemorySuggestion
      ? mergeWritingMemory(database, writingMemoryScope, generated.value.writingMemorySuggestion)
      : writingMemory?.memory ?? "";
    return { message: assistantMessage, memory, writingMemory: writingMemoryResult, provider: generated.provider, model: generated.model, usage: generated.usage };
  });

  server.post("/api/article-chat/memory", async (request) => {
    const input = articleChatMemoryInput.parse(request.body);
    const memory = mergeArticleMemory(database, input.contextKey, input.memory);
    return { memory };
  });

  server.post("/api/skills/article-summary/run", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const skill = skills.get("article-summary");
    if (!skill.enabled) return reply.code(409).send({ error: "文章摘要生成技能已停用。" });
    const input = articleSummaryInput.parse(request.body);
    const targets = {
      wechat_official: { maxLength: 120, platformName: "微信公众号" },
      csdn: { maxLength: 200, platformName: "CSDN" }
    } as const;
    const target = targets[input.platform];
    const generated = await effectiveModelProvider.generateStructured({
      task: "summary",
      prompt: `请根据以下原文生成适合${target.platformName}的文章摘要。

硬性要求：
- 摘要最多 ${target.maxLength} 个字符，中文标点也计入；
- 只输出一段摘要，不换行，不使用 Markdown；
- 不得补充原文中没有的事实；
- 标题：${input.title || "未单独提供"}

原文：
${input.markdown}`,
      outputSchema: {
        type: "object",
        properties: { summary: { type: "string", maxLength: target.maxLength } },
        required: ["summary"],
        additionalProperties: false
      },
      parse: (value) => articleSummaryOutput.parse(value)
    });
    const summary = Array.from(generated.value.summary.replace(/\s+/g, " ").trim())
      .slice(0, target.maxLength)
      .join("");
    return {
      summary,
      maxLength: target.maxLength,
      platform: input.platform,
      provider: generated.provider,
      model: generated.model,
      usage: generated.usage
    };
  });

  server.post("/api/skills/selection-edit/run", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const input = selectionEditInput.parse(request.body);
    const skillId = input.action === "humanize" ? "humanize-selection" : "selection-edit";
    const skill = skills.get(skillId);
    if (!skill.enabled) return reply.code(409).send({ error: `“${skill.name}”技能已停用。` });
    let actionName = {
      rewrite: "改写得更清楚自然",
      expand: "扩写并补足必要解释",
      shorten: "缩写并保留核心信息",
      example: "补充真实、具体且与上下文一致的案例",
      humanize: "降低套路感和 AI 写作痕迹"
    }[input.action];
    if (input.instruction) {
      actionName = `${actionName}；补充要求：${input.instruction}。补充要求不得突破技能中的事实、引用、Markdown 与不编造规则。`;
    }
    const generated = await effectiveModelProvider.generateStructured({
      task: "selection",
      skillId,
      prompt: `请对选区执行“${actionName}”。

文章标题：${input.title || "未提供"}

选区前文：
${input.beforeText || "无"}

需要处理的选区：
${input.selectedText}

选区后文：
${input.afterText || "无"}

只返回可以直接替换选区的文本。`,
      outputSchema: {
        type: "object",
        properties: { replacement: { type: "string" } },
        required: ["replacement"],
        additionalProperties: false
      },
      parse: (value) => selectionEditOutput.parse(value)
    });
    return {
      replacement: generated.value.replacement,
      provider: generated.provider,
      model: generated.model,
      usage: generated.usage,
      conversation: input.contextKey ? persistSelectionEditConversation(database, input.contextKey, input, generated.value.replacement) : undefined
    };
  });

  server.post("/api/skills/cover-prompt-generation/run", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const skill = skills.get("cover-prompt-generation");
    if (!skill.enabled) return reply.code(409).send({ error: "封面提示词生成技能已停用。" });
    const input = coverPromptInput.parse(request.body);
    const generated = await effectiveModelProvider.generateStructured({
      task: "cover_prompt",
      skillId: "cover-prompt-generation",
      prompt: `请根据文章标题和完整正文生成一段可编辑的 16:9 文章封面生图提示词。

文章标题：${input.title || "未单独提供"}

文章正文：
${input.markdown}`,
      outputSchema: {
        type: "object",
        properties: { prompt: { type: "string", maxLength: 2000 } },
        required: ["prompt"],
        additionalProperties: false
      },
      parse: (value) => coverPromptOutput.parse(value)
    });
    return {
      prompt: generated.value.prompt,
      provider: generated.provider,
      model: generated.model,
      usage: generated.usage
    };
  });

  server.post("/api/skills/cover-generation/run", async (request, reply) => {
    if (!skills) return reply.code(503).send({ error: "技能目录尚未启用。" });
    const skill = skills.get("cover-generation");
    if (!skill.enabled) return reply.code(409).send({ error: "文章封面生成技能已停用。" });
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const input = z.object({
      projectId: z.string().uuid().optional(),
      relativePath: z.string().trim().min(1).max(1000).optional(),
      prompt: z.string().max(2000).optional(),
      provider: z.enum(["modelscope", "agnes"]).optional()
    }).refine((value) => Boolean(value.projectId) !== Boolean(value.relativePath), "必须指定一篇文章。").parse(request.body);
    const provider = input.provider ?? skill.provider;
    if (provider !== "modelscope" && provider !== "agnes") {
      return reply.code(400).send({ error: "请在技能设置中选择 ModelScope 或 Agnes AI。" });
    }
    try {
      return await coverGenerator.generate({ workspaceId: workspace.id, ...input, provider });
    } catch (error) {
      request.log.warn({ err: error, provider }, "Cover generation failed");
      return reply.code(400).send({ error: error instanceof Error ? error.message : "封面生成失败。" });
    }
  });

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

  return server;
}

export async function createServer(
  startedAt: string,
  database: AppDatabase,
  vault: CredentialVault,
  modelProvider?: ModelProvider,
  assetStore?: LocalAssetStore,
  logFilePath?: string,
  skillsDirectory?: string,
  visibleBrowserSearch?: VisibleBrowserSearch,
  csdnBrowserConfirm?: (jobId: string) => Promise<CsdnBrowserConfirmResult | null>
) {
  const server = buildServer(startedAt, database, vault, modelProvider, assetStore, { logFilePath, skillsDirectory, visibleBrowserSearch, csdnBrowserConfirm });
  await server.listen({ host: "127.0.0.1", port: 4317 });
  return server;
}

function mergeArticleMemory(database: AppDatabase, contextKey: string, candidate: string): string {
  const normalized = candidate.replace(/\s+/g, " ").trim();
  if (!normalized) return (database.connection.prepare("SELECT memory FROM article_chat_threads WHERE context_key = ?").get(contextKey) as { memory: string } | undefined)?.memory ?? "";
  const row = database.connection.prepare("SELECT memory FROM article_chat_threads WHERE context_key = ?").get(contextKey) as { memory: string } | undefined;
  const entries = (row?.memory ?? "").split("\n").map((item) => item.replace(/^-\s*/, "").trim()).filter(Boolean);
  if (!entries.some((item) => item === normalized)) entries.push(normalized);
  const memory = entries.slice(-20).map((item) => `- ${item}`).join("\n").slice(0, 6000);
  database.connection.prepare(`INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(context_key) DO UPDATE SET memory = excluded.memory, updated_at = excluded.updated_at`)
    .run(contextKey, memory, new Date().toISOString());
  return memory;
}

function persistResearchConversation(
  database: AppDatabase,
  contextKey: string,
  instruction: string,
  planMarkdown: string,
  sources: Array<{ title: string; url: string }>
): void {
  const userCreatedAt = new Date().toISOString();
  const assistantCreatedAt = new Date(Date.now() + 1).toISOString();
  const sourceSummary = sources.length > 0
    ? `\n\n本轮新增资料：\n${sources.map((source) => `- ${source.title}\n  ${source.url}`).join("\n")}`
    : "\n\n本轮未找到可确认的新增资料。";
  const save = database.connection.transaction(() => {
    database.connection.prepare(`INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, '', ?)
      ON CONFLICT(context_key) DO UPDATE SET updated_at = excluded.updated_at`).run(contextKey, assistantCreatedAt);
    database.connection.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
      VALUES (?, ?, 'user', ?, '', '[]', ?)`)
      .run(randomUUID(), contextKey, `【补充资料】\n${instruction}`, userCreatedAt);
    database.connection.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
      VALUES (?, ?, 'assistant', ?, '', '[]', ?)`)
      .run(randomUUID(), contextKey, `【补研结果】\n${planMarkdown.trim()}${sourceSummary}`, assistantCreatedAt);
  });
  save();
}

function mergeWritingMemory(database: AppDatabase, scopeKey: string, candidate: string): string {
  const normalized = candidate.replace(/\s+/g, " ").trim();
  const row = database.connection.prepare("SELECT memory FROM writing_memories WHERE scope_key = ?").get(scopeKey) as { memory: string } | undefined;
  if (!normalized) return row?.memory ?? "";
  const entries = (row?.memory ?? "").split("\n").map((item) => item.replace(/^-\s*/, "").trim()).filter(Boolean);
  if (!entries.includes(normalized)) entries.push(normalized);
  const memory = entries.slice(-30).map((item) => `- ${item}`).join("\n").slice(0, 8000);
  database.connection.prepare(`INSERT INTO writing_memories (scope_key, memory, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET memory = excluded.memory, updated_at = excluded.updated_at`)
    .run(scopeKey, memory, new Date().toISOString());
  return memory;
}

function isUniqueArticleSuggestion(markdown: string, original: string): boolean {
  const first = markdown.indexOf(original);
  return first >= 0 && markdown.indexOf(original, first + original.length) < 0;
}

function parseChatSuggestions(value: string): Array<{ original: string; replacement: string; reason: string; status: "pending" | "accepted" | "rejected" | "unavailable" }> {
  try { return z.array(articleChatSuggestion).parse(JSON.parse(value)); }
  catch { return []; }
}

function persistSelectionEditConversation(
  database: AppDatabase,
  contextKey: string,
  input: z.infer<typeof selectionEditInput>,
  replacement: string
): {
  userMessage: { id: string; role: "user"; content: string; memorySuggestion: string; suggestions: []; createdAt: string };
  assistantMessage: { id: string; role: "assistant"; content: string; memorySuggestion: string; suggestions: Array<{ original: string; replacement: string; reason: string }>; createdAt: string };
} {
  const now = new Date().toISOString();
  database.connection.prepare(`INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, '', ?)
    ON CONFLICT(context_key) DO UPDATE SET updated_at = excluded.updated_at`).run(contextKey, now);
  const userMessage = {
    id: randomUUID(),
    role: "user" as const,
    content: `[选区 AI 编辑 · ${selectionActionLabel(input.action)}]${input.instruction ? `\n要求：${input.instruction}` : ""}\n\n${input.selectedText}`,
    memorySuggestion: "",
    suggestions: [] as [],
    createdAt: now
  };
  database.connection.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, created_at)
    VALUES (?, ?, ?, ?, '', ?)`).run(userMessage.id, contextKey, userMessage.role, userMessage.content, now);
  const suggestions = input.selectedText.trim().length >= 6
    ? [{ original: input.selectedText, replacement, reason: `按“${selectionActionLabel(input.action)}”生成的替换建议${input.instruction ? `；已考虑你的补充要求` : ""}`, status: "pending" as const }]
    : [];
  const assistantMessage = {
    id: randomUUID(),
    role: "assistant" as const,
    content: suggestions.length > 0 ? "已生成一条可应用的选区修改建议。你可以在正文旁或本对话中接受、拒绝，或先查看对比。" : "已生成选区修改结果；选区过短，无法作为可定位的正文建议保存。",
    memorySuggestion: "",
    suggestions,
    createdAt: now
  };
  database.connection.prepare(`INSERT INTO article_chat_messages (id, context_key, role, content, memory_suggestion, suggestions_json, created_at)
    VALUES (?, ?, ?, ?, '', ?, ?)`)
    .run(assistantMessage.id, contextKey, assistantMessage.role, assistantMessage.content, JSON.stringify(suggestions), now);
  return { userMessage, assistantMessage };
}

function selectionActionLabel(action: z.infer<typeof selectionEditInput>["action"]): string {
  return {
    rewrite: "改写",
    expand: "扩写",
    shorten: "缩写",
    example: "补充案例",
    humanize: "去 AI 味"
  }[action];
}

async function streamMarkdownGeneration(
  request: FastifyRequest,
  reply: FastifyReply,
  generate: (onDelta: (markdown: string) => void, onStatus: (message: string) => void, signal: AbortSignal) => Promise<{ value: { markdown: string }; provider: string; usage: unknown }>,
  projectId: string,
  sourceRelativePath?: string | null
) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) request.log.warn({ projectId }, "AI generation stream was aborted by the client connection");
    controller.abort();
  };
  request.raw.once("aborted", abort);
  reply.hijack();
  // `reply.hijack()` bypasses Fastify's normal reply lifecycle. That is
  // required for SSE, but also means @fastify/cors does not serialize its
  // headers into `reply.raw`. Without this explicit header Chromium accepts
  // the preflight but rejects the actual stream as a CORS failure, which the
  // renderer can only surface as "Failed to fetch".
  const requestOrigin = request.headers.origin;
  const corsOrigin = requestOrigin === "http://127.0.0.1:5175"
    ? requestOrigin
    : undefined;
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    ...(corsOrigin ? { "access-control-allow-origin": corsOrigin, vary: "Origin" } : {})
  });
  reply.raw.flushHeaders();
  const send = (event: string, data: unknown) => {
    if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const startedAt = Date.now();
  send("status", { phase: "connecting", elapsedSeconds: 0, message: "正在连接 AI…" });
  // Codex can spend a while reasoning before its first Markdown item is
  // emitted. Keep the SSE connection visibly alive during that period so the
  // renderer can distinguish "still working" from a frozen dialog.
  let latestPhase = "正在连接 AI…";
  const reportStatus = (message: string) => {
    latestPhase = message;
    send("status", { phase: "generating", elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)), message });
  };
  const progressTimer = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    send("status", {
      phase: "generating",
      elapsedSeconds,
      message: `${latestPhase}（已等待 ${elapsedSeconds} 秒）`
    });
  }, 2_000);
  try {
    const generated = await generate((markdown) => send("delta", { markdown }), reportStatus, controller.signal);
    send("complete", { projectId, markdown: generated.value.markdown, generatedFromBrief: true, sourceRelativePath, provider: generated.provider, usage: generated.usage });
  } catch (error) {
    send("error", { error: error instanceof Error ? error.message : "AI 生成失败。", cancelled: controller.signal.aborted });
  } finally {
    clearInterval(progressTimer);
    request.raw.off("aborted", abort);
    reply.raw.end();
  }
}

async function streamResearchGeneration(
  request: FastifyRequest,
  reply: FastifyReply,
  projectId: string,
  generate: (onStatus: (message: string) => void) => Promise<{ value: unknown; provider: string; model: string | null; usage: unknown }>,
  save: (value: unknown) => unknown
) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) request.log.warn({ projectId }, "research stream aborted by client connection");
    controller.abort();
  };
  request.raw.once("aborted", abort);
  reply.hijack();
  const requestOrigin = request.headers.origin;
  const corsOrigin = requestOrigin === "http://127.0.0.1:5175" ? requestOrigin : undefined;
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    ...(corsOrigin ? { "access-control-allow-origin": corsOrigin, vary: "Origin" } : {})
  });
  reply.raw.flushHeaders();
  const send = (event: string, data: unknown) => {
    if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const startedAt = Date.now();
  let latestPhase = "正在处理…";
  const reportStatus = (message: string) => {
    latestPhase = message;
    send("status", { phase: "researching", elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)), message });
  };
  const progressTimer = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
    send("status", { phase: "researching", elapsedSeconds, message: `${latestPhase}（已等待 ${elapsedSeconds} 秒）` });
  }, 2_000);
  try {
    const generated = await generate(reportStatus);
    const research = save(generated.value) as Record<string, unknown>;
    send("complete", { ...research, provider: generated.provider, model: generated.model, usage: generated.usage });
  } catch (error) {
    send("error", { error: error instanceof Error ? error.message : "资料补研失败。", cancelled: controller.signal.aborted });
  } finally {
    clearInterval(progressTimer);
    request.raw.off("aborted", abort);
    reply.raw.end();
  }
}

function redactLogValue(value: string): string {
  return value
    .replace(/([?&]access_token=)[^&\s]+/gi, "$1***")
    .replace(/((?:api[_-]?key|appsecret|authorization|token)[\"'=:\s]+)[^,\s\"&]+/gi, "$1***");
}

function describeValidationIssue(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return "请检查填写内容后重试。";
  const field = ({ topic: "文章主题或想法", title: "文章标题", targetAccountId: "发布账号" } as Record<string, string>)[issue.path.join(".")] ?? "填写内容";
  if (issue.code === "too_big") return `${field}过长。`;
  if (issue.code === "too_small") return `${field}不能为空。`;
  if (issue.code === "invalid_format") return `${field}格式不正确。`;
  return `${field}无效，请检查后重试。`;
}

function initialArticleTitle(topic: string, title?: string): string {
  if (title) return title;
  const normalizedTopic = topic.replace(/\s+/g, " ").trim();
  if (normalizedTopic.length <= 120) return normalizedTopic;
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  return `创作草稿-${timestamp}`;
}

function extractHistoricalSeries(titles: Array<string | null>): Array<{ name: string; count: number; examples: string[] }> {
  const groups = new Map<string, string[]>();
  for (const title of titles) {
    if (!title) continue;
    const match = /^\s*(.{2,40}?系列)\s*(?:——|—|：|:|-)/.exec(title);
    if (!match) continue;
    const name = match[1].replace(/\s+/g, " ").trim();
    if (!name) continue;
    const entries = groups.get(name) ?? [];
    entries.push(title.trim());
    groups.set(name, entries);
  }
  return [...groups.entries()]
    .map(([name, examples]) => ({ name, count: examples.length, examples: examples.slice(0, 3) }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN"))
    .slice(0, 12);
}

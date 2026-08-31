import Fastify, { type FastifyBaseLogger } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import path from "node:path";
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
import { createWebSearchClient, type VisibleBrowserSearch } from "../ai/web-search";
import { ModelProviderUnavailableError, UnavailableModelProvider, type ModelProvider } from "../ai/model-provider";
import type { CredentialVault } from "../security/credential-vault";
import type { HealthResponse } from "../../shared/contracts";
import { WechatApiError, WechatPublishingService } from "../wechat/wechat-publishing-service";
import { CsdnChannelError, CsdnChannelService } from "../csdn/csdn-channel-service";
import { CnblogsChannelError, CnblogsChannelService } from "../cnblogs/cnblogs-channel-service";
import { JuejinChannelError, JuejinChannelService } from "../juejin/juejin-channel-service";
import { FiftyoneCtoChannelError, FiftyoneCtoChannelService } from "../fiftyone-cto/fiftyone-cto-channel-service";
import { WechatCallbackService } from "../wechat/wechat-callback-service";
import { createDailyLogStream } from "../logging/daily-log-stream";
import { AppCredentialRepository } from "../security/app-credential-repository";
import { CoverGenerationService } from "../content/modelscope-cover-service";
import { ModelConnectionRepository } from "../ai/model-connection-repository";
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
import type { CsdnBrowserConfirmResult } from "./schemas";
import { describeValidationIssue } from "./helpers";
import type { ServerContext } from "./server-context";
import { registerSystemRoutes } from "./routes-system";
import { registerContentSourceRoutes } from "./routes-content-source";
import { registerChannelsRoutes } from "./routes-channels";
import { registerJuejinRoutes } from "./routes-juejin";
import { registerFiftyoneCtoRoutes } from "./routes-fiftyone-cto";
import { registerProjectsRoutes } from "./routes-projects";
import { registerAccountsRoutes } from "./routes-accounts";
import { registerSettingsRoutes } from "./routes-settings";
import { registerChatRoutes } from "./routes-chat";
import { registerWechatRoutes } from "./routes-wechat";

const LEGACY_ARCHIVE_CUTOFF = "2026-08-11 00:00:00";

function runLegacyArchiveMigration(
  contentSources: ContentSourceService,
  accounts: AccountRepository,
  log: FastifyBaseLogger
): void {
  const settings = loadAppSettings();
  if (settings.legacyArchiveMigrationDone) return;
  try {
    const workspace = accounts.getOrCreateDefaultWorkspace();
    const rootPath = contentSources.getSource(workspace.id);
    if (!rootPath) {
      log.info("Legacy archive migration skipped: no content source configured yet");
      return;
    }
    const result = contentSources.archiveArticlesBefore(workspace.id, LEGACY_ARCHIVE_CUTOFF);
    log.info(
      { archivedCount: result.archivedCount, cutoff: LEGACY_ARCHIVE_CUTOFF },
      "Legacy archive migration completed"
    );
    saveAppSettings({ legacyArchiveMigrationDone: true });
  } catch (error) {
    log.warn({ err: error }, "Legacy archive migration failed; will retry on next launch");
  }
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
    /** 可选注入：外部提供博客园渠道稿服务实例（默认由 buildServer 内部构造）。 */
    cnblogsChannel?: CnblogsChannelService;
    /** 可选注入：外部提供掘金渠道稿服务实例（默认由 buildServer 内部构造）。 */
    juejinChannel?: JuejinChannelService;
    /** 是否执行一次性存量数据迁移（应用启动时启用，测试默认关闭）。 */
    runMigrations?: boolean;
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
  const csdnChannels = new CsdnChannelService(database.connection, accounts, contentSources, effectiveModelProvider, assetStore);
  const cnblogsChannels = options?.cnblogsChannel
    ?? new CnblogsChannelService(database.connection, accounts, vault, contentSources, effectiveModelProvider, assetStore);
  const juejinChannels = options?.juejinChannel
    ?? new JuejinChannelService(database.connection, accounts, vault, contentSources, effectiveModelProvider, assetStore);
  const fiftyoneCtoChannels = new FiftyoneCtoChannelService(database.connection, accounts, vault, contentSources, effectiveModelProvider, assetStore);
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
    if (error instanceof CnblogsChannelError) {
      return reply.code(400).send({ error: error.message });
    }
    if (error instanceof JuejinChannelError) {
      return reply.code(400).send({ error: error.message });
    }
    if (error instanceof FiftyoneCtoChannelError) {
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


  const ctx: ServerContext = {
    server,
    startedAt,
    logFilePath: options?.logFilePath,
    csdnBrowserConfirm: options?.csdnBrowserConfirm,
    database,
    vault,
    modelProvider,
    assetStore,
    accounts,
    contentSources,
    contentProjects,
    contentBriefs,
    contentOutlines,
    contentDrafts,
    contentResearch,
    contentReviews,
    remoteImages,
    wechat,
    wechatCallbacks,
    appCredentials,
    getTavilyApiKey,
    getResearchProxyUrl,
    modelConnections,
    skills,
    aiAuditLog,
    effectiveModelProvider,
    aiContent,
    csdnChannels,
    cnblogsChannels,
    juejinChannels,
    fiftyoneCtoChannels,
    coverGenerator
  };

  registerSystemRoutes(ctx);
  registerContentSourceRoutes(ctx);
  registerChannelsRoutes(ctx);
  registerJuejinRoutes(ctx);
  registerFiftyoneCtoRoutes(ctx);
  registerProjectsRoutes(ctx);
  registerAccountsRoutes(ctx);
  registerSettingsRoutes(ctx);
  registerChatRoutes(ctx);
  registerWechatRoutes(ctx);

  if (options?.runMigrations) {
    runLegacyArchiveMigration(contentSources, accounts, server.log);
  }

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
  csdnBrowserConfirm?: (jobId: string) => Promise<CsdnBrowserConfirmResult | null>,
  juejinChannel?: JuejinChannelService
) {
  const server = buildServer(startedAt, database, vault, modelProvider, assetStore, { logFilePath, skillsDirectory, visibleBrowserSearch, csdnBrowserConfirm, juejinChannel, runMigrations: true });
  await server.listen({ host: "127.0.0.1", port: 4317 });
  return server;
}


import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AccountRepository } from "../accounts/account-repository";
import type { ContentSourceService } from "../content/content-source-service";
import type { LocalAssetStore } from "../content/local-asset-store";
import type { ModelProvider } from "../ai/model-provider";
import type { PublishCapabilities } from "../publishing/platform-publisher-connector";

const csdnDraftSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    markdown: { type: "string" }
  },
  required: ["title", "markdown"],
  additionalProperties: false
} as const;

export class CsdnChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsdnChannelError";
  }
}

export type CsdnChannelDraftStatus = "draft" | "approved" | "superseded";
export type CsdnChannelDraftGenerationMode = "rewrite" | "source";
export type CsdnPublishJobStatus =
  | "queued"
  | "needs_login"
  | "filling"
  | "ready_for_final_confirmation"
  | "submitting"
  | "published"
  | "needs_manual_reconciliation"
  | "failed_before_submit"
  | "cancelled";

export interface CsdnChannelDraft {
  id: string;
  workspaceId: string;
  accountId: string;
  projectId: string | null;
  sourceRelativePath: string;
  sourceHash: string;
  generationMode: CsdnChannelDraftGenerationMode;
  title: string;
  markdown: string;
  author: string;
  digest: string;
  coverSource: string;
  status: CsdnChannelDraftStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CsdnPublishJob {
  id: string;
  workspaceId: string;
  accountId: string;
  channelDraftId: string;
  renderedPackageHash: string;
  idempotencyKey: string;
  status: CsdnPublishJobStatus;
  remoteUrl: string | null;
  remoteContentId: string | null;
  statusNote: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CsdnChannelService {
  constructor(
    private readonly db: Database.Database,
    private readonly accounts: AccountRepository,
    private readonly contentSources: ContentSourceService,
    private readonly modelProvider: ModelProvider
  ) {}

  capabilities(_accountId: string): PublishCapabilities {
    return {
      canCreateRemoteDraft: false,
      canSubmitAfterConfirmation: false,
      canReadRemoteReceipt: false,
      supportsExternalLink: "restricted",
      supportsScheduledPublish: false
    };
  }

  async createFromSource(input: {
    accountId: string;
    relativePath: string;
    projectId?: string;
    generationMode?: CsdnChannelDraftGenerationMode;
  }): Promise<CsdnChannelDraft> {
    const account = this.accounts.requireAccount(input.accountId);
    if (account.platform !== "csdn") throw new CsdnChannelError("请选择一个 CSDN 账号创建渠道稿。");
    const article = this.contentSources.getArticle(account.workspaceId, input.relativePath);
    const sourceHash = digest(article.markdown);
    const generationMode = input.generationMode ?? "rewrite";
    const existing = this.db.prepare(`SELECT * FROM channel_drafts
      WHERE account_id = ? AND source_relative_path = ? AND source_hash = ? AND generation_mode = ? AND status IN ('draft', 'approved')
      ORDER BY updated_at DESC LIMIT 1`).get(account.id, article.relativePath, sourceHash, generationMode) as Record<string, string | null> | undefined;
    if (existing) return mapDraft(existing);

    const title = (article.title ?? firstHeading(article.markdown) ?? "未命名文章").slice(0, 120);
    const generatedDraft = generationMode === "rewrite"
      ? (await this.modelProvider.generateStructured({
          task: "revision",
          skillId: "platform-rewrite",
          prompt: buildCsdnRewritePrompt({
            title,
            markdown: article.markdown,
            positioning: account.profile.positioning,
            audience: account.profile.targetAudience,
            writingStyle: account.profile.writingStyle,
            prohibitedTopics: account.profile.prohibitedTopics
          }),
          outputSchema: csdnDraftSchema,
          timeoutMs: 240_000,
          parse: (value) => parseGeneratedDraft(value)
        })).value
      : { title, markdown: article.markdown };
    const markdown = normalizeMarkdown(generatedDraft.markdown, generatedDraft.title);
    assertNoCsdnPromotion(markdown);
    const sourceSettings = this.db.prepare("SELECT author, digest, cover_source FROM article_settings WHERE context_key = ?")
      .get(`source:${article.relativePath}`) as { author: string | null; digest: string | null; cover_source: string | null } | undefined;
    const author = sourceSettings?.author ?? "";
    const sourceDigest = sourceSettings?.digest ?? "";
    const coverSource = sourceSettings?.cover_source ?? "";
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE channel_drafts SET status = 'superseded', updated_at = ?
        WHERE account_id = ? AND source_relative_path = ? AND status IN ('draft', 'approved')`).run(now, account.id, article.relativePath);
      this.db.prepare(`INSERT INTO channel_drafts
        (id, workspace_id, account_id, project_id, source_relative_path, source_hash, generation_mode, title, markdown, author, digest, cover_source, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
        .run(id, account.workspaceId, account.id, input.projectId ?? null, article.relativePath, sourceHash, generationMode,
          generatedDraft.title.trim().slice(0, 120), markdown, author, sourceDigest.slice(0, 200), coverSource, now, now);
    })();
    return this.requireDraft(id);
  }

  deleteDraftsBySource(workspaceId: string, relativePath: string, assetStore?: LocalAssetStore): number {
    const rows = this.db.prepare("SELECT id FROM channel_drafts WHERE workspace_id = ? AND source_relative_path = ?")
      .all(workspaceId, relativePath) as Array<{ id: string }>;
    for (const { id } of rows) {
      if (!assetStore) continue;
      try { assetStore.deleteContext(id); } catch { /* 图片目录可能不存在，忽略 */ }
    }
    if (rows.length === 0) return 0;
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM csdn_publish_job_events WHERE job_id IN (SELECT id FROM csdn_publish_jobs WHERE channel_draft_id IN (${placeholders}))`).run(...ids);
      this.db.prepare(`DELETE FROM csdn_publish_jobs WHERE channel_draft_id IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM channel_drafts WHERE id IN (${placeholders})`).run(...ids);
    })();
    return ids.length;
  }

  listDrafts(workspaceId: string, accountId?: string): CsdnChannelDraft[] {
    const rows = accountId
      ? this.db.prepare("SELECT * FROM channel_drafts WHERE workspace_id = ? AND account_id = ? ORDER BY updated_at DESC LIMIT 100").all(workspaceId, accountId)
      : this.db.prepare("SELECT * FROM channel_drafts WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 100").all(workspaceId);
    return (rows as Array<Record<string, string | null>>).map(mapDraft);
  }

  approveDraft(id: string): CsdnChannelDraft {
    const draft = this.requireDraft(id);
    if (draft.status !== "draft") throw new CsdnChannelError("只有待审核的 CSDN 渠道稿可以冻结发布。");
    assertNoCsdnPromotion(draft.markdown);
    this.db.prepare("UPDATE channel_drafts SET status = 'approved', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return this.requireDraft(id);
  }

  saveDraft(id: string, input: { title: string; markdown: string; author?: string; digest?: string; coverSource?: string }): CsdnChannelDraft {
    const draft = this.requireDraft(id);
    if (draft.status !== "draft") throw new CsdnChannelError("已冻结的 CSDN 渠道稿不能直接修改；请基于最新主稿重新生成。");
    const title = input.title.trim();
    if (!title || title.length > 120) throw new CsdnChannelError("CSDN 渠道稿标题不能为空且不能超过 120 个字符。");
    if (!input.markdown.trim() || input.markdown.length > 100_000) throw new CsdnChannelError("CSDN 渠道稿正文不能为空且不能超过 100000 个字符。");
    const markdown = normalizeMarkdown(input.markdown, title);
    assertNoCsdnPromotion(markdown);
    const author = (input.author ?? "").slice(0, 16);
    const digest = (input.digest ?? "").slice(0, 200);
    const coverSource = input.coverSource ?? "";
    this.db.prepare("UPDATE channel_drafts SET title = ?, markdown = ?, author = ?, digest = ?, cover_source = ?, updated_at = ? WHERE id = ?")
      .run(title, markdown, author, digest, coverSource, new Date().toISOString(), id);
    return this.requireDraft(id);
  }

  createPublishJob(channelDraftId: string): CsdnPublishJob {
    const draft = this.requireDraft(channelDraftId);
    if (draft.status !== "approved") throw new CsdnChannelError("请先审核并冻结 CSDN 渠道稿，再创建发布任务。");
    const renderedPackageHash = digest(`${draft.title}\n${draft.markdown}`);
    const idempotencyKey = `csdn:${draft.accountId}:${draft.id}:${renderedPackageHash}:publish`;
    const found = this.db.prepare("SELECT * FROM csdn_publish_jobs WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, string | null> | undefined;
    if (found) return mapJob(found);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO csdn_publish_jobs
        (id, workspace_id, account_id, channel_draft_id, rendered_package_hash, idempotency_key, status, status_note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
        .run(id, draft.workspaceId, draft.accountId, draft.id, renderedPackageHash, idempotencyKey,
          "渠道稿已冻结；等待 CSDN 浏览器能力验证后再填充和提交。", now, now);
      this.db.prepare(`INSERT INTO csdn_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, '', 'queued', 'system', '创建冻结版本的发布任务', ?)`)
        .run(randomUUID(), id, now);
    })();
    return this.requireJob(id);
  }

  listJobs(workspaceId: string): CsdnPublishJob[] {
    return (this.db.prepare("SELECT * FROM csdn_publish_jobs WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 100")
      .all(workspaceId) as Array<Record<string, string | null>>).map(mapJob);
  }

  private requireDraft(id: string): CsdnChannelDraft {
    const row = this.db.prepare("SELECT * FROM channel_drafts WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!row) throw new CsdnChannelError("找不到对应的 CSDN 渠道稿。");
    return mapDraft(row);
  }

  private requireJob(id: string): CsdnPublishJob {
    const row = this.db.prepare("SELECT * FROM csdn_publish_jobs WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!row) throw new CsdnChannelError("找不到对应的 CSDN 发布任务。");
    return mapJob(row);
  }
}

function parseGeneratedDraft(value: unknown): { title: string; markdown: string } {
  if (!value || typeof value !== "object") throw new CsdnChannelError("模型没有返回可用的 CSDN 渠道稿。");
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const markdown = typeof record.markdown === "string" ? record.markdown.trim() : "";
  if (!title || title.length > 120 || !markdown || markdown.length > 100_000) {
    throw new CsdnChannelError("模型返回的 CSDN 渠道稿不完整，请重新生成。");
  }
  return { title, markdown };
}

function normalizeMarkdown(markdown: string, title: string): string {
  const withoutFrontMatter = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
  const withoutLeadingTitle = withoutFrontMatter.replace(/^#\s+.+\n+/, "").trim();
  return `# ${title}\n\n${withoutLeadingTitle}`;
}

function assertNoCsdnPromotion(markdown: string): void {
  const forbidden = [
    /https?:\/\/mp\.weixin\.qq\.com\//i,
    /公众号原文/,
    /延伸阅读/,
    /关注(?:我的|本)?公众号/,
    /扫描(?:下方|文末)?二维码/
  ];
  if (forbidden.some((pattern) => pattern.test(markdown))) {
    throw new CsdnChannelError("生成的 CSDN 渠道稿包含被禁用的公众号引流内容，请重新生成。");
  }
}

function buildCsdnRewritePrompt(input: {
  title: string;
  markdown: string;
  positioning: string;
  audience: string;
  writingStyle: string;
  prohibitedTopics: string;
}): string {
  return `你是专业的技术内容编辑。请把下面主稿改写成一篇适合 CSDN 技术读者独立阅读的中文文章。

硬性要求：
- 文章必须是独立内容，允许大幅调整标题、结构、段落顺序和表达，但不能编造事实、数据、经历、引用或来源。
- 保留可验证的代码、命令、链接与事实；对不确定信息保持原文的限定，而不是补造结论。
- 彻底去除公众号软引流：不得出现微信公众号原文链接、公众号引导、正文引用链接、文末延伸阅读、二维码、评论区引流或“关注公众号”等措辞。
- 用自然、具体、面向开发者的表达，避免模板化 AI 腔和空泛总结。
- 输出 JSON：title 为不超过 120 字的标题；markdown 为完整 Markdown 正文。markdown 的第一行必须是 "# {title}"。

账号定位：${input.positioning || "未设置"}
目标读者：${input.audience || "CSDN 技术读者"}
写作风格：${input.writingStyle || "清晰、具体、自然"}
禁用话题/表达：${input.prohibitedTopics || "无"}

主稿标题：${input.title}

主稿正文：
${input.markdown}`;
}

function firstHeading(markdown: string): string | null {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? null;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mapDraft(row: Record<string, string | null>): CsdnChannelDraft {
  return {
    id: row.id!, workspaceId: row.workspace_id!, accountId: row.account_id!, projectId: row.project_id,
    sourceRelativePath: row.source_relative_path!, sourceHash: row.source_hash!,     generationMode: row.generation_mode === "source" ? "source" : "rewrite", title: row.title!, markdown: row.markdown!,
    author: row.author ?? "", digest: row.digest ?? "", coverSource: row.cover_source ?? "",
    status: row.status as CsdnChannelDraftStatus, createdAt: row.created_at!, updatedAt: row.updated_at!
  };
}

function mapJob(row: Record<string, string | null>): CsdnPublishJob {
  return {
    id: row.id!, workspaceId: row.workspace_id!, accountId: row.account_id!, channelDraftId: row.channel_draft_id!,
    renderedPackageHash: row.rendered_package_hash!, idempotencyKey: row.idempotency_key!,
    status: row.status as CsdnPublishJobStatus, remoteUrl: row.remote_url, remoteContentId: row.remote_content_id,
    statusNote: row.status_note, errorMessage: row.error_message, createdAt: row.created_at!, updatedAt: row.updated_at!
  };
}

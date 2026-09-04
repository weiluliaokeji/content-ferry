/**
 * Juejin (掘金) channel service — two-stage publish via content_api.
 *
 * Stage 1: createDraft → article_draft/create (draft_creating → draft_created)
 * Stage 2: publish → article/publish (confirming → published)
 *
 * Images use ImageX upload strategy: local asset images are uploaded to Juejin's
 * image CDN and replaced with CDN URLs; remote http(s) images stay as external
 * links; upload failures fall back to base64 data URI inlining. The credentials
 * are cookie + aid + uuid, stored via CredentialVault.
 */
import { createHash, randomUUID } from "node:crypto";
import { renderMermaidBlocks } from "../publishing/mermaid-markdown";
import type Database from "better-sqlite3";
import type { AccountRepository, MediaAccount } from "../accounts/account-repository";
import type { CredentialVault } from "../security/credential-vault";
import type { ContentSourceService } from "../content/content-source-service";
import type { LocalAssetStore } from "../content/local-asset-store";
import type { ModelProvider } from "../ai/model-provider";
import type { PublishCapabilities } from "../publishing/platform-publisher-connector";
import { appendArticleSignature } from "../publishing/article-signature";
import { JuejinApiError, JuejinClient, type JuejinDraftPayload } from "./juejin-client";
import { inlineJuejinLocalImages } from "./juejin-image-inliner";
import { JuejinImageUploader } from "./juejin-image-uploader";
import { JUEJIN_CATEGORIES, JUEJIN_MAX_TAGS, inferJuejinCategory, inferJuejinTags } from "../../shared/juejin-tags";

const juejinDraftSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    markdown: { type: "string" }
  },
  required: ["title", "markdown"],
  additionalProperties: false
} as const;

export class JuejinChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JuejinChannelError";
  }
}

/** 配置类错误（凭据缺失/无效），由调用方转为 needs_credentials 状态。 */
class JuejinCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JuejinCredentialsError";
  }
}

/** 掘金正文（markContent）最大字符数，与 saveDraft 本地校验保持一致。 */
export const JUJIN_MAX_MARK_CONTENT_CHARS = 100_000;

export type JuejinChannelDraftStatus = "draft" | "approved" | "superseded";
export type JuejinChannelDraftGenerationMode = "rewrite" | "source";
export type JuejinPublishJobStatus =
  | "draft_creating"
  | "draft_created"
  | "confirming"
  | "published"
  | "failed"
  | "needs_manual_reconciliation"
  | "cancelled"
  | "needs_credentials";

export interface JuejinChannelDraft {
  id: string;
  workspaceId: string;
  accountId: string;
  projectId: string | null;
  sourceRelativePath: string;
  sourceHash: string;
  generationMode: JuejinChannelDraftGenerationMode;
  title: string;
  markdown: string;
  author: string;
  digest: string;
  coverSource: string;
  /** 创建稿时由 AI 推荐的掘金分类 id（官方分类），缺省时为空串。 */
  suggestedCategoryId: string;
  /** 创建稿时由 AI 推荐的掘金标签 id 列表（官方 tag_id），缺省时为空数组。 */
  suggestedTagIds: string[];
  status: JuejinChannelDraftStatus;
  createdAt: string;
  updatedAt: string;
}

export interface JuejinPublishJob {
  id: string;
  workspaceId: string;
  accountId: string;
  channelDraftId: string;
  renderedPackageHash: string;
  idempotencyKey: string;
  status: JuejinPublishJobStatus;
  remoteUrl: string | null;
  remoteContentId: string | null;
  statusNote: string | null;
  errorMessage: string | null;
  statusSource: "system" | "manual";
  createdAt: string;
  updatedAt: string;
}

type FetchLike = typeof fetch;

export class JuejinChannelService {
  /** 缓存分类 ID 和 tag IDs 以避免重复 lookup。 */
  private readonly publishOptionsCache = new Map<string, { categoryId: string; tagIds: string[] }>();
  /** 草稿创建并发去重。 */
  private readonly createRemoteDraftPromises = new Map<string, Promise<JuejinPublishJob>>();

  constructor(
    private readonly db: Database.Database,
    private readonly accounts: AccountRepository,
    private readonly vault: CredentialVault,
    private readonly contentSources: ContentSourceService,
    private readonly modelProvider: ModelProvider,
    private readonly assetStore?: LocalAssetStore,
    private readonly fetcher: FetchLike = fetch
  ) {}

  /** 掘金走纯 API 直发，不需要浏览器辅助。 */
  capabilities(_accountId: string): PublishCapabilities {
    return {
      canCreateRemoteDraft: true,
      canSubmitAfterConfirmation: true,
      canReadRemoteReceipt: true,
      supportsExternalLink: "allowed",
      supportsScheduledPublish: false
    };
  }

  /**
   * 查询掘金官方标签选项，供发布草稿前强制选择标签使用
   * （掘金 article_draft/create 要求至少 1 个标签，且标签须为官方 tag_id）。
   *
   * limit 与 recommendPublishOptions 保持一致（200）：AI 推荐时从 200 候选池选 3 个 tagId，
   * 前端展示若只拉 60 个热门标签，会让 AI 选中的非热门 tagId 出现“选中但不可见”的死锁——
   * 计入 3/3 但 UI 渲染不出对应按钮，用户既看不到也无法取消。
   */
  async listTags(accountId: string): Promise<Array<{ id: string; name: string }>> {
    const account = this.accounts.requireAccount(accountId);
    if (account.platform !== "juejin") throw new JuejinChannelError("请选择一个掘金账号。");
    const { client } = this.buildClient(account);
    return client.listTags("", 200);
  }

  /**
   * 根据标题+正文，从掘金官方分类与标签中由 AI 推荐最相关的分类与最多 JUEJIN_MAX_TAGS 个标签。
   * 推荐结果以官方 id 为硬约束：AI 返回的 categoryId/tagIds 必须落在官方清单内，
   * 否则剔除或回退到确定性推断。模型不可用/超时/校验失败时，回退到 inferJuejin*，
   * 保证创建掘金稿时总能拿到（即便不完美）的分类与标签建议。
   */
  async recommendPublishOptions(accountId: string, input: { title: string; markdown: string }): Promise<{ categoryId: string; tagIds: string[] }> {
    const account = this.accounts.requireAccount(accountId);
    if (account.platform !== "juejin") throw new JuejinChannelError("请选择一个掘金账号。");

    // 拉取官方标签候选池（较 UI 下拉更大，给 AI 更多选择）。
    let tags: Array<{ id: string; name: string }> = [];
    try {
      const { client } = this.buildClient(account);
      tags = await client.listTags("", 200);
    } catch {
      tags = [];
    }
    const deterministicCategory = inferJuejinCategory(input.title, input.markdown);

    // 拿不到官方标签清单时无法约束 AI 选型，直接退回确定性分类 + 空标签（UI 会自行推断）。
    if (tags.length === 0) {
      return { categoryId: deterministicCategory, tagIds: [] };
    }

    try {
      const generated = await this.modelProvider.generateStructured({
        task: "summary",
        prompt: buildJuejinTagSuggestionPrompt({
          title: input.title,
          markdown: input.markdown,
          categories: JUEJIN_CATEGORIES,
          tags
        }),
        outputSchema: juejinTagSuggestionSchema,
        timeoutMs: 60_000,
        parse: (value) => parseJuejinTagSuggestion(value)
      });
      const allowedTagIds = new Set(tags.map((tag) => tag.id));
      const categoryId = JUEJIN_CATEGORIES.some((category) => category.id === generated.value.categoryId)
        ? generated.value.categoryId
        : deterministicCategory;
      const tagIds = generated.value.tagIds.filter((id) => allowedTagIds.has(id)).slice(0, JUEJIN_MAX_TAGS);
      return {
        categoryId,
        tagIds: tagIds.length > 0 ? tagIds : inferJuejinTags(input.title, input.markdown, tags)
      };
    } catch {
      return {
        categoryId: deterministicCategory,
        tagIds: inferJuejinTags(input.title, input.markdown, tags)
      };
    }
  }

  async createFromSource(input: {
    accountId: string;
    relativePath: string;
    projectId?: string;
    generationMode?: JuejinChannelDraftGenerationMode;
  }): Promise<JuejinChannelDraft> {
    const account = this.accounts.requireAccount(input.accountId);
    if (account.platform !== "juejin") throw new JuejinChannelError("请选择一个掘金账号创建渠道稿。");
    const article = this.contentSources.getArticle(account.workspaceId, input.relativePath);
    const sourceHash = digest(article.markdown);
    const generationMode = input.generationMode ?? "source";
    const sourceSettings = this.db.prepare("SELECT author, digest, cover_source FROM article_settings WHERE context_key = ?")
      .get(`source:${article.relativePath}`) as { author: string | null; digest: string | null; cover_source: string | null } | undefined;
    const existing = this.db.prepare(`SELECT * FROM channel_drafts
      WHERE account_id = ? AND source_relative_path = ? AND source_hash = ? AND generation_mode = ? AND status IN ('draft', 'approved')
      ORDER BY updated_at DESC LIMIT 1`).get(account.id, article.relativePath, sourceHash, generationMode) as Record<string, string | null> | undefined;
    if (existing) {
      if (existing.status === "draft" && (!existing.author || !existing.digest || !existing.cover_source)) {
        const author = existing.author || sourceSettings?.author || "";
        const sourceDigest = (existing.digest || sourceSettings?.digest || "").slice(0, 200);
        const coverSource = existing.cover_source || sourceSettings?.cover_source || "";
        if (author !== existing.author || sourceDigest !== existing.digest || coverSource !== existing.cover_source) {
          this.db.prepare("UPDATE channel_drafts SET author = ?, digest = ?, cover_source = ?, updated_at = ? WHERE id = ?")
            .run(author, sourceDigest, coverSource, new Date().toISOString(), existing.id);
        }
      }
      return this.requireDraft(existing.id!);
    }

    const title = (article.title ?? firstHeading(article.markdown) ?? "未命名文章").slice(0, 80);
    const generatedDraft = generationMode === "rewrite"
      ? (await this.modelProvider.generateStructured({
          task: "revision",
          skillId: "platform-rewrite",
          prompt: buildJuejinRewritePrompt({
            title,
            markdown: article.markdown,
            positioning: account.profile.positioning,
            audience: account.profile.targetAudience,
            writingStyle: account.profile.writingStyle,
            prohibitedTopics: account.profile.prohibitedTopics
          }),
          outputSchema: juejinDraftSchema,
          timeoutMs: 240_000,
          parse: (value) => parseGeneratedDraft(value)
        })).value
      : { title, markdown: article.markdown };
    const markdown = appendArticleSignature(normalizeMarkdown(generatedDraft.markdown, generatedDraft.title), account.profile.articleSignature);
    assertNoJuejinPromotion(markdown);
    const author = sourceSettings?.author ?? "";
    const sourceDigest = sourceSettings?.digest ?? "";
    const coverSource = sourceSettings?.cover_source ?? "";
    // 创建稿时由 AI 根据正文推荐掘金分类与标签（模型不可用时回退确定性推断）。
    const recommendation = await this.recommendPublishOptions(account.id, { title, markdown });
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE channel_drafts SET status = 'superseded', updated_at = ?
        WHERE account_id = ? AND source_relative_path = ? AND status IN ('draft', 'approved')`).run(now, account.id, article.relativePath);
      this.db.prepare(`INSERT INTO channel_drafts
        (id, workspace_id, account_id, project_id, source_relative_path, source_hash, generation_mode, title, markdown, author, digest, cover_source, suggested_category_id, suggested_tag_ids, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
        .run(id, account.workspaceId, account.id, input.projectId ?? null, article.relativePath, sourceHash, generationMode,
          generatedDraft.title.trim().slice(0, 80), markdown, author, sourceDigest.slice(0, 200), coverSource,
          recommendation.categoryId, JSON.stringify(recommendation.tagIds), now, now);
    })();
    return this.requireDraft(id);
  }

  deleteDraftsBySource(workspaceId: string, relativePath: string, assetStore?: LocalAssetStore): number {
    const rows = this.db.prepare("SELECT id FROM channel_drafts WHERE workspace_id = ? AND source_relative_path = ?")
      .all(workspaceId, relativePath) as Array<{ id: string }>;
    for (const { id } of rows) {
      if (!assetStore) continue;
      try { assetStore.deleteContext(id); } catch { /* ignore */ }
    }
    if (rows.length === 0) return 0;
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM juejin_publish_job_events WHERE job_id IN (SELECT id FROM juejin_publish_jobs WHERE channel_draft_id IN (${placeholders}))`).run(...ids);
      this.db.prepare(`DELETE FROM juejin_publish_jobs WHERE channel_draft_id IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM channel_drafts WHERE id IN (${placeholders})`).run(...ids);
    })();
    return ids.length;
  }

  deleteDraft(id: string): number {
    const row = this.db.prepare("SELECT id FROM channel_drafts WHERE id = ?").get(id) as { id: string } | undefined;
    if (!row) return 0;
    if (this.assetStore) {
      try { this.assetStore.deleteContext(id); } catch { /* ignore */ }
    }
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM juejin_publish_job_events WHERE job_id IN (SELECT id FROM juejin_publish_jobs WHERE channel_draft_id = ?)").run(id);
      this.db.prepare("DELETE FROM juejin_publish_jobs WHERE channel_draft_id = ?").run(id);
      this.db.prepare("DELETE FROM channel_drafts WHERE id = ?").run(id);
    })();
    return 1;
  }

  listDrafts(workspaceId: string, accountId?: string): JuejinChannelDraft[] {
    const rows = accountId
      ? this.db.prepare("SELECT * FROM channel_drafts WHERE workspace_id = ? AND account_id = ? ORDER BY updated_at DESC LIMIT 100").all(workspaceId, accountId)
      : this.db.prepare("SELECT d.* FROM channel_drafts d JOIN media_accounts a ON a.id = d.account_id WHERE d.workspace_id = ? AND a.platform = 'juejin' AND a.deleted_at IS NULL ORDER BY d.updated_at DESC LIMIT 100").all(workspaceId);
    const drafts = (rows as Array<Record<string, string | null>>).map(mapDraft);
    const needBackfill = drafts.filter((d) => d.status === "draft" && (!d.author || !d.digest || !d.coverSource));
    if (needBackfill.length > 0) {
      const keys = needBackfill.map((d) => `source:${d.sourceRelativePath}`);
      const placeholders = keys.map(() => "?").join(",");
      const settings = this.db.prepare(`SELECT context_key, author, digest, cover_source FROM article_settings WHERE context_key IN (${placeholders})`)
        .all(...keys) as Array<{ context_key: string; author: string | null; digest: string | null; cover_source: string | null }>;
      const byKey = new Map(settings.map((s) => [s.context_key, s]));
      for (const d of needBackfill) {
        const setting = byKey.get(`source:${d.sourceRelativePath}`);
        if (!setting) continue;
        d.author = d.author || setting.author || "";
        d.digest = (d.digest || setting.digest || "").slice(0, 200);
        d.coverSource = d.coverSource || setting.cover_source || "";
      }
    }
    return drafts;
  }

  approveDraft(id: string): JuejinChannelDraft {
    const draft = this.requireDraft(id);
    if (draft.status !== "draft") throw new JuejinChannelError("只有待审核的掘金渠道稿可以冻结发布。");
    assertNoJuejinPromotion(draft.markdown);
    this.db.prepare("UPDATE channel_drafts SET status = 'approved', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return this.requireDraft(id);
  }

  saveDraft(id: string, input: { title: string; markdown: string; author?: string; digest?: string; coverSource?: string }): JuejinChannelDraft {
    const draft = this.requireDraft(id);
    if (draft.status !== "draft") throw new JuejinChannelError("已冻结的掘金渠道稿不能直接修改；请基于最新主稿重新生成。");
    const title = input.title.trim();
    if (!title || title.length > 80) throw new JuejinChannelError("掘金渠道稿标题不能为空且不能超过 80 个字符。");
    if (!input.markdown.trim() || input.markdown.length > 100_000) throw new JuejinChannelError("掘金渠道稿正文不能为空且不能超过 100000 个字符。");
    const markdown = normalizeMarkdown(input.markdown, title);
    assertNoJuejinPromotion(markdown);
    const author = (input.author ?? "").slice(0, 16);
    const digestText = (input.digest ?? "").slice(0, 200);
    const coverSource = input.coverSource ?? "";
    this.db.prepare("UPDATE channel_drafts SET title = ?, markdown = ?, author = ?, digest = ?, cover_source = ?, updated_at = ? WHERE id = ?")
      .run(title, markdown, author, digestText, coverSource, new Date().toISOString(), id);
    return this.requireDraft(id);
  }

  /**
   * 创建发布任务（幂等）。任务创建后立即在后台执行两段式第一步：
   * article_draft/create 创建掘金草稿。
   */
  createPublishJob(channelDraftId: string, options?: { categoryId?: string; tagIds?: string[] }): JuejinPublishJob {
    const draft = this.requireDraft(channelDraftId);
    if (draft.status !== "approved") throw new JuejinChannelError("请先审核并冻结掘金渠道稿，再创建发布任务。");
    const renderedPackageHash = digest(`${draft.title}\n${draft.markdown}`);
    let idempotencyKey = `juejin:${draft.accountId}:${draft.id}:${renderedPackageHash}:publish`;
    const found = this.db.prepare("SELECT * FROM juejin_publish_jobs WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, string | null> | undefined;
    if (found) {
      let foundJob = mapJob(found);
      const restartable: JuejinPublishJobStatus[] = [
        "draft_creating", "draft_created", "confirming", "needs_credentials", "failed"
      ];
      if (restartable.includes(foundJob.status)) {
        if (foundJob.status === "failed") {
          foundJob = this.transitionJob(foundJob, "draft_creating", {
            statusNote: "正在重新创建掘金草稿。",
            errorMessage: null
          });
        }
        if (foundJob.status === "draft_creating" || foundJob.status === "needs_credentials") {
          this.publishOptionsCache.set(foundJob.id, { categoryId: options?.categoryId ?? "", tagIds: options?.tagIds ?? [] });
          void this.createRemoteDraft(foundJob.id).catch(() => {});
        }
        return foundJob;
      }
      idempotencyKey = `${idempotencyKey}:retry:${randomUUID()}`;
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO juejin_publish_jobs
        (id, workspace_id, account_id, channel_draft_id, rendered_package_hash, idempotency_key, status, status_note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'draft_creating', ?, ?, ?)`)
        .run(id, draft.workspaceId, draft.accountId, draft.id, renderedPackageHash, idempotencyKey,
          "已创建掘金发布任务，正在创建掘金草稿。", now, now);
      this.db.prepare(`INSERT INTO juejin_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, '', 'draft_creating', 'system', '创建发布任务', ?)`)
        .run(randomUUID(), id, now);
    })();
    this.publishOptionsCache.set(id, { categoryId: options?.categoryId ?? "", tagIds: options?.tagIds ?? [] });
    void this.createRemoteDraft(id).catch(() => {});
    return this.requireJob(id);
  }

  listJobs(workspaceId: string): JuejinPublishJob[] {
    return (this.db.prepare("SELECT * FROM juejin_publish_jobs WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 100")
      .all(workspaceId) as Array<Record<string, string | null>>).map(mapJob);
  }

  getJob(jobId: string): JuejinPublishJob {
    return this.requireJob(jobId);
  }

  getDraftForJob(jobId: string): JuejinChannelDraft {
    const job = this.requireJob(jobId);
    return this.requireDraft(job.channelDraftId);
  }

  /**
   * 用户确认公开：完成两段式第二步 publish。
   * 若草稿尚未创建成功，先补齐草稿；草稿就绪后进入 confirming，调用 article/publish 公开。
   */
  async confirmPublish(jobId: string): Promise<JuejinPublishJob> {
    let job = this.requireJob(jobId);
    if (job.status === "published") throw new JuejinChannelError("该掘金任务已发布，请勿重复提交。");
    if (job.status === "cancelled") throw new JuejinChannelError("该掘金任务已取消，无法确认公开。");
    if (job.status === "needs_manual_reconciliation") throw new JuejinChannelError("该掘金任务已进入人工校正，请先通过校正表单处理。");
    if (job.status === "confirming") throw new JuejinChannelError("该掘金任务正在确认公开，请稍候。");

    if (job.status === "draft_creating" || job.status === "failed" || job.status === "needs_credentials") {
      job = await this.createRemoteDraft(job.id);
      if (job.status !== "draft_created") return job;
    }
    if (job.status !== "draft_created") throw new JuejinChannelError("当前任务状态不允许确认公开。");

    job = this.transitionJob(job, "confirming", {
      statusNote: "正在将掘金草稿公开为正式文章。",
      errorMessage: null
    });
    try {
      return await this.publishRemotePost(job.id);
    } catch (error) {
      const reason = messageOf(error);
      return this.transitionJob(this.requireJob(job.id), "needs_manual_reconciliation", {
        statusNote: `草稿已创建，但公开失败：${reason}`,
        errorMessage: reason
      });
    }
  }

  recordSubmission(jobId: string, input: {
    remoteUrl: string | null;
    remoteContentId: string | null;
    state: "published" | "needs_manual_reconciliation";
    reason?: string;
  }): JuejinPublishJob {
    const job = this.requireJob(jobId);
    if (job.status !== "draft_created" && job.status !== "confirming" && job.status !== "needs_manual_reconciliation") {
      throw new JuejinChannelError("当前任务状态不允许保存发布回执。");
    }
    const reason = (input.reason ?? "").trim().slice(0, 500);
    if (input.state === "published") {
      return this.transitionJob(job, "published", {
        remoteUrl: input.remoteUrl,
        remoteContentId: input.remoteContentId,
        statusNote: input.remoteUrl ? `已发布：${input.remoteUrl}` : "已发布（未填文章链接）。",
        errorMessage: null
      });
    }
    return this.transitionJob(job, "needs_manual_reconciliation", {
      statusNote: reason || "未能核实掘金发布结果，请人工核对。",
      errorMessage: null
    });
  }

  correctStatus(jobId: string, status: "published" | "failed" | "cancelled", reason: string): JuejinPublishJob {
    const job = this.requireJob(jobId);
    const correctable: JuejinPublishJobStatus[] = [
      "draft_creating", "draft_created", "confirming",
      "needs_manual_reconciliation", "failed", "needs_credentials"
    ];
    if (!correctable.includes(job.status)) {
      throw new JuejinChannelError("该掘金发布任务状态不可人工校正。");
    }
    const normalizedReason = reason.trim();
    if (normalizedReason.length > 500) throw new JuejinChannelError("核实依据不能超过 500 个字。");
    const now = new Date().toISOString();
    const note = status === "failed"
      ? `人工确认发布失败：${normalizedReason || "未填写依据"}`
      : status === "cancelled"
        ? `人工确认取消发布：${normalizedReason || "未填写依据"}`
        : null;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE juejin_publish_jobs
        SET status = ?, error_message = ?, status_source = 'manual', status_note = ?, updated_at = ?
        WHERE id = ?`)
        .run(status, status === "failed" ? note : null, note, now, jobId);
      this.db.prepare(`INSERT INTO juejin_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, ?, ?, 'manual', ?, ?)`)
        .run(randomUUID(), jobId, job.status, status, normalizedReason, now);
    })();
    return this.requireJob(jobId);
  }

  /** 两段式第一步：article_draft/create 创建掘金草稿。 */
  private async createRemoteDraft(jobId: string): Promise<JuejinPublishJob> {
    const existing = this.createRemoteDraftPromises.get(jobId);
    if (existing) return existing;
    const promise = this.executeCreateRemoteDraft(jobId);
    this.createRemoteDraftPromises.set(jobId, promise);
    promise.finally(() => this.createRemoteDraftPromises.delete(jobId)).catch(() => {});
    return promise;
  }

  private async executeCreateRemoteDraft(jobId: string): Promise<JuejinPublishJob> {
    let job = this.requireJob(jobId);
    if (job.status === "draft_created" || job.status === "published" || job.status === "needs_manual_reconciliation") return job;

    const account = this.accounts.requireAccount(job.accountId);
    if (account.platform !== "juejin") {
      return this.transitionJob(job, "failed", {
        statusNote: "所选账号不是掘金账号。",
        errorMessage: "所选账号不是掘金账号。"
      });
    }

    let client: JuejinClient;
    let cookie = "";
    try {
      const built = this.buildClient(account);
      client = built.client;
      cookie = built.cookie;
    } catch (error) {
      const reason = messageOf(error);
      return this.transitionJob(job, "needs_credentials", {
        statusNote: reason,
        errorMessage: reason
      });
    }

    try {
      const draft = this.requireDraft(job.channelDraftId);
      const options = this.publishOptionsCache.get(job.id) ?? { categoryId: "", tagIds: [] };

      // 掘金支持 ImageX 图片上传（5 步：gen_token → ApplyImageUpload → 直传 →
      // CommitImageUpload → get_img_url）。本地相对路径图片（如 ./assets/foo.png）
      // 优先上传到掘金图床替换为 CDN URL；上传失败（含超 10MiB、cookie 过期、
      // 接口改版、网络等）不再回退 base64 内联——回退后的文章在掘金文章页不可用，
      // 改为整体发布失败并在 status_note 暴露真实原因。远程 http(s) 图片由掘金
      // 外链渲染。
      const uploader = new JuejinImageUploader({ cookie, fetcher: this.fetcher });
      const mermaidMarkdown = await renderMermaidBlocks(draft.markdown, {
        uploadImage: async (png) => (await uploader.uploadImage(png)).url,
        onError: (source, error) => {
          const reason = error instanceof Error ? error.message : typeof error === "object" && error !== null ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : String(error);
          console.error(`[juejin] mermaid 渲染失败，已保留原始代码块：${reason}\n源码前 120 字：${source.slice(0, 120)}`);
        }
      });
      const inlineResult = await inlineJuejinLocalImages(
        mermaidMarkdown,
        draft.workspaceId,
        draft.sourceRelativePath,
        this.contentSources,
        uploader
      );

      // 上传失败时整体发布失败，不再生成 draft、不再调用掘金发布接口。
      if (inlineResult.failed.length > 0) {
        const failedDetail = inlineResult.failed
          .slice(0, 5)
          .map((f) => `${f.source}（${f.reason.slice(0, 120)}）`)
          .join("、");
        const reason = `本地图片上传掘金图床失败 ${inlineResult.failed.length} 张，文章未发布：${failedDetail}${inlineResult.failed.length > 5 ? "…" : ""}`;
        return this.transitionJob(job, "failed", {
          statusNote: reason,
          errorMessage: reason
        });
      }

      if (inlineResult.uploadedCount > 0) {
        this.db.prepare(`UPDATE juejin_publish_jobs SET status_note = ? WHERE id = ?`)
          .run(`本地图片已上传 ${inlineResult.uploadedCount} 张`, job.id);
      }

      // 构建摘要：取 digest 字段，若为空则用 markdown 前 100 个字符
      const briefContent = (draft.digest || draft.markdown.replace(/#{1,6}\s+.*\n?/g, "").replace(/[#*`\n]/g, " ").trim().slice(0, 100)).slice(0, 100);

      // 兜底：本地图片全部上传成功后正文仍超过掘金最大字数限制时，发布失败并给出
      // 明确提示，避免请求打到掘金被服务端拒绝（只留下不可见错误）。
      if (inlineResult.markdown.length > JUJIN_MAX_MARK_CONTENT_CHARS) {
        const reason = `正文经本地图片处理后为 ${inlineResult.markdown.length} 字符，超过掘金最大字数限制（${JUJIN_MAX_MARK_CONTENT_CHARS}）。请删除过大的本地图片，或将文章拆分后重新生成渠道稿再发布。`;
        return this.transitionJob(job, "failed", {
          statusNote: reason,
          errorMessage: reason
        });
      }

      // 掘金 title 字段已单独提交文章标题，正文首行的 "# {title}"（本地预览
      // 需要）会在页内再渲染一次大标题，形成双标题，发布时剥离开头标题。
      const markContent = stripLeadingTitleHeading(inlineResult.markdown);

      const payload: JuejinDraftPayload = {
        title: draft.title.slice(0, 80),
        markContent,
        briefContent,
        categoryId: options.categoryId || "6809637769959178254", // 默认"后端"分类
        tagIds: options.tagIds.slice(0, JUEJIN_MAX_TAGS),
        coverImage: draft.coverSource || "",
        editType: 10
      };

      const result = await client.createDraft(payload);
      // 草稿阶段展示掘金草稿编辑页（draftUrl），不要用 /post/{article_id}
      // （该页只有公开后才存在，草稿阶段打开会 404/空白）。
      const postUrl = result.draftUrl || result.linkUrl || `https://juejin.cn/editor/drafts?id=${result.draftId}`;
      return this.transitionJob(job, "draft_created", {
        remoteContentId: result.draftId,
        remoteUrl: postUrl,
        statusNote: "掘金草稿已创建，请检查后点击「确认公开」。",
        errorMessage: null
      });
    } catch (error) {
      const reason = messageOf(error);
      if (error instanceof JuejinCredentialsError) {
        return this.transitionJob(job, "needs_credentials", {
          statusNote: `掘金凭据校验失败：${reason}`,
          errorMessage: reason
        });
      }
      return this.transitionJob(job, "failed", {
        statusNote: `创建掘金草稿失败：${reason}`,
        errorMessage: reason
      });
    }
  }

  /** 两段式第二步：article/publish 公开草稿。 */
  private async publishRemotePost(jobId: string): Promise<JuejinPublishJob> {
    const job = this.requireJob(jobId);
    const account = this.accounts.requireAccount(job.accountId);
    const { client } = this.buildClient(account);
    const draftId = job.remoteContentId;
    if (!draftId) throw new JuejinChannelError("缺少掘金草稿的 draft id，无法公开。");
    const result = await client.publish(draftId);
    const articleId = result.articleId;
    const linkUrl = articleId ? `https://juejin.cn/post/${articleId}` : null;
    return this.transitionJob(job, "published", {
      remoteUrl: linkUrl,
      remoteContentId: draftId,
      statusNote: linkUrl ? `已发布：${linkUrl}` : "掘金文章已发布。",
      errorMessage: null
    });
  }

  /** 读取并解密掘金凭据（cookie + aid + uuid）。 */
  private loadCredentials(account: MediaAccount): { cookie: string; aid: string; uuid: string } {
    let cookie = "";
    let aid = "";
    let uuid = "";
    try {
      cookie = this.accounts.getCredential(account.id, "juejin_cookie", this.vault).trim();
      aid = this.accounts.getCredential(account.id, "juejin_aid", this.vault).trim();
      uuid = this.accounts.getCredential(account.id, "juejin_uuid", this.vault).trim();
    } catch {
      throw new JuejinCredentialsError("掘金账号尚未配置 Cookie、AID 或 UUID，请先到账号页完成配置。");
    }
    if (!cookie || !aid) {
      throw new JuejinCredentialsError("掘金账号尚未配置 Cookie 或 AID，请先到账号页完成配置。");
    }
    return { cookie, aid, uuid };
  }

  private buildClient(account: MediaAccount): { client: JuejinClient; cookie: string } {
    const { cookie, aid, uuid } = this.loadCredentials(account);
    return { client: new JuejinClient(cookie, aid, uuid, this.fetcher), cookie };
  }

  private transitionJob(
    job: JuejinPublishJob,
    nextStatus: JuejinPublishJobStatus,
    patch: { statusNote?: string | null; errorMessage?: string | null; remoteUrl?: string | null; remoteContentId?: string | null }
  ): JuejinPublishJob {
    const now = new Date().toISOString();
    const statusNote = patch.statusNote !== undefined ? patch.statusNote : job.statusNote;
    const errorMessage = patch.errorMessage !== undefined ? patch.errorMessage : job.errorMessage;
    const remoteUrl = patch.remoteUrl !== undefined ? patch.remoteUrl : job.remoteUrl;
    const remoteContentId = patch.remoteContentId !== undefined ? patch.remoteContentId : job.remoteContentId;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE juejin_publish_jobs
        SET status = ?, status_note = ?, error_message = ?, remote_url = ?, remote_content_id = ?, updated_at = ?
        WHERE id = ?`)
        .run(nextStatus, statusNote, errorMessage, remoteUrl, remoteContentId, now, job.id);
      this.db.prepare(`INSERT INTO juejin_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, ?, ?, 'system', ?, ?)`)
        .run(randomUUID(), job.id, job.status, nextStatus, patch.statusNote ?? "", now);
    })();
    return this.requireJob(job.id);
  }

  private requireDraft(id: string): JuejinChannelDraft {
    const row = this.db.prepare("SELECT * FROM channel_drafts WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!row) throw new JuejinChannelError("找不到对应的掘金渠道稿。");
    return mapDraft(row);
  }

  private requireJob(id: string): JuejinPublishJob {
    const row = this.db.prepare("SELECT * FROM juejin_publish_jobs WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!row) throw new JuejinChannelError("找不到对应的掘金发布任务。");
    return mapJob(row);
  }
}

function parseGeneratedDraft(value: unknown): { title: string; markdown: string } {
  if (!value || typeof value !== "object") throw new JuejinChannelError("模型没有返回可用的掘金渠道稿。");
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const markdown = typeof record.markdown === "string" ? record.markdown.trim() : "";
  if (!title || title.length > 80 || !markdown || markdown.length > 100_000) {
    throw new JuejinChannelError("模型返回的掘金渠道稿不完整，请重新生成。");
  }
  return { title, markdown };
}

function normalizeMarkdown(markdown: string, title: string): string {
  const withoutFrontMatter = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
  const withoutLeadingTitle = withoutFrontMatter.replace(/^#\s+.+\n+/, "").trim();
  return `# ${title}\n\n${withoutLeadingTitle}`;
}

/** 剥离开头的一级标题行（如发布时避免与文章标题重复渲染）。 */
function stripLeadingTitleHeading(markdown: string): string {
  return markdown.replace(/^#\s+.+\n+/, "").trim();
}

function assertNoJuejinPromotion(markdown: string): void {
  const forbidden = [
    /https?:\/\/mp\.weixin\.qq\.com\//i,
    /公众号原文/,
    /延伸阅读/,
    /关注(?:我的|本)?公众号/,
    /扫描(?:下方|文末)?二维码/
  ];
  if (forbidden.some((pattern) => pattern.test(markdown))) {
    throw new JuejinChannelError("生成的掘金渠道稿包含被禁用的公众号引流内容，请重新生成。");
  }
}

function buildJuejinRewritePrompt(input: {
  title: string;
  markdown: string;
  positioning: string;
  audience: string;
  writingStyle: string;
  prohibitedTopics: string;
}): string {
  return `你是专业的技术内容编辑。请把下面主稿改写成一篇适合掘金技术读者独立阅读的中文文章。

硬性要求：
- 文章必须是独立内容，允许大幅调整标题、结构、段落顺序和表达，但不能编造事实、数据、经历、引用或来源。
- 保留可验证的代码、命令、链接与事实；对不确定信息保持原文的限定，而不是补造结论。
- 彻底去除公众号软引流：不得出现微信公众号原文链接、公众号引导、正文引用链接、文末延伸阅读、二维码、评论区引流或"关注公众号"等措辞。
- 标题不超过 80 个字符，摘要不超过 100 个字符。
- 用自然、具体、面向开发者的表达，避免模板化 AI 腔和空泛总结。
- 输出 JSON：title 为不超过 80 字的标题；markdown 为完整 Markdown 正文。markdown 的第一行必须是 "# {title}"。

账号定位：${input.positioning || "未设置"}
目标读者：${input.audience || "掘金技术读者"}
写作风格：${input.writingStyle || "清晰、具体、自然"}
禁用话题/表达：${input.prohibitedTopics || "无"}

主稿标题：${input.title}

主稿正文：
${input.markdown}`;
}

const juejinTagSuggestionSchema = {
  type: "object",
  properties: {
    categoryId: { type: "string" },
    tagIds: { type: "array", items: { type: "string" }, maxItems: JUEJIN_MAX_TAGS }
  },
  required: ["categoryId", "tagIds"],
  additionalProperties: false
} as const;

function parseJuejinTagSuggestion(value: unknown): { categoryId: string; tagIds: string[] } {
  if (!value || typeof value !== "object") throw new JuejinChannelError("模型没有返回可用的掘金标签建议。");
  const record = value as Record<string, unknown>;
  const categoryId = typeof record.categoryId === "string" ? record.categoryId : "";
  const tagIds = Array.isArray(record.tagIds) ? record.tagIds.filter((id) => typeof id === "string") : [];
  return { categoryId, tagIds: tagIds.slice(0, JUEJIN_MAX_TAGS) };
}

function buildJuejinTagSuggestionPrompt(input: {
  title: string;
  markdown: string;
  categories: Array<{ label: string; id: string }>;
  tags: Array<{ id: string; name: string }>;
}): string {
  const categoryLines = input.categories.map((category) => `- ${category.label} (id: ${category.id})`).join("\n");
  const tagLines = input.tags.map((tag) => `- ${tag.name} (id: ${tag.id})`).join("\n");
  // 标签取决于主题，标题+开头已足够；截断正文以控制 token 成本。
  const body = input.markdown.length > 4000
    ? `${input.markdown.slice(0, 4000)}\n…（正文已截断）`
    : input.markdown;
  return `你是掘金（技术社区）的标签推荐助手。请基于下面这篇文章，从给定的官方分类与官方标签中，挑选出最贴合文章主题的分类与标签。

硬性要求：
- categoryId 必须从下面的“可选分类”列表里选一个，且只能填其 id。
- tagIds 必须从下面的“可选标签”列表里挑选，最多 ${JUEJIN_MAX_TAGS} 个（掘金接口硬性上限，超过会被拒绝），且只能填列表中的 id；不要编造任何不在列表里的 id。
- 只根据文章真实主题选型，不要选泛化、无关或仅因某个词偶然出现而命中的标签。
- 至少要选 1 个、最多 ${JUEJIN_MAX_TAGS} 个真正相关的标签；如果文章主题很专一，2~3 个精准标签优于勉强凑满 ${JUEJIN_MAX_TAGS} 个松散标签。
- 只输出 JSON：{ "categoryId": "<分类id>", "tagIds": ["<标签id>", ...] }。

可选分类：
${categoryLines}

可选标签：
${tagLines}

文章标题：${input.title}

文章正文：
${body}`;
}

function firstHeading(markdown: string): string | null {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mapDraft(row: Record<string, string | null>): JuejinChannelDraft {
  let suggestedTagIds: string[] = [];
  try {
    const raw = row.suggested_tag_ids;
    if (typeof raw === "string" && raw.trim()) suggestedTagIds = JSON.parse(raw);
  } catch { /* 非法 JSON 时回退为空数组 */ }
  if (!Array.isArray(suggestedTagIds)) suggestedTagIds = [];
  // 归一化：只保留字符串 id，并截断到平台上限。
  // 历史草稿可能存有超过上限的推荐标签（接口会拒绝），读回时一并收敛。
  suggestedTagIds = suggestedTagIds.filter((id): id is string => typeof id === "string").slice(0, JUEJIN_MAX_TAGS);
  return {
    id: row.id!, workspaceId: row.workspace_id!, accountId: row.account_id!, projectId: row.project_id,
    sourceRelativePath: row.source_relative_path!, sourceHash: row.source_hash!,
    generationMode: row.generation_mode === "source" ? "source" : "rewrite", title: row.title!, markdown: row.markdown!,
    author: row.author ?? "", digest: row.digest ?? "", coverSource: row.cover_source ?? "",
    suggestedCategoryId: row.suggested_category_id ?? "", suggestedTagIds,
    status: row.status as JuejinChannelDraftStatus, createdAt: row.created_at!, updatedAt: row.updated_at!
  };
}

function mapJob(row: Record<string, string | null>): JuejinPublishJob {
  return {
    id: row.id!, workspaceId: row.workspace_id!, accountId: row.account_id!, channelDraftId: row.channel_draft_id!,
    renderedPackageHash: row.rendered_package_hash!, idempotencyKey: row.idempotency_key!,
    status: row.status as JuejinPublishJobStatus, remoteUrl: row.remote_url, remoteContentId: row.remote_content_id,
    statusNote: row.status_note, errorMessage: row.error_message,
    statusSource: row.status_source === "manual" ? "manual" : "system",
    createdAt: row.created_at!, updatedAt: row.updated_at!
  };
}

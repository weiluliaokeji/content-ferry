import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AccountRepository, MediaAccount } from "../accounts/account-repository";
import type { CredentialVault } from "../security/credential-vault";
import type { ContentSourceService } from "../content/content-source-service";
import type { LocalAssetStore } from "../content/local-asset-store";
import type { ModelProvider } from "../ai/model-provider";
import type { PublishCapabilities } from "../publishing/platform-publisher-connector";
import { appendArticleSignature } from "../publishing/article-signature";
import { CnblogsApiError, CnblogsClient, type CnblogsBlogInfo, type CnblogsPostPayload } from "./cnblogs-client";
import { uploadCnblogsImages } from "./cnblogs-image-uploader";

const cnblogsDraftSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    markdown: { type: "string" }
  },
  required: ["title", "markdown"],
  additionalProperties: false
} as const;

export class CnblogsChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CnblogsChannelError";
  }
}

/** 配置类错误（凭据缺失/无效、博客名缺失或匹配失败），由调用方转为 needs_credentials 状态。 */
class CnblogsCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CnblogsCredentialsError";
  }
}

export type CnblogsChannelDraftStatus = "draft" | "approved" | "superseded";
export type CnblogsChannelDraftGenerationMode = "rewrite" | "source";
export type CnblogsPublishJobStatus =
  | "draft_creating"
  | "draft_created"
  | "confirming"
  | "published"
  | "failed"
  | "needs_manual_reconciliation"
  | "cancelled"
  | "needs_credentials";

export interface CnblogsChannelDraft {
  id: string;
  workspaceId: string;
  accountId: string;
  projectId: string | null;
  sourceRelativePath: string;
  sourceHash: string;
  generationMode: CnblogsChannelDraftGenerationMode;
  title: string;
  markdown: string;
  author: string;
  digest: string;
  coverSource: string;
  status: CnblogsChannelDraftStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CnblogsPublishJob {
  id: string;
  workspaceId: string;
  accountId: string;
  channelDraftId: string;
  renderedPackageHash: string;
  idempotencyKey: string;
  status: CnblogsPublishJobStatus;
  remoteUrl: string | null;
  remoteContentId: string | null;
  statusNote: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CnblogsPublishOptions {
  /** 追加到 [Markdown] 之后的博客园分类，默认空。 */
  categories?: string[];
  /** 文章标签，经逗号拼接写入 mt_keywords。 */
  tags?: string[];
}

type FetchLike = typeof fetch;

export class CnblogsChannelService {
  /** 两段式发布的关键缓存：draft_created 阶段构建的完整 post 对象，公开阶段必须原样复用来避免 editPost 完全替换陷阱。 */
  private readonly payloadCache = new Map<string, CnblogsPostPayload>();
  private readonly publishOptionsCache = new Map<string, CnblogsPublishOptions>();
  /** 草稿创建并发去重：同一 job 的 createRemoteDraft 只允许一个 in-flight，重复触发复用同一 Promise，避免多次点击重试造成重复 newPost。 */
  private readonly createRemoteDraftPromises = new Map<string, Promise<CnblogsPublishJob>>();

  constructor(
    private readonly db: Database.Database,
    private readonly accounts: AccountRepository,
    private readonly vault: CredentialVault,
    private readonly contentSources: ContentSourceService,
    private readonly modelProvider: ModelProvider,
    private readonly assetStore?: LocalAssetStore,
    private readonly fetcher: FetchLike = fetch
  ) {}

  capabilities(_accountId: string): PublishCapabilities {
    // 博客园走官方 MetaWeblog XML-RPC 纯 API 直发：草稿创建与最终公开都由主进程完成，
    // 不需要浏览器辅助；正文支持外链，本期不做定时发布。
    return {
      canCreateRemoteDraft: true,
      canSubmitAfterConfirmation: true,
      canReadRemoteReceipt: true,
      supportsExternalLink: "allowed",
      supportsScheduledPublish: false
    };
  }

  async createFromSource(input: {
    accountId: string;
    relativePath: string;
    projectId?: string;
    generationMode?: CnblogsChannelDraftGenerationMode;
  }): Promise<CnblogsChannelDraft> {
    const account = this.accounts.requireAccount(input.accountId);
    if (account.platform !== "cnblogs") throw new CnblogsChannelError("请选择一个博客园账号创建渠道稿。");
    const article = this.contentSources.getArticle(account.workspaceId, input.relativePath);
    const sourceHash = digest(article.markdown);
    const generationMode = input.generationMode ?? "rewrite";
    const sourceSettings = this.db.prepare("SELECT author, digest, cover_source FROM article_settings WHERE context_key = ?")
      .get(`source:${article.relativePath}`) as { author: string | null; digest: string | null; cover_source: string | null } | undefined;
    const existing = this.db.prepare(`SELECT * FROM channel_drafts
      WHERE account_id = ? AND source_relative_path = ? AND source_hash = ? AND generation_mode = ? AND status IN ('draft', 'approved')
      ORDER BY updated_at DESC LIMIT 1`).get(account.id, article.relativePath, sourceHash, generationMode) as Record<string, string | null> | undefined;
    if (existing) {
      // 与 CSDN 一致：草稿态且继承字段为空时从最新原文设置回填；已冻结快照不改动。
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

    const title = (article.title ?? firstHeading(article.markdown) ?? "未命名文章").slice(0, 120);
    const generatedDraft = generationMode === "rewrite"
      ? (await this.modelProvider.generateStructured({
          task: "revision",
          skillId: "platform-rewrite",
          prompt: buildCnblogsRewritePrompt({
            title,
            markdown: article.markdown,
            positioning: account.profile.positioning,
            audience: account.profile.targetAudience,
            writingStyle: account.profile.writingStyle,
            prohibitedTopics: account.profile.prohibitedTopics
          }),
          outputSchema: cnblogsDraftSchema,
          timeoutMs: 240_000,
          parse: (value) => parseGeneratedDraft(value)
        })).value
      : { title, markdown: article.markdown };
    const markdown = appendArticleSignature(normalizeMarkdown(generatedDraft.markdown, generatedDraft.title), account.profile.articleSignature);
    assertNoCnblogsPromotion(markdown);
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
      this.db.prepare(`DELETE FROM cnblogs_publish_job_events WHERE job_id IN (SELECT id FROM cnblogs_publish_jobs WHERE channel_draft_id IN (${placeholders}))`).run(...ids);
      this.db.prepare(`DELETE FROM cnblogs_publish_jobs WHERE channel_draft_id IN (${placeholders})`).run(...ids);
      this.db.prepare(`DELETE FROM channel_drafts WHERE id IN (${placeholders})`).run(...ids);
    })();
    return ids.length;
  }

  deleteDraft(id: string): number {
    const row = this.db.prepare("SELECT id FROM channel_drafts WHERE id = ?").get(id) as { id: string } | undefined;
    if (!row) return 0;
    if (this.assetStore) {
      try { this.assetStore.deleteContext(id); } catch { /* 图片目录可能不存在，忽略 */ }
    }
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM cnblogs_publish_job_events WHERE job_id IN (SELECT id FROM cnblogs_publish_jobs WHERE channel_draft_id = ?)").run(id);
      this.db.prepare("DELETE FROM cnblogs_publish_jobs WHERE channel_draft_id = ?").run(id);
      this.db.prepare("DELETE FROM channel_drafts WHERE id = ?").run(id);
    })();
    return 1;
  }

  listDrafts(workspaceId: string, accountId?: string): CnblogsChannelDraft[] {
    const rows = accountId
      ? this.db.prepare("SELECT * FROM channel_drafts WHERE workspace_id = ? AND account_id = ? ORDER BY updated_at DESC LIMIT 100").all(workspaceId, accountId)
      : this.db.prepare("SELECT d.* FROM channel_drafts d JOIN media_accounts a ON a.id = d.account_id WHERE d.workspace_id = ? AND a.platform = 'cnblogs' AND a.deleted_at IS NULL ORDER BY d.updated_at DESC LIMIT 100").all(workspaceId);
    const drafts = (rows as Array<Record<string, string | null>>).map(mapDraft);
    // 与 CSDN 一致：显示层回填旧草稿缺失的继承字段。
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

  approveDraft(id: string): CnblogsChannelDraft {
    const draft = this.requireDraft(id);
    if (draft.status !== "draft") throw new CnblogsChannelError("只有待审核的博客园渠道稿可以冻结发布。");
    assertNoCnblogsPromotion(draft.markdown);
    this.db.prepare("UPDATE channel_drafts SET status = 'approved', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return this.requireDraft(id);
  }

  saveDraft(id: string, input: { title: string; markdown: string; author?: string; digest?: string; coverSource?: string }): CnblogsChannelDraft {
    const draft = this.requireDraft(id);
    if (draft.status !== "draft") throw new CnblogsChannelError("已冻结的博客园渠道稿不能直接修改；请基于最新主稿重新生成。");
    const title = input.title.trim();
    if (!title || title.length > 120) throw new CnblogsChannelError("博客园渠道稿标题不能为空且不能超过 120 个字符。");
    if (!input.markdown.trim() || input.markdown.length > 100_000) throw new CnblogsChannelError("博客园渠道稿正文不能为空且不能超过 100000 个字符。");
    const markdown = normalizeMarkdown(input.markdown, title);
    assertNoCnblogsPromotion(markdown);
    const author = (input.author ?? "").slice(0, 16);
    const digestText = (input.digest ?? "").slice(0, 200);
    const coverSource = input.coverSource ?? "";
    this.db.prepare("UPDATE channel_drafts SET title = ?, markdown = ?, author = ?, digest = ?, cover_source = ?, updated_at = ? WHERE id = ?")
      .run(title, markdown, author, digestText, coverSource, new Date().toISOString(), id);
    return this.requireDraft(id);
  }

  /**
   * 创建发布任务（幂等）。任务创建后立即在后台执行两段式第一步：
   * newPost(publish=false) 创建博客园草稿。终态任务（published / cancelled /
   * needs_manual_reconciliation）不复用，改用带 retry 后缀的新幂等键重新开始。
   */
  createPublishJob(channelDraftId: string, options?: CnblogsPublishOptions): CnblogsPublishJob {
    const draft = this.requireDraft(channelDraftId);
    if (draft.status !== "approved") throw new CnblogsChannelError("请先审核并冻结博客园渠道稿，再创建发布任务。");
    const renderedPackageHash = digest(`${draft.title}\n${draft.markdown}`);
    let idempotencyKey = `cnblogs:${draft.accountId}:${draft.id}:${renderedPackageHash}:publish`;
    const found = this.db.prepare("SELECT * FROM cnblogs_publish_jobs WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, string | null> | undefined;
    if (found) {
      let foundJob = mapJob(found);
      const restartable: CnblogsPublishJobStatus[] = [
        "draft_creating", "draft_created", "confirming", "needs_credentials", "failed"
      ];
      if (restartable.includes(foundJob.status)) {
        // 上次卡在草稿创建前的可重试态：保存发布选项并重新触发后台草稿创建。
        if (foundJob.status === "failed") {
          // 重试前先落库切回进行中状态：前端轮询 active 列表不含 failed，
          // 若不先转 draft_creating，前端拿到 failed 不会启动轮询，后台异步成功后 UI 仍停留在失败态。
          foundJob = this.transitionJob(foundJob, "draft_creating", {
            statusNote: "正在重新创建博客园草稿。",
            errorMessage: null
          });
        }
        if (foundJob.status === "draft_creating" || foundJob.status === "needs_credentials") {
          this.publishOptionsCache.set(foundJob.id, options ?? {});
          void this.createRemoteDraft(foundJob.id).catch(() => {});
        }
        return foundJob;
      }
      idempotencyKey = `${idempotencyKey}:retry:${randomUUID()}`;
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO cnblogs_publish_jobs
        (id, workspace_id, account_id, channel_draft_id, rendered_package_hash, idempotency_key, status, status_note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'draft_creating', ?, ?, ?)`)
        .run(id, draft.workspaceId, draft.accountId, draft.id, renderedPackageHash, idempotencyKey,
          "已创建博客园发布任务，正在创建博客园草稿。", now, now);
      this.db.prepare(`INSERT INTO cnblogs_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, '', 'draft_creating', 'system', '创建发布任务', ?)`)
        .run(randomUUID(), id, now);
    })();
    this.publishOptionsCache.set(id, options ?? {});
    // 后台创建草稿：所有失败路径都已在 createRemoteDraft 内部落库，这里仅作兜底防未处理拒绝。
    void this.createRemoteDraft(id).catch(() => {});
    return this.requireJob(id);
  }

  listJobs(workspaceId: string): CnblogsPublishJob[] {
    return (this.db.prepare("SELECT * FROM cnblogs_publish_jobs WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 100")
      .all(workspaceId) as Array<Record<string, string | null>>).map(mapJob);
  }

  getJob(jobId: string): CnblogsPublishJob {
    return this.requireJob(jobId);
  }

  getDraftForJob(jobId: string): CnblogsChannelDraft {
    const job = this.requireJob(jobId);
    return this.requireDraft(job.channelDraftId);
  }

  /**
   * 用户确认公开：单次提交完成两段式第二步。
   * 若草稿尚未创建成功（draft_creating / needs_credentials / failed），先补齐草稿；
   * 草稿就绪后进入 confirming，editPost 传完整 post 对象 publish=true 公开。
   * 公开失败（草稿已存在）转入 needs_manual_reconciliation，由人工校正表单处理。
   */
  async confirmPublish(jobId: string): Promise<CnblogsPublishJob> {
    let job = this.requireJob(jobId);
    if (job.status === "published") throw new CnblogsChannelError("该博客园任务已发布，请勿重复提交。");
    if (job.status === "cancelled") throw new CnblogsChannelError("该博客园任务已取消，无法确认公开。");
    if (job.status === "needs_manual_reconciliation") throw new CnblogsChannelError("该博客园任务已进入人工校正，请先通过校正表单处理。");
    if (job.status === "confirming") throw new CnblogsChannelError("该博客园任务正在确认公开，请稍候。");

    if (job.status === "draft_creating" || job.status === "failed" || job.status === "needs_credentials") {
      job = await this.createRemoteDraft(job.id);
      if (job.status !== "draft_created") return job;
    }
    if (job.status !== "draft_created") throw new CnblogsChannelError("当前任务状态不允许确认公开。");

    job = this.transitionJob(job, "confirming", {
      statusNote: "正在将博客园草稿公开为正式文章。",
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

  /**
   * 用户人工保存回执（例如在博客园后台手动公开或核对后回来登记）。
   * state 必须是 published（有文章链接）或 needs_manual_reconciliation（仍无法核实）。
   */
  recordSubmission(jobId: string, input: {
    remoteUrl: string | null;
    remoteContentId: string | null;
    state: "published" | "needs_manual_reconciliation";
    reason?: string;
  }): CnblogsPublishJob {
    const job = this.requireJob(jobId);
    if (job.status !== "draft_created" && job.status !== "confirming" && job.status !== "needs_manual_reconciliation") {
      throw new CnblogsChannelError("当前任务状态不允许保存发布回执。");
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
      statusNote: reason || "未能核实博客园发布结果，请人工核对。",
      errorMessage: null
    });
  }

  /** 用户人工校正发布结果（与微信/CSDN 一致：只改文渡记录，不调用博客园接口）。 */
  correctStatus(jobId: string, status: "published" | "failed" | "cancelled", reason: string): CnblogsPublishJob {
    const job = this.requireJob(jobId);
    const correctable: CnblogsPublishJobStatus[] = [
      "draft_creating", "draft_created", "confirming",
      "needs_manual_reconciliation", "failed", "needs_credentials"
    ];
    if (!correctable.includes(job.status)) {
      throw new CnblogsChannelError("该博客园发布任务状态不可人工校正。");
    }
    const normalizedReason = reason.trim();
    if (normalizedReason.length > 500) throw new CnblogsChannelError("核实依据不能超过 500 个字。");
    const now = new Date().toISOString();
    const note = status === "failed"
      ? `人工确认发布失败：${normalizedReason || "未填写依据"}`
      : status === "cancelled"
        ? `人工确认取消发布：${normalizedReason || "未填写依据"}`
        : null;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE cnblogs_publish_jobs
        SET status = ?, error_message = ?, status_source = 'manual', status_note = ?, updated_at = ?
        WHERE id = ?`)
        .run(status, status === "failed" ? note : null, note, now, jobId);
      this.db.prepare(`INSERT INTO cnblogs_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, ?, ?, 'manual', ?, ?)`)
        .run(randomUUID(), jobId, job.status, status, normalizedReason, now);
    })();
    return this.requireJob(jobId);
  }

  /**
   * 两段式第一步：newPost(publish=false) 创建博客园草稿。
   * 可重试（draft_creating / needs_credentials / failed）场景下可重复调用；
   * 草稿已创建或已终态时直接返回，幂等安全。
   * 并发去重：同一 job 的调用共享一个 Promise，避免连点重试造成重复 newPost。
   */
  private async createRemoteDraft(jobId: string): Promise<CnblogsPublishJob> {
    const existing = this.createRemoteDraftPromises.get(jobId);
    if (existing) return existing;
    const promise = this.executeCreateRemoteDraft(jobId);
    this.createRemoteDraftPromises.set(jobId, promise);
    promise.finally(() => this.createRemoteDraftPromises.delete(jobId)).catch(() => {});
    return promise;
  }

  private async executeCreateRemoteDraft(jobId: string): Promise<CnblogsPublishJob> {
    let job = this.requireJob(jobId);
    if (job.status === "draft_created" || job.status === "published" || job.status === "needs_manual_reconciliation") return job;

    const account = this.accounts.requireAccount(job.accountId);
    if (account.platform !== "cnblogs") {
      return this.transitionJob(job, "failed", {
        statusNote: "所选账号不是博客园账号。",
        errorMessage: "所选账号不是博客园账号。"
      });
    }

    let credentials: { username: string; apiKey: string };
    try {
      credentials = this.loadCredentials(account);
    } catch (error) {
      const reason = messageOf(error);
      return this.transitionJob(job, "needs_credentials", {
        statusNote: reason,
        errorMessage: reason
      });
    }

    try {
      const blog = await this.resolveBlog(account, credentials);
      const payload = await this.buildPostPayload(job, blog, credentials);
      this.payloadCache.set(job.id, payload);
      const client = this.clientFor(blog.blogName);
      const postId = await client.newPost(blog.blogId, credentials.username, credentials.apiKey, payload, false);
      return this.transitionJob(job, "draft_created", {
        remoteContentId: postId,
        remoteUrl: draftEditUrl(postId),
        statusNote: "博客园草稿已创建，请检查后点击“确认公开”。",
        errorMessage: null
      });
    } catch (error) {
      const reason = messageOf(error);
      if (error instanceof CnblogsCredentialsError) {
        return this.transitionJob(job, "needs_credentials", {
          statusNote: `博客园凭据校验失败：${reason}`,
          errorMessage: reason
        });
      }
      // 图片上传失败（failedAssets 明细）、newPost fault、网络异常等一律记为 failed，可重试。
      return this.transitionJob(job, "failed", {
        statusNote: `创建博客园草稿失败：${reason}`,
        errorMessage: reason
      });
    }
  }

  /** 两段式第二步：editPost 传完整 post 对象 publish=true 公开，成功回写 published。 */
  private async publishRemotePost(jobId: string): Promise<CnblogsPublishJob> {
    const job = this.requireJob(jobId);
    const account = this.accounts.requireAccount(job.accountId);
    const credentials = this.loadCredentials(account);
    const blog = await this.resolveBlog(account, credentials);
    const postId = job.remoteContentId;
    if (!postId) throw new CnblogsChannelError("缺少博客园草稿的 post id，无法公开。");
    let payload = this.payloadCache.get(jobId);
    if (!payload) {
      // 进程重启后缓存丢失：重建完整 payload（图片会重新上传，图床 URL 永久有效可复用）。
      payload = await this.buildPostPayload(job, blog, credentials);
      this.payloadCache.set(jobId, payload);
    }
    const client = this.clientFor(blog.blogName);
    const ok = await client.editPost(postId, credentials.username, credentials.apiKey, payload, true);
    if (!ok) throw new CnblogsChannelError("博客园接口未确认公开成功，请稍后重试或人工核对。");
    return this.transitionJob(job, "published", {
      remoteUrl: articleUrl(blog.blogName, postId),
      remoteContentId: postId,
      statusNote: `已发布：${articleUrl(blog.blogName, postId)}`,
      errorMessage: null
    });
  }

  /** 读取并解密博客园凭据（username + api_key），缺失抛配置类错误。 */
  private loadCredentials(account: MediaAccount): { username: string; apiKey: string } {
    let username = "";
    let apiKey = "";
    try {
      username = this.accounts.getCredential(account.id, "username", this.vault).trim();
      apiKey = this.accounts.getCredential(account.id, "api_key", this.vault).trim();
    } catch {
      throw new CnblogsCredentialsError("博客园账号尚未配置用户名或 MetaWeblog API Key，请先到账号页完成配置。");
    }
    if (!username || !apiKey) {
      throw new CnblogsCredentialsError("博客园账号尚未配置用户名或 MetaWeblog API Key，请先到账号页完成配置。");
    }
    return { username, apiKey };
  }

  /** 凭据验证并定位博客：getUsersBlogs 校验失败即凭据无效；返回的博客名回写 external_account_id，用户无需手填。 */
  private async resolveBlog(account: MediaAccount, credentials: { username: string; apiKey: string }): Promise<CnblogsBlogInfo> {
    const configuredName = normalizeBlogName(account.externalAccountId ?? "");
    if (!configuredName) {
      throw new CnblogsCredentialsError("博客园账号缺少博客名，请在账号管理中填写博客地址或博客名。");
    }
    if (/[^\x00-\x7F]/.test(configuredName)) {
      throw new CnblogsCredentialsError(
        "博客园接口只接受博客 URL 路径段（如 weiluliaokeji），当前填的是中文名称。请到账号管理中填写博客地址或博客 URL 路径段，例如 https://www.cnblogs.com/weiluliaokeji/。",
      );
    }
    let blogs: CnblogsBlogInfo[];
    try {
      blogs = await this.clientFor(configuredName).getUsersBlogs("ContentFerry", credentials.username, credentials.apiKey);
    } catch (error) {
      // getUsersBlogs 是凭据验证点：接口 fault / 401 一律视为凭据无效。
      if (error instanceof CnblogsApiError && error.faultCode !== undefined) {
        throw new CnblogsCredentialsError(`用户名或 API Key 无效：${error.message}`);
      }
      throw error;
    }
    const matched = blogs.find((blog) => normalizeBlogName(blog.blogName) === configuredName)
      ?? blogs.find((blog) => extractBlogNameFromUrl(blog.url) === configuredName);
    if (!matched) {
      if (blogs.length === 1) {
        const blogName = extractBlogNameFromUrl(blogs[0].url) || normalizeBlogName(blogs[0].blogName) || configuredName;
        this.persistBlogName(account.id, blogName);
        return { ...blogs[0], blogName };
      }
      throw new CnblogsCredentialsError(`没有找到与博客名“${configuredName}”匹配的博客。`);
    }
    const blogName = extractBlogNameFromUrl(matched.url) || normalizeBlogName(matched.blogName) || configuredName;
    if (blogName !== configuredName) this.persistBlogName(account.id, blogName);
    return { ...matched, blogName };
  }

  /** 构建完整 post 对象：注入 [Markdown] 分类、上传本地图片（封面置文首）、组装标签与摘要。 */
  private async buildPostPayload(
    job: CnblogsPublishJob,
    blog: CnblogsBlogInfo,
    credentials: { username: string; apiKey: string }
  ): Promise<CnblogsPostPayload> {
    const draft = this.requireDraft(job.channelDraftId);
    const sourceSettings = this.db.prepare("SELECT digest, cover_source FROM article_settings WHERE context_key = ?")
      .get(`source:${draft.sourceRelativePath}`) as { digest: string | null; cover_source: string | null } | undefined;
    const coverSource = draft.coverSource || sourceSettings?.cover_source || "";
    const digestText = draft.digest || sourceSettings?.digest || "";
    const options = this.publishOptionsCache.get(job.id);
    const categories = ["[Markdown]", ...(options?.categories ?? [])]
      .map((value) => value.trim())
      .filter((value, index, array) => value && array.indexOf(value) === index);
    const keywords = (options?.tags ?? []).map((tag) => tag.trim()).filter(Boolean).join(",");

    const client = this.clientFor(blog.blogName);
    const uploaded = await uploadCnblogsImages({
      markdown: draft.markdown,
      workspaceId: draft.workspaceId,
      sourceRelativePath: draft.sourceRelativePath,
      contentSources: this.contentSources,
      assetStore: this.assetStore,
      coverSource,
      uploadImage: async (source, buffer, mimeType, fileName) => {
        const result = await client.newMediaObject(blog.blogId, credentials.username, credentials.apiKey, {
          name: fileName,
          type: mimeType,
          bits: buffer
        });
        return result.url;
      }
    });
    if (uploaded.failedAssets.length > 0) {
      const detail = uploaded.failedAssets.map((item) => `${item.source}（${item.reason}）`).join("；");
      throw new CnblogsChannelError(`发布前有 ${uploaded.failedAssets.length} 张图片上传失败：${detail}`);
    }
    return {
      title: draft.title,
      description: uploaded.markdown,
      categories,
      mt_keywords: keywords,
      mt_excerpt: digestText.slice(0, 200),
      mt_allow_comments: 1
    };
  }

  private clientFor(blogName: string): CnblogsClient {
    return new CnblogsClient(`https://rpc.cnblogs.com/metaweblog/${encodeURIComponent(blogName)}`, this.fetcher);
  }

  private persistBlogName(accountId: string, blogName: string): void {
    if (!blogName) return;
    this.db.prepare("UPDATE media_accounts SET external_account_id = ? WHERE id = ? AND deleted_at IS NULL")
      .run(blogName, accountId);
  }

  private transitionJob(
    job: CnblogsPublishJob,
    nextStatus: CnblogsPublishJobStatus,
    patch: { statusNote?: string | null; errorMessage?: string | null; remoteUrl?: string | null; remoteContentId?: string | null }
  ): CnblogsPublishJob {
    const now = new Date().toISOString();
    // 注意：字段未提供(undefined)时保留原值；显式传 null 时必须真正清空（COALESCE 无法区分 null 与未提供，会导致成功路径残留旧错误）。
    const statusNote = patch.statusNote !== undefined ? patch.statusNote : job.statusNote;
    const errorMessage = patch.errorMessage !== undefined ? patch.errorMessage : job.errorMessage;
    const remoteUrl = patch.remoteUrl !== undefined ? patch.remoteUrl : job.remoteUrl;
    const remoteContentId = patch.remoteContentId !== undefined ? patch.remoteContentId : job.remoteContentId;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE cnblogs_publish_jobs
        SET status = ?, status_note = ?, error_message = ?, remote_url = ?, remote_content_id = ?, updated_at = ?
        WHERE id = ?`)
        .run(
          nextStatus,
          statusNote,
          errorMessage,
          remoteUrl,
          remoteContentId,
          now,
          job.id
        );
      this.db.prepare(`INSERT INTO cnblogs_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, ?, ?, 'system', ?, ?)`)
        .run(randomUUID(), job.id, job.status, nextStatus, patch.statusNote ?? "", now);
    })();
    return this.requireJob(job.id);
  }

  private requireDraft(id: string): CnblogsChannelDraft {
    const row = this.db.prepare("SELECT * FROM channel_drafts WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!row) throw new CnblogsChannelError("找不到对应的博客园渠道稿。");
    return mapDraft(row);
  }

  private requireJob(id: string): CnblogsPublishJob {
    const row = this.db.prepare("SELECT * FROM cnblogs_publish_jobs WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!row) throw new CnblogsChannelError("找不到对应的博客园发布任务。");
    return mapJob(row);
  }
}

function parseGeneratedDraft(value: unknown): { title: string; markdown: string } {
  if (!value || typeof value !== "object") throw new CnblogsChannelError("模型没有返回可用的博客园渠道稿。");
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const markdown = typeof record.markdown === "string" ? record.markdown.trim() : "";
  if (!title || title.length > 120 || !markdown || markdown.length > 100_000) {
    throw new CnblogsChannelError("模型返回的博客园渠道稿不完整，请重新生成。");
  }
  return { title, markdown };
}

function normalizeMarkdown(markdown: string, title: string): string {
  const withoutFrontMatter = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
  const withoutLeadingTitle = withoutFrontMatter.replace(/^#\s+.+\n+/, "").trim();
  return `# ${title}\n\n${withoutLeadingTitle}`;
}

/**
 * 软引流拦截：与 CSDN 的 assertNoCsdnPromotion 使用同一套规则（微信公众号引流），
 * 博客园同样不允许在正文中携带公众号导流内容。
 */
function assertNoCnblogsPromotion(markdown: string): void {
  const forbidden = [
    /https?:\/\/mp\.weixin\.qq\.com\//i,
    /公众号原文/,
    /延伸阅读/,
    /关注(?:我的|本)?公众号/,
    /扫描(?:下方|文末)?二维码/
  ];
  if (forbidden.some((pattern) => pattern.test(markdown))) {
    throw new CnblogsChannelError("生成的博客园渠道稿包含被禁用的公众号引流内容，请重新生成。");
  }
}

function buildCnblogsRewritePrompt(input: {
  title: string;
  markdown: string;
  positioning: string;
  audience: string;
  writingStyle: string;
  prohibitedTopics: string;
}): string {
  return `你是专业的技术内容编辑。请把下面主稿改写成一篇适合博客园技术读者独立阅读的中文文章。

硬性要求：
- 文章必须是独立内容，允许大幅调整标题、结构、段落顺序和表达，但不能编造事实、数据、经历、引用或来源。
- 保留可验证的代码、命令、链接与事实；对不确定信息保持原文的限定，而不是补造结论。
- 彻底去除公众号软引流：不得出现微信公众号原文链接、公众号引导、正文引用链接、文末延伸阅读、二维码、评论区引流或“关注公众号”等措辞。
- 用自然、具体、面向开发者的表达，避免模板化 AI 腔和空泛总结。
- 输出 JSON：title 为不超过 120 字的标题；markdown 为完整 Markdown 正文。markdown 的第一行必须是 "# {title}"。

账号定位：${input.positioning || "未设置"}
目标读者：${input.audience || "博客园技术读者"}
写作风格：${input.writingStyle || "清晰、具体、自然"}
禁用话题/表达：${input.prohibitedTopics || "无"}

主稿标题：${input.title}

主稿正文：
${input.markdown}`;
}

function firstHeading(markdown: string): string | null {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? null;
}

/** 把完整博客地址/博客名规整为 endpoint 用的 blogName 末段。 */
function normalizeBlogName(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const match = /cnblogs\.com\/([^/?#]+)/i.exec(trimmed);
  if (match) return match[1];
  return trimmed;
}

function extractBlogNameFromUrl(url: string): string {
  const match = /cnblogs\.com\/([^/?#]+)/i.exec(url);
  return match ? match[1] : "";
}

function articleUrl(blogName: string, postId: string): string {
  return `https://www.cnblogs.com/${blogName}/p/${postId}.html`;
}

function draftEditUrl(postId: string): string {
  return `https://i.cnblogs.com/EditPosts.aspx?postid=${postId}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mapDraft(row: Record<string, string | null>): CnblogsChannelDraft {
  return {
    id: row.id!, workspaceId: row.workspace_id!, accountId: row.account_id!, projectId: row.project_id,
    sourceRelativePath: row.source_relative_path!, sourceHash: row.source_hash!,
    generationMode: row.generation_mode === "source" ? "source" : "rewrite", title: row.title!, markdown: row.markdown!,
    author: row.author ?? "", digest: row.digest ?? "", coverSource: row.cover_source ?? "",
    status: row.status as CnblogsChannelDraftStatus, createdAt: row.created_at!, updatedAt: row.updated_at!
  };
}

function mapJob(row: Record<string, string | null>): CnblogsPublishJob {
  return {
    id: row.id!, workspaceId: row.workspace_id!, accountId: row.account_id!, channelDraftId: row.channel_draft_id!,
    renderedPackageHash: row.rendered_package_hash!, idempotencyKey: row.idempotency_key!,
    status: row.status as CnblogsPublishJobStatus, remoteUrl: row.remote_url, remoteContentId: row.remote_content_id,
    statusNote: row.status_note, errorMessage: row.error_message, createdAt: row.created_at!, updatedAt: row.updated_at!
  };
}

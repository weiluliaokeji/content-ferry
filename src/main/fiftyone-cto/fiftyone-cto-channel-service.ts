/**
 * 51CTO (51CTO) channel service — single-shot publish via the blogger/publish endpoint.
 *
 * Unlike 掘金's two-stage draft, 51CTO has no real draft mode: createPublishJob
 * creates the job and immediately publishes (fetchConfig → markdown→HTML with
 * base64-embedded local images → POST /blogger/publish). The job transitions
 * draft_creating → published | failed | needs_credentials.
 *
 * Images: local relative images are uploaded to 51CTO's Tencent COS image host via the
 * signed-upload protocol: GET /getUploadSign -> GET /getUploadConfig -> POST multipart
 * to the COS URL returned in the config. A single image's upload failure falls back to
 * base64-embedding that image, so publishing never breaks. Remote http(s) images stay as
 * external links.
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
import { CTOClient, mdToHtml51 } from "./fiftyone-cto-client";
import { uploadFiftyoneCtoLocalImages } from "./fiftyone-cto-image-inliner";
import { FiftyoneCtoImageUploader } from "./fiftyone-cto-image-uploader";
import { FiftyoneCtoChannelError, FiftyoneCtoCredentialsError } from "./fiftyone-cto-channel-error";

export { FiftyoneCtoChannelError, FiftyoneCtoCredentialsError } from "./fiftyone-cto-channel-error";

const fiftyoneCtoDraftSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    markdown: { type: "string" }
  },
  required: ["title", "markdown"],
  additionalProperties: false
} as const;

export type FiftyoneCtoChannelDraftStatus = "draft" | "approved" | "superseded";
export type FiftyoneCtoChannelDraftGenerationMode = "rewrite" | "source";
export type FiftyoneCtoPublishJobStatus =
  | "draft_creating"
  | "draft_created"
  | "confirming"
  | "published"
  | "failed"
  | "needs_manual_reconciliation"
  | "cancelled"
  | "needs_credentials";

export interface FiftyoneCtoChannelDraft {
  id: string;
  workspaceId: string;
  accountId: string;
  projectId: string | null;
  sourceRelativePath: string;
  sourceHash: string;
  generationMode: FiftyoneCtoChannelDraftGenerationMode;
  title: string;
  markdown: string;
  author: string;
  digest: string;
  coverSource: string;
  status: FiftyoneCtoChannelDraftStatus;
  createdAt: string;
  updatedAt: string;
}

export interface FiftyoneCtoPublishJob {
  id: string;
  workspaceId: string;
  accountId: string;
  channelDraftId: string;
  renderedPackageHash: string;
  idempotencyKey: string;
  status: FiftyoneCtoPublishJobStatus;
  remoteUrl: string | null;
  remoteContentId: string | null;
  statusNote: string | null;
  errorMessage: string | null;
  statusSource: "system" | "manual";
  /** 发布时填写的一级栏目 pid；再次进入时优先用作回。默认值。 */
  pid: string | null;
  /** 发布时填写的授权分类 cate_id。 */
  cateId: string | null;
  /** 发布时填写的标签列表（JSON 序列化）。 */
  tags: string[];
  /** 发布时填写的原创/转载/翻译（1/2/3）。 */
  blogType: "1" | "2" | "3";
  createdAt: string;
  updatedAt: string;
}

export interface FiftyoneCtoPublishOptions {
  pid?: string;
  cateId?: string;
  tags?: string[];
  blogType?: "1" | "2" | "3";
}

type FetchLike = typeof fetch;

export class FiftyoneCtoChannelService {
  private readonly publishOptionsCache = new Map<string, FiftyoneCtoPublishOptions>();

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
    return {
      canCreateRemoteDraft: true,
      canSubmitAfterConfirmation: false,
      canReadRemoteReceipt: true,
      supportsExternalLink: "allowed",
      supportsScheduledPublish: false
    };
  }

  async createFromSource(input: {
    accountId: string;
    relativePath: string;
    projectId?: string;
    generationMode?: FiftyoneCtoChannelDraftGenerationMode;
  }): Promise<FiftyoneCtoChannelDraft> {
    const account = this.accounts.requireAccount(input.accountId);
    if (account.platform !== "51cto") throw new FiftyoneCtoChannelError("请选择一个 51CTO 账号创建渠道稿。");
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

    const title = (article.title ?? firstHeading(article.markdown) ?? "未命名文章").slice(0, 120);
    const generatedDraft = generationMode === "rewrite"
      ? (await this.modelProvider.generateStructured({
          task: "revision",
          skillId: "platform-rewrite",
          prompt: buildFiftyoneCtoRewritePrompt({
            title,
            markdown: article.markdown,
            positioning: account.profile.positioning,
            audience: account.profile.targetAudience,
            writingStyle: account.profile.writingStyle,
            prohibitedTopics: account.profile.prohibitedTopics
          }),
          outputSchema: fiftyoneCtoDraftSchema,
          timeoutMs: 240_000,
          parse: (value) => parseGeneratedDraft(value)
        })).value
      : { title, markdown: article.markdown };
    const markdown = appendArticleSignature(normalizeMarkdown(generatedDraft.markdown, generatedDraft.title), account.profile.articleSignature);
    assertNoFiftyoneCtoPromotion(markdown);
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
      try { assetStore.deleteContext(id); } catch { /* ignore */ }
    }
    if (rows.length === 0) return 0;
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM fiftyone_cto_publish_job_events WHERE job_id IN (SELECT id FROM fiftyone_cto_publish_jobs WHERE channel_draft_id IN (${placeholders}))`).run(...ids);
      this.db.prepare(`DELETE FROM fiftyone_cto_publish_jobs WHERE channel_draft_id IN (${placeholders})`).run(...ids);
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
      this.db.prepare("DELETE FROM fiftyone_cto_publish_job_events WHERE job_id IN (SELECT id FROM fiftyone_cto_publish_jobs WHERE channel_draft_id = ?)").run(id);
      this.db.prepare("DELETE FROM fiftyone_cto_publish_jobs WHERE channel_draft_id = ?").run(id);
      this.db.prepare("DELETE FROM channel_drafts WHERE id = ?").run(id);
    })();
    return 1;
  }

  listDrafts(workspaceId: string, accountId?: string): FiftyoneCtoChannelDraft[] {
    const rows = accountId
      ? this.db.prepare("SELECT * FROM channel_drafts WHERE workspace_id = ? AND account_id = ? ORDER BY updated_at DESC LIMIT 100").all(workspaceId, accountId)
      : this.db.prepare("SELECT d.* FROM channel_drafts d JOIN media_accounts a ON a.id = d.account_id WHERE d.workspace_id = ? AND a.platform = '51cto' AND a.deleted_at IS NULL ORDER BY d.updated_at DESC LIMIT 100").all(workspaceId);
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

  approveDraft(id: string): FiftyoneCtoChannelDraft {
    const draft = this.requireDraft(id);
    if (draft.status !== "draft") throw new FiftyoneCtoChannelError("只有待审核的 51CTO 渠道稿可以冻结发布。");
    assertNoFiftyoneCtoPromotion(draft.markdown);
    this.db.prepare("UPDATE channel_drafts SET status = 'approved', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return this.requireDraft(id);
  }

  saveDraft(id: string, input: { title: string; markdown: string; author?: string; digest?: string; coverSource?: string }): FiftyoneCtoChannelDraft {
    const draft = this.requireDraft(id);
    if (draft.status !== "draft") throw new FiftyoneCtoChannelError("已冻结的 51CTO 渠道稿不能直接修改；请基于最新主稿重新生成。");
    const title = input.title.trim();
    if (!title || title.length > 120) throw new FiftyoneCtoChannelError("51CTO 渠道稿标题不能为空且不能超过 120 个字符。");
    if (!input.markdown.trim() || input.markdown.length > 100_000) throw new FiftyoneCtoChannelError("51CTO 渠道稿正文不能为空且不能超过 100000 个字符。");
    const markdown = normalizeMarkdown(input.markdown, title);
    assertNoFiftyoneCtoPromotion(markdown);
    const author = (input.author ?? "").slice(0, 16);
    const digestText = (input.digest ?? "").slice(0, 200);
    const coverSource = input.coverSource ?? "";
    this.db.prepare("UPDATE channel_drafts SET title = ?, markdown = ?, author = ?, digest = ?, cover_source = ?, updated_at = ? WHERE id = ?")
      .run(title, markdown, author, digestText, coverSource, new Date().toISOString(), id);
    return this.requireDraft(id);
  }

  /**
   * 创建 51CTO 发布任务。
   *
   * republishFromJobId（可选）=从已发布（published）的旧任务再发一次：复用旧任务的
   * pid/cateId/tags/blogType 作为默认值，但允许调用方在 options 里覆盖；旧任务
   * 状态保留（不改 status_source），新任务走独立的 draft_creating → published
   * 链路。常用于「文章在 51CTO 后台被人工删除/格式异常，文渡这边显示已发布，但
   * 实际需要重新发布」的场景。
   */
  createPublishJob(channelDraftId: string, options?: FiftyoneCtoPublishOptions, republishFromJobId?: string): FiftyoneCtoPublishJob {
    const draft = this.requireDraft(channelDraftId);
    if (draft.status !== "approved") throw new FiftyoneCtoChannelError("请先审核并冻结 51CTO 渠道稿，再创建发布任务。");

    // republishFromJobId 模式：优先复用旧任务的发布参数。调用方仍可在 options 里覆盖。
    let inherited: FiftyoneCtoPublishOptions | null = null;
    if (republishFromJobId) {
      const previous = this.db.prepare("SELECT * FROM fiftyone_cto_publish_jobs WHERE id = ?").get(republishFromJobId) as Record<string, string | null> | undefined;
      if (!previous) throw new FiftyoneCtoChannelError("找不到被重新发布的 51CTO 任务，无法继续。");
      const previousJob = mapJob(previous);
      if (previousJob.status !== "published") {
        throw new FiftyoneCtoChannelError("只有「已发布」状态的 51CTO 任务支持从文渡再发一次；当前状态：" + previousJob.status);
      }
      inherited = {
        pid: previousJob.pid ?? "",
        cateId: previousJob.cateId ?? "",
        tags: previousJob.tags ?? [],
        blogType: previousJob.blogType ?? "1"
      };
    }

    // 合并 options：republishFromJobId 给的 defaults，options 优先覆盖。
    const finalOptions: FiftyoneCtoPublishOptions = {
      pid: options?.pid ?? inherited?.pid ?? "",
      cateId: options?.cateId ?? inherited?.cateId ?? "",
      tags: options?.tags ?? inherited?.tags ?? [],
      blogType: options?.blogType ?? inherited?.blogType ?? "1"
    };

    const renderedPackageHash = digest(`${draft.title}\n${draft.markdown}`);
    let idempotencyKey = `fiftyonecto:${draft.accountId}:${draft.id}:${renderedPackageHash}:publish`;
    // republishFromJobId 模式（用户主动再发）必然生成全新任务：直接给 idempotency_key
    // 拼一个随机后缀，既绕开 idempotency 命中，也满足 UNIQUE(idempotency_key) 约束。
    if (republishFromJobId) {
      idempotencyKey = `${idempotencyKey}:republish:${randomUUID()}`;
    }
    const found = republishFromJobId ? undefined : this.db.prepare("SELECT * FROM fiftyone_cto_publish_jobs WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, string | null> | undefined;
    if (found) {
      let foundJob = mapJob(found);
      const restartable: FiftyoneCtoPublishJobStatus[] = ["draft_creating", "needs_credentials", "failed"];
      if (restartable.includes(foundJob.status)) {
        if (foundJob.status === "failed") {
          foundJob = this.transitionJob(foundJob, "draft_creating", {
            statusNote: "正在重新发布到 51CTO。",
            errorMessage: null
          });
        }
        if (foundJob.status === "draft_creating" || foundJob.status === "needs_credentials") {
          this.publishOptionsCache.set(foundJob.id, finalOptions);
          void this.executePublish(foundJob.id).catch(() => {});
        }
        return foundJob;
      }
      idempotencyKey = `${idempotencyKey}:retry:${randomUUID()}`;
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const initialNote = republishFromJobId
      ? `已重新创建 51CTO 发布任务（参考旧任务 ${republishFromJobId.slice(0, 8)}），正在发布。`
      : "已创建 51CTO 发布任务，正在发布。";
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO fiftyone_cto_publish_jobs
        (id, workspace_id, account_id, channel_draft_id, rendered_package_hash, idempotency_key, status, status_note, pid, cate_id, tags, blog_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'draft_creating', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, draft.workspaceId, draft.accountId, draft.id, renderedPackageHash, idempotencyKey,
          initialNote, finalOptions.pid, finalOptions.cateId, JSON.stringify(finalOptions.tags ?? []), finalOptions.blogType, now, now);
      this.db.prepare(`INSERT INTO fiftyone_cto_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, '', 'draft_creating', 'system', ?, ?)`)
        .run(randomUUID(), id, republishFromJobId ? `重新发布（参考旧任务 ${republishFromJobId.slice(0, 8)}）` : '创建发布任务', now);
    })();
    this.publishOptionsCache.set(id, finalOptions);
    void this.executePublish(id).catch(() => {});
    return this.requireJob(id);
  }

  listJobs(workspaceId: string): FiftyoneCtoPublishJob[] {
    return (this.db.prepare("SELECT * FROM fiftyone_cto_publish_jobs WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 100")
      .all(workspaceId) as Array<Record<string, string | null>>).map(mapJob);
  }

  getJob(jobId: string): FiftyoneCtoPublishJob {
    return this.requireJob(jobId);
  }

  getDraftForJob(jobId: string): FiftyoneCtoChannelDraft {
    const job = this.requireJob(jobId);
    return this.requireDraft(job.channelDraftId);
  }

  /** 重新尝试发布（用于 needs_credentials / failed 重试）。 */
  async confirmPublish(jobId: string): Promise<FiftyoneCtoPublishJob> {
    let job = this.requireJob(jobId);
    if (job.status === "published") throw new FiftyoneCtoChannelError("该 51CTO 任务已发布，请勿重复提交。");
    if (job.status === "cancelled") throw new FiftyoneCtoChannelError("该 51CTO 任务已取消，无法确认公开。");
    if (job.status === "draft_creating" || job.status === "failed" || job.status === "needs_credentials") {
      job = await this.executePublish(job.id);
    }
    return job;
  }

  recordSubmission(jobId: string, input: {
    remoteUrl: string | null;
    remoteContentId: string | null;
    state: "published" | "needs_manual_reconciliation";
    reason?: string;
  }): FiftyoneCtoPublishJob {
    const job = this.requireJob(jobId);
    if (job.status !== "draft_creating" && job.status !== "needs_manual_reconciliation" && job.status !== "failed") {
      throw new FiftyoneCtoChannelError("当前任务状态不允许保存发布回执。");
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
      statusNote: reason || "未能核实 51CTO 发布结果，请人工核对。",
      errorMessage: null
    });
  }

  correctStatus(jobId: string, status: "published" | "failed" | "cancelled", reason: string): FiftyoneCtoPublishJob {
    const job = this.requireJob(jobId);
    const correctable: FiftyoneCtoPublishJobStatus[] = [
      "draft_creating", "needs_manual_reconciliation", "failed", "needs_credentials", "cancelled", "published"
    ];
    if (!correctable.includes(job.status)) {
      throw new FiftyoneCtoChannelError("该 51CTO 发布任务状态不可人工校正。");
    }
    const normalizedReason = reason.trim();
    if (normalizedReason.length > 500) throw new FiftyoneCtoChannelError("核实依据不能超过 500 个字。");
    const now = new Date().toISOString();
    const note = status === "failed"
      ? `人工确认发布失败：${normalizedReason || "未填写依据"}`
      : status === "cancelled"
        ? `人工确认取消发布：${normalizedReason || "未填写依据"}`
        : null;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE fiftyone_cto_publish_jobs
        SET status = ?, error_message = ?, status_source = 'manual', status_note = ?, updated_at = ?
        WHERE id = ?`)
        .run(status, status === "failed" ? note : null, note, now, jobId);
      this.db.prepare(`INSERT INTO fiftyone_cto_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, ?, ?, 'manual', ?, ?)`)
        .run(randomUUID(), jobId, job.status, status, normalizedReason, now);
    })();
    return this.requireJob(jobId);
  }

  /** 单步发布：抓取配置 → 内联本地图片 → 转为 HTML → POST。 */
  private async executePublish(jobId: string): Promise<FiftyoneCtoPublishJob> {
    let job = this.requireJob(jobId);
    if (job.status === "published") return job;

    const account = this.accounts.requireAccount(job.accountId);
    if (account.platform !== "51cto") {
      return this.transitionJob(job, "failed", {
        statusNote: "所选账号不是 51CTO 账号。",
        errorMessage: "所选账号不是 51CTO 账号。"
      });
    }

    let client: CTOClient;
    try {
      client = this.buildClient(account);
    } catch (error) {
      const reason = messageOf(error);
      return this.transitionJob(job, "needs_credentials", { statusNote: reason, errorMessage: reason });
    }

    try {
      const draft = this.requireDraft(job.channelDraftId);
      // 优先用进程内 cache（最快），否则从 DB 行读——重启 dev 进程后 cache 为空，
      // 仍可由 DB 持久化的 pid/cateId/tags/blogType 恢复上次发布用的分类与标签。
      const cached = this.publishOptionsCache.get(job.id);
      const options: FiftyoneCtoPublishOptions = cached ?? {
        pid: job.pid ?? "",
        cateId: job.cateId ?? "",
        tags: job.tags ?? [],
        blogType: job.blogType ?? "1"
      };

      const cookie = this.loadCredentials(account).cookie;
      const uploader = new FiftyoneCtoImageUploader(cookie, this.fetcher);
      const mermaidMarkdown = await renderMermaidBlocks(draft.markdown, {
        uploadImage: (png, name) => uploader.upload(png, "image/png", name),
        onError: (source, error) => {
          const reason = error instanceof Error ? error.message : typeof error === "object" && error !== null ? JSON.stringify(error, Object.getOwnPropertyNames(error)) : String(error);
          console.error(`[51cto] mermaid 渲染失败，已保留原始代码块：${reason}\n源码前 120 字：${source.slice(0, 120)}`);
        }
      });
      const imageResult = await uploadFiftyoneCtoLocalImages(
        mermaidMarkdown,
        draft.workspaceId,
        draft.sourceRelativePath,
        this.contentSources,
        uploader
      );
      // 任意本地图片上传失败 → 整体发布失败：回退成 base64 内联的文章内联超长 data URI，
      // 51CTO 文章页加载异常且可能被截断，实际不可用。因此不再降级，直接中止发布。
      if (imageResult.failed.length > 0) {
        const detail = imageResult.failed
          .slice(0, 5)
          .map((f) => `${f.source}（${f.reason.slice(0, 400)}）`)
          .join("、");
        const note = `本地图片上传 51CTO 图床失败 ${imageResult.failed.length} 张，文章未发布：${detail}`;
        return this.transitionJob(job, "failed", { statusNote: note, errorMessage: imageResult.failed[0].reason });
      }

      const imageSummary: string[] = [];
      if (imageResult.uploadedCount > 0) imageSummary.push(`本地图片已上传图床 ${imageResult.uploadedCount} 张`);
      const imageStatusNote = imageSummary.join("；");

      const html = mdToHtml51(imageResult.markdown);
      const tagsStr = (options.tags ?? []).join(",");
      const blogType = options.blogType ?? "1";
      const result = await client.post({
        title: draft.title.slice(0, 120),
        contentHtml: html,
        tags: tagsStr,
        blogType,
        pid: options.pid ?? "",
        cateId: options.cateId ?? "",
        abstract: draft.digest.slice(0, 200)
      });
      // 把图片处理摘要拼到最终 statusNote，避免 transitionJob 的「已发布：url」覆盖掉上传详情。
      const finalNote = imageStatusNote
        ? `${result.url ? `已发布：${result.url}` : "已发布。"}（${imageStatusNote}）`
        : result.url ? `已发布：${result.url}` : "已发布。";
      return this.transitionJob(job, "published", {
        remoteUrl: result.url ?? null,
        remoteContentId: result.blogId ?? null,
        statusNote: finalNote,
        errorMessage: null
      });
    } catch (error) {
      const reason = messageOf(error);
      if (error instanceof FiftyoneCtoCredentialsError) {
        return this.transitionJob(job, "needs_credentials", { statusNote: `51CTO 凭据校验失败：${reason}`, errorMessage: reason });
      }
      return this.transitionJob(job, "failed", { statusNote: `发布到 51CTO 失败：${reason}`, errorMessage: reason });
    }
  }

  private loadCredentials(account: MediaAccount): { cookie: string } {
    let cookie = "";
    try {
      cookie = this.accounts.getCredential(account.id, "fiftyone_cto_cookie", this.vault).trim();
    } catch {
      throw new FiftyoneCtoCredentialsError("51CTO 账号尚未配置 Cookie，请先到账号页完成配置。");
    }
    if (!cookie) throw new FiftyoneCtoCredentialsError("51CTO 账号尚未配置 Cookie，请先到账号页完成配置。");
    return { cookie };
  }

  private buildClient(account: MediaAccount): CTOClient {
    const { cookie } = this.loadCredentials(account);
    return new CTOClient(cookie, this.fetcher);
  }

  private transitionJob(
    job: FiftyoneCtoPublishJob,
    nextStatus: FiftyoneCtoPublishJobStatus,
    patch: { statusNote?: string | null; errorMessage?: string | null; remoteUrl?: string | null; remoteContentId?: string | null }
  ): FiftyoneCtoPublishJob {
    const now = new Date().toISOString();
    const statusNote = patch.statusNote !== undefined ? patch.statusNote : job.statusNote;
    const errorMessage = patch.errorMessage !== undefined ? patch.errorMessage : job.errorMessage;
    const remoteUrl = patch.remoteUrl !== undefined ? patch.remoteUrl : job.remoteUrl;
    const remoteContentId = patch.remoteContentId !== undefined ? patch.remoteContentId : job.remoteContentId;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE fiftyone_cto_publish_jobs
        SET status = ?, status_note = ?, error_message = ?, remote_url = ?, remote_content_id = ?, updated_at = ?
        WHERE id = ?`)
        .run(nextStatus, statusNote, errorMessage, remoteUrl, remoteContentId, now, job.id);
      this.db.prepare(`INSERT INTO fiftyone_cto_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, ?, ?, 'system', ?, ?)`)
        .run(randomUUID(), job.id, job.status, nextStatus, patch.statusNote ?? "", now);
    })();
    return this.requireJob(job.id);
  }

  private requireDraft(id: string): FiftyoneCtoChannelDraft {
    const row = this.db.prepare("SELECT * FROM channel_drafts WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!row) throw new FiftyoneCtoChannelError("找不到对应的 51CTO 渠道稿。");
    return mapDraft(row);
  }

  private requireJob(id: string): FiftyoneCtoPublishJob {
    const row = this.db.prepare("SELECT * FROM fiftyone_cto_publish_jobs WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!row) throw new FiftyoneCtoChannelError("找不到对应的 51CTO 发布任务。");
    return mapJob(row);
  }
}

function parseGeneratedDraft(value: unknown): { title: string; markdown: string } {
  if (!value || typeof value !== "object") throw new FiftyoneCtoChannelError("模型没有返回可用的 51CTO 渠道稿。");
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const markdown = typeof record.markdown === "string" ? record.markdown.trim() : "";
  if (!title || title.length > 120 || !markdown || markdown.length > 100_000) {
    throw new FiftyoneCtoChannelError("模型返回的 51CTO 渠道稿不完整，请重新生成。");
  }
  return { title, markdown };
}

function normalizeMarkdown(markdown: string, title: string): string {
  const withoutFrontMatter = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
  const withoutLeadingTitle = withoutFrontMatter.replace(/^#\s+.+\n+/, "").trim();
  return `# ${title}\n\n${withoutLeadingTitle}`;
}

function assertNoFiftyoneCtoPromotion(markdown: string): void {
  const forbidden = [
    /https?:\/\/mp\.weixin\.qq\.com\//i,
    /公众号原文/,
    /延伸阅读/,
    /关注(?:我的|本)?公众号/,
    /扫描(?:下方|文末)?二维码/
  ];
  if (forbidden.some((pattern) => pattern.test(markdown))) {
    throw new FiftyoneCtoChannelError("生成的 51CTO 渠道稿包含被禁用的公众号引流内容，请重新生成。");
  }
}

function buildFiftyoneCtoRewritePrompt(input: {
  title: string;
  markdown: string;
  positioning: string;
  audience: string;
  writingStyle: string;
  prohibitedTopics: string;
}): string {
  return `你是专业的技术内容编辑。请把下面主稿改写成一篇适合 51CTO 技术读者独立阅读的中文文章。

硬性要求：
- 文章必须是独立内容，允许大幅调整标题、结构、段落顺序和表达，但不能编造事实、数据、经历、引用或来源。
- 保留可验证的代码、命令、链接与事实；对不确定信息保持原文的限定，而不是补造结论。
- 彻底去除公众号软引流：不得出现微信公众号原文链接、公众号引导、正文引用链接、文末延伸阅读、二维码、评论区引流或"关注公众号"等措辞。
- 标题不超过 120 个字符，摘要不超过 200 个字符。
- 用自然、具体、面向开发者的表达，避免模板化 AI 腔和空泛总结。
- 输出 JSON：title 为不超过 120 字的标题；markdown 为完整 Markdown 正文。markdown 的第一行必须是 "# {title}"。

账号定位：${input.positioning || "未设置"}
目标读者：${input.audience || "51CTO 技术读者"}
写作风格：${input.writingStyle || "清晰、具体、自然"}
禁用话题/表达：${input.prohibitedTopics || "无"}

主稿标题：${input.title}

主稿正文：
${input.markdown}`;
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

function mapDraft(row: Record<string, string | null>): FiftyoneCtoChannelDraft {
  return {
    id: row.id!, workspaceId: row.workspace_id!, accountId: row.account_id!, projectId: row.project_id,
    sourceRelativePath: row.source_relative_path!, sourceHash: row.source_hash!,
    generationMode: row.generation_mode === "source" ? "source" : "rewrite", title: row.title!, markdown: row.markdown!,
    author: row.author ?? "", digest: row.digest ?? "", coverSource: row.cover_source ?? "",
    status: row.status as FiftyoneCtoChannelDraftStatus, createdAt: row.created_at!, updatedAt: row.updated_at!
  };
}

function mapJob(row: Record<string, string | null>): FiftyoneCtoPublishJob {
  return {
    id: row.id!, workspaceId: row.workspace_id!, accountId: row.account_id!, channelDraftId: row.channel_draft_id!,
    renderedPackageHash: row.rendered_package_hash!, idempotencyKey: row.idempotency_key!,
    status: row.status as FiftyoneCtoPublishJobStatus, remoteUrl: row.remote_url, remoteContentId: row.remote_content_id,
    statusNote: row.status_note, errorMessage: row.error_message,
    statusSource: row.status_source === "manual" ? "manual" : "system",
    pid: row.pid, cateId: row.cate_id, tags: parseTags(row.tags), blogType: parseBlogType(row.blog_type),
    createdAt: row.created_at!, updatedAt: row.updated_at!
  };
}

/** DB 里 tags 列是 JSON 字符串（也可能为空或非法）；安全解析回 string[]，空值回退到 []。 */
function parseTags(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/** blogType 是 "1"/"2"/"3"；空值或非法值回退到 "1"。 */
function parseBlogType(value: string | null | undefined): "1" | "2" | "3" {
  return value === "2" || value === "3" ? value : "1";
}

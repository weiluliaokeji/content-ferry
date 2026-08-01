import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AccountRepository } from "../accounts/account-repository";
import type { ContentSourceService } from "../content/content-source-service";
import type { LocalAssetStore } from "../content/local-asset-store";
import type { ModelProvider } from "../ai/model-provider";
import type { PublishCapabilities } from "../publishing/platform-publisher-connector";
import { resolveCsdnImagesForBrowser, resolveCoverToDataUrl } from "./csdn-image-inliner";

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
  | "needs_user"
  | "ready_for_final_confirmation"
  | "submitting"
  | "published"
  | "needs_manual_reconciliation"
  | "failed_before_submit"
  | "failed"
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
    private readonly modelProvider: ModelProvider,
    private readonly assetStore?: LocalAssetStore
  ) {}

  capabilities(_accountId: string): PublishCapabilities {
    // CSDN 一期通过受控可见浏览器完成登录预检、表单填充与人工最终确认后的单次提交。
    // 这里只声明“受控浏览器辅助”能力，不等于无人值守自动发布；最终发布点击仍由用户在浏览器内完成。
    return {
      canCreateRemoteDraft: true,
      canSubmitAfterConfirmation: true,
      canReadRemoteReceipt: true,
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
    // 原文设置（作者/摘要/封面）是 CSDN 稿的默认继承来源；提前读取，便于命中已有草稿时回填。
    const sourceSettings = this.db.prepare("SELECT author, digest, cover_source FROM article_settings WHERE context_key = ?")
      .get(`source:${article.relativePath}`) as { author: string | null; digest: string | null; cover_source: string | null } | undefined;
    const existing = this.db.prepare(`SELECT * FROM channel_drafts
      WHERE account_id = ? AND source_relative_path = ? AND source_hash = ? AND generation_mode = ? AND status IN ('draft', 'approved')
      ORDER BY updated_at DESC LIMIT 1`).get(account.id, article.relativePath, sourceHash, generationMode) as Record<string, string | null> | undefined;
    if (existing) {
      // 草稿态且继承字段为空（多由“继承功能上线前的旧草稿”导致）：从最新原文设置回填，
      // 避免旧空快照一直显示空作者/空摘要/空封面。已冻结(approved)的内容快照不改动。
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

  deleteDraft(id: string): number {
    const row = this.db.prepare("SELECT id FROM channel_drafts WHERE id = ?").get(id) as { id: string } | undefined;
    if (!row) return 0;
    // 清理该草稿在本地素材库中的图片上下文（封面/正文插图）。
    if (this.assetStore) {
      try { this.assetStore.deleteContext(id); } catch { /* 图片目录可能不存在，忽略 */ }
    }
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM csdn_publish_job_events WHERE job_id IN (SELECT id FROM csdn_publish_jobs WHERE channel_draft_id = ?)").run(id);
      this.db.prepare("DELETE FROM csdn_publish_jobs WHERE channel_draft_id = ?").run(id);
      this.db.prepare("DELETE FROM channel_drafts WHERE id = ?").run(id);
    })();
    return 1;
  }

  listDrafts(workspaceId: string, accountId?: string): CsdnChannelDraft[] {
    const rows = accountId
      ? this.db.prepare("SELECT * FROM channel_drafts WHERE workspace_id = ? AND account_id = ? ORDER BY updated_at DESC LIMIT 100").all(workspaceId, accountId)
      : this.db.prepare("SELECT * FROM channel_drafts WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 100").all(workspaceId);
    const drafts = (rows as Array<Record<string, string | null>>).map(mapDraft);
    // 兼容“继承功能上线前的旧空草稿”：草稿态且作者/摘要/封面任一为空时，从最新原文设置回填，
    // 保证进入现有草稿即可看到原文封面/摘要/作者（仅在显示层补默认值，不改写已编辑内容）。
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
    let idempotencyKey = `csdn:${draft.accountId}:${draft.id}:${renderedPackageHash}:publish`;
    const found = this.db.prepare("SELECT * FROM csdn_publish_jobs WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, string | null> | undefined;
    if (found) {
      const foundJob = mapJob(found);
      // 只有“可重启”的任务才复用，避免把上次卡在终态（提交超时/失败/已发布/取消）的旧任务
      // 反复返回给用户。否则用户再次点击“发布到 CSDN”会命中这个不可重启的旧任务，
      // startBrowserAssist 直接抛“任务已结束”，浏览器根本不会打开。终态任务一律新建一个重新开始。
      const restartable: CsdnPublishJobStatus[] = [
        "queued", "needs_login", "filling", "ready_for_final_confirmation", "failed_before_submit"
      ];
      if (restartable.includes(foundJob.status)) return foundJob;
      // 终态：放弃复用，改用带 retry 后缀的新幂等键，避免与旧任务的 UNIQUE 约束冲突。
      idempotencyKey = `${idempotencyKey}:retry:${randomUUID()}`;
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO csdn_publish_jobs
        (id, workspace_id, account_id, channel_draft_id, rendered_package_hash, idempotency_key, status, status_note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`)
        .run(id, draft.workspaceId, draft.accountId, draft.id, renderedPackageHash, idempotencyKey,
          "已创建 CSDN 发布任务，等待在浏览器中完成登录、填充与最终确认发布。", now, now);
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

  getJob(jobId: string): CsdnPublishJob {
    return this.requireJob(jobId);
  }

  getDraftForJob(jobId: string): CsdnChannelDraft {
    const job = this.requireJob(jobId);
    return this.requireDraft(job.channelDraftId);
  }

  /** Return the draft content prepared for the visible browser assistant, plus
   * every uploadable image resolved to a base64 data URL. The actual upload to
   * CSDN's image hosting is performed inside the already-logged-in editor page
   * (via its own `window.csdn.upload.uploadImg` API) by the caller, so it never
   * depends on CSDN's private token/OSS endpoint or on transferring cookies. */
  async getBrowserDraft(
    jobId: string
  ): Promise<{
    title: string;
    markdown: string;
    author: string;
    digest: string;
    images: Array<{ source: string; dataUrl: string; mimeType: string; filename: string }>;
    /** The main article's cover resolved to a data URL, when available. */
    coverDataUrl?: string;
  }> {
    const draft = this.getDraftForJob(jobId);
    const images = await resolveCsdnImagesForBrowser(draft.markdown, draft.workspaceId, draft.sourceRelativePath, this.contentSources);
    // Source the summary and cover from the MAIN article (article_settings for
    // `source:<relativePath>`), falling back to the CSDN channel draft's own
    // copy. The channel draft only snapshots these at generation time, so if the
    // main article's summary/cover changed afterwards the copy would be stale or
    // empty. The user expects the main article's values to be used here.
    const sourceSettings = this.db.prepare("SELECT digest, cover_source FROM article_settings WHERE context_key = ?")
      .get(`source:${draft.sourceRelativePath}`) as { digest: string | null; cover_source: string | null } | undefined;
    const digest = draft.digest || sourceSettings?.digest || "";
    const coverSource = draft.coverSource || sourceSettings?.cover_source || "";
    const resolvedCover = coverSource
      ? await resolveCoverToDataUrl(coverSource, draft.workspaceId, draft.sourceRelativePath, this.contentSources, this.assetStore)
      : null;
    // Fallback: if the main article has no dedicated cover, reuse the first body
    // image so CSDN always receives a valid cover. An empty cover combined with
    // other required fields can trigger CSDN's "提交的信息不符合要求：填写内容格式不正确"
    // rejection, and a thumbnail also helps the post render correctly.
    const coverDataUrl = resolvedCover ?? images[0]?.dataUrl;
    return {
      title: draft.title,
      markdown: draft.markdown,
      author: draft.author,
      digest,
      images,
      coverDataUrl
    };
  }

  /**
   * 用户在文渡点击“在浏览器中完成发布”后调用：标记浏览器辅助流程已开始。
   * 实际登录预检与表单填充由主进程可见浏览器驱动，再通过 recordNeedsLogin / recordFill 回写。
   */
  startBrowserAssist(jobId: string): CsdnPublishJob {
    const job = this.requireJob(jobId);
    const restartable: CsdnPublishJobStatus[] = [
      "queued", "needs_login", "filling", "ready_for_final_confirmation", "failed_before_submit"
    ];
    if (!restartable.includes(job.status)) {
      throw new CsdnChannelError("该 CSDN 发布任务已经结束或正在提交，无法重新进入浏览器辅助流程。");
    }
    return this.transitionJob(job, "filling", {
      statusNote: "已打开 CSDN 编辑器，正在预检登录态并填充表单。",
      errorMessage: null
    });
  }

  /** 浏览器驱动发现未登录：交给用户在浏览器内登录，登录后重新发起。 */
  recordNeedsLogin(jobId: string, reason: string): CsdnPublishJob {
    const job = this.requireJob(jobId);
    if (job.status !== "filling" && job.status !== "needs_login") {
      throw new CsdnChannelError("只有正在浏览器辅助的任务可以标记为需要登录。");
    }
    return this.transitionJob(job, "needs_login", {
      statusNote: reason.trim().slice(0, 500) || "请在 CSDN 编辑器完成登录后，重新点击“在浏览器中完成发布”。",
      errorMessage: null
    });
  }

  /**
   * 浏览器驱动完成一次表单填充尝试后的回写。
   * state 必须是 ready_for_final_confirmation（填充成功，等待用户最终确认）、
   * needs_user（部分字段未可靠填充，需人工接管）或 failed_before_submit（不可恢复失败）。
   */
  recordFill(jobId: string, input: {
    verifiedFields: Array<"account" | "title" | "summary" | "tags" | "cover" | "asset_count" | "content">;
    state: "ready_for_final_confirmation" | "needs_user" | "failed_before_submit";
    reason?: string;
  }): CsdnPublishJob {
    const job = this.requireJob(jobId);
    if (job.status !== "filling" && job.status !== "needs_login") {
      throw new CsdnChannelError("只有正在浏览器辅助的任务可以回写填充结果。");
    }
    const reason = (input.reason ?? "").trim().slice(0, 500);
    if (input.state === "ready_for_final_confirmation") {
      return this.transitionJob(job, "ready_for_final_confirmation", {
        statusNote: `已填充：${input.verifiedFields.join("、") || "无"}。请在浏览器中核对内容并点击发布；确认无误后在文渡点击“我已在 CSDN 发布”。`,
        errorMessage: null
      });
    }
    if (input.state === "needs_user") {
      return this.transitionJob(job, "needs_user", {
        statusNote: reason || "部分字段未能可靠填充，请在浏览器中手动补齐后，回到文渡点击“我已在 CSDN 发布”。",
        errorMessage: null
      });
    }
    return this.transitionJob(job, "failed_before_submit", {
      statusNote: reason || "浏览器表单填充失败。",
      errorMessage: reason || "浏览器表单填充失败。"
    });
  }

  /**
   * 用户在文渡确认“已在 CSDN 发布”后，由主进程读取远端回执并回写。
   * state 必须是 published（读到文章链接）或 needs_manual_reconciliation（读不到可靠回执）。
   */
  recordSubmission(jobId: string, input: {
    remoteUrl: string | null;
    remoteContentId: string | null;
    state: "published" | "needs_manual_reconciliation";
    reason?: string;
  }): CsdnPublishJob {
    const job = this.requireJob(jobId);
    if (job.status !== "submitting" && job.status !== "ready_for_final_confirmation" && job.status !== "needs_user") {
      throw new CsdnChannelError("只有等待最终确认或正在提交的任务可以回写发布结果。");
    }
    const reason = (input.reason ?? "").trim().slice(0, 500);
    if (input.state === "published") {
      return this.transitionJob(job, "published", {
        remoteUrl: input.remoteUrl,
        remoteContentId: input.remoteContentId,
        statusNote: input.remoteUrl ? `已发布：${input.remoteUrl}` : "已发布（未读回文章链接，请在浏览器核对）。",
        errorMessage: null
      });
    }
    return this.transitionJob(job, "needs_manual_reconciliation", {
      statusNote: reason || "未能自动读取 CSDN 文章链接，请人工在浏览器核对发布结果。",
      errorMessage: null
    });
  }

  /** 用户在文渡点击“我已在 CSDN 发布”后，标记为正在提交，等待浏览器回执。 */
  beginSubmit(jobId: string): CsdnPublishJob {
    const job = this.requireJob(jobId);
    if (job.status !== "ready_for_final_confirmation" && job.status !== "needs_user") {
      throw new CsdnChannelError("只有等待最终确认的 CSDN 任务可以提交。");
    }
    return this.transitionJob(job, "submitting", {
      statusNote: "已在浏览器点击发布，正在读取 CSDN 回执。",
      errorMessage: null
    });
  }

  /** 用户人工校正 CSDN 发布结果（与微信一致：只改文渡记录，不调用 CSDN）。 */
  correctStatus(jobId: string, status: "published" | "failed" | "cancelled", reason: string): CsdnPublishJob {
    const job = this.requireJob(jobId);
    const correctable: CsdnPublishJobStatus[] = [
      "queued", "needs_login", "filling", "ready_for_final_confirmation", "submitting",
      "needs_manual_reconciliation", "failed_before_submit", "failed"
    ];
    if (!correctable.includes(job.status)) {
      throw new CsdnChannelError("该 CSDN 发布任务状态不可人工校正。");
    }
    const normalizedReason = reason.trim();
    if (normalizedReason.length > 500) throw new CsdnChannelError("核实依据不能超过 500 个字。");
    const now = new Date().toISOString();
    const note = status === "failed"
      ? `人工确认发布失败：${normalizedReason || "未填写依据"}`
      : status === "cancelled"
        ? `人工确认取消发布：${normalizedReason || "未填写依据"}`
        : null;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE csdn_publish_jobs
        SET status = ?, error_message = ?, status_source = 'manual', status_note = ?, updated_at = ?
        WHERE id = ?`)
        .run(status, status === "failed" ? note : null, note, now, jobId);
      this.db.prepare(`INSERT INTO csdn_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, ?, ?, 'manual', ?, ?)`)
        .run(randomUUID(), jobId, job.status, status, normalizedReason, now);
    })();
    return this.requireJob(jobId);
  }

  private transitionJob(
    job: CsdnPublishJob,
    nextStatus: CsdnPublishJobStatus,
    patch: { statusNote?: string | null; errorMessage?: string | null; remoteUrl?: string | null; remoteContentId?: string | null }
  ): CsdnPublishJob {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE csdn_publish_jobs
        SET status = ?, status_note = COALESCE(?, status_note), error_message = COALESCE(?, error_message),
          remote_url = COALESCE(?, remote_url), remote_content_id = COALESCE(?, remote_content_id), updated_at = ?
        WHERE id = ?`)
        .run(
          nextStatus,
          patch.statusNote !== undefined ? patch.statusNote : null,
          patch.errorMessage !== undefined ? patch.errorMessage : null,
          patch.remoteUrl !== undefined ? patch.remoteUrl : null,
          patch.remoteContentId !== undefined ? patch.remoteContentId : null,
          now,
          job.id
        );
      this.db.prepare(`INSERT INTO csdn_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, ?, ?, 'browser', ?, ?)`)
        .run(randomUUID(), job.id, job.status, nextStatus, patch.statusNote ?? "", now);
    })();
    return this.requireJob(job.id);
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

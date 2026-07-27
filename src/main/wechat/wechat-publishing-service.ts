import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AccountRepository } from "../accounts/account-repository";
import type { LocalAssetStore } from "../content/local-asset-store";
import type { ContentSourceService } from "../content/content-source-service";
import type { CredentialVault } from "../security/credential-vault";

type FetchLike = typeof fetch;
type PublishMode = "publish" | "mass";

interface WechatResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
  media_id?: string;
  publish_id?: string;
  msg_id?: string | number;
  msg_data_id?: string | number;
  url?: string;
  item?: Array<{ media_id: string; name: string; update_time: number; url?: string }>;
  total_count?: number;
  item_count?: number;
}

export class WechatApiError extends Error {
  constructor(message: string, readonly errcode?: number) {
    super(message);
    this.name = "WechatApiError";
  }
}

export class WechatPublishingService {
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();
  private readonly tokenRequests = new Map<string, Promise<string>>();

  constructor(
    private readonly db: Database.Database,
    private readonly accounts: AccountRepository,
    private readonly vault: CredentialVault,
    private readonly assets?: LocalAssetStore,
    private readonly contentSources?: ContentSourceService,
    private readonly fetcher: FetchLike = fetch
  ) {}

  async testConnection(accountId: string): Promise<{ connected: true; expiresAt: string }> {
    await this.getAccessToken(accountId, true);
    const token = this.tokens.get(accountId)!;
    return { connected: true, expiresAt: new Date(token.expiresAt).toISOString() };
  }

  async createProjectDraft(input: {
    accountId: string;
    projectId: string;
    author?: string;
    digest?: string;
    thumbMediaId?: string;
    coverSource?: string;
    needOpenComment?: boolean;
    onlyFansCanComment?: boolean;
    declareOriginal?: boolean;
    enableReward?: boolean;
    collectionName?: string;
  }): Promise<WechatPublishJob> {
    const account = this.accounts.requireAccount(input.accountId);
    if (account.platform !== "wechat_official") throw new WechatApiError("所选账号不是微信公众号。");
    const row = this.db.prepare(`SELECT p.workspace_id, p.topic, p.source_relative_path, d.markdown
      FROM content_projects p JOIN content_drafts d ON d.project_id = p.id
      WHERE p.id = ?`).get(input.projectId) as { workspace_id: string; topic: string; source_relative_path: string | null; markdown: string } | undefined;
    if (!row) throw new WechatApiError("找不到已保存的正文，请先完成并保存文章。");
    if (account.workspaceId !== row.workspace_id) throw new WechatApiError("文章与公众号不属于同一个工作区。");

    const sourceArticle = row.source_relative_path && this.contentSources
      ? this.contentSources.getArticle(row.workspace_id, row.source_relative_path)
      : undefined;
    const articleMarkdown = removeDuplicateLeadingTitle(sourceArticle?.markdown ?? row.markdown, row.topic);
    const prepared = await this.prepareWechatArticle(input.accountId, articleMarkdown, input.thumbMediaId, input.coverSource, async (source) => {
      const local = parseContentFerryAsset(source);
      if (local && this.assets) {
        const asset = this.assets.readBytes(local.contextId, local.fileName);
        return { ...asset, fileName: local.fileName };
      }
      if (sourceArticle && this.contentSources && !/^https?:\/\//i.test(source)) {
        const asset = this.contentSources.readArticleResource(row.workspace_id, sourceArticle.relativePath, source);
        return {
          bytes: await readStream(asset.stream),
          mimeType: asset.mimeType,
          fileName: source.split(/[\\/]/).at(-1)?.split(/[?#]/, 1)[0] || "article-image.png"
        };
      }
      return null;
    });
    const result = await this.call(input.accountId, "/cgi-bin/draft/add", {
      articles: [{
        title: row.topic.slice(0, 64),
        author: input.author?.trim().slice(0, 16) || "",
        digest: input.digest?.trim().slice(0, 120) || "",
        content: prepared.html,
        thumb_media_id: prepared.thumbMediaId,
        need_open_comment: input.needOpenComment === false ? 0 : 1,
        only_fans_can_comment: input.needOpenComment === false || !input.onlyFansCanComment ? 0 : 1
      }]
    });
    if (!result.media_id) throw new WechatApiError("微信没有返回草稿 media_id。");

    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO wechat_publish_jobs
      (id, workspace_id, account_id, project_id, source_relative_path, mode, title, draft_media_id, status, declare_original, enable_reward, collection_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, (SELECT source_relative_path FROM content_projects WHERE id = ?), 'draft', ?, ?, 'draft_ready', ?, ?, ?, ?, ?)`)
      .run(id, account.workspaceId, account.id, input.projectId, input.projectId, row.topic, result.media_id,
        input.declareOriginal ? 1 : 0, input.enableReward ? 1 : 0, input.collectionName?.trim().slice(0, 80) || "", now, now);
    return this.requireJob(id);
  }

  async createSourceDraft(input: {
    accountId: string;
    relativePath: string;
    author?: string;
    digest?: string;
    thumbMediaId?: string;
    coverSource?: string;
    needOpenComment?: boolean;
    onlyFansCanComment?: boolean;
    declareOriginal?: boolean;
    enableReward?: boolean;
    collectionName?: string;
  }): Promise<WechatPublishJob> {
    const account = this.accounts.requireAccount(input.accountId);
    if (account.platform !== "wechat_official") throw new WechatApiError("所选账号不是微信公众号。");
    if (!this.contentSources) throw new WechatApiError("VitePress 文章库尚未启用。");
    const article = this.contentSources.getArticle(account.workspaceId, input.relativePath);
    const fullTitle = article.title || article.relativePath.split("/").at(-2) || "未命名文章";
    const prepared = await this.prepareWechatArticle(input.accountId, removeDuplicateLeadingTitle(article.markdown, fullTitle), input.thumbMediaId, input.coverSource, async (source) => {
      if (/^https?:\/\//i.test(source)) return null;
      const asset = this.contentSources!.readArticleResource(account.workspaceId, article.relativePath, source);
      return {
        bytes: await readStream(asset.stream),
        mimeType: asset.mimeType,
        fileName: source.split(/[\\/]/).at(-1)?.split(/[?#]/, 1)[0] || "article-image.png"
      };
    });
    const title = fullTitle.slice(0, 64);
    const result = await this.call(input.accountId, "/cgi-bin/draft/add", {
      articles: [{
        title,
        author: input.author?.trim().slice(0, 16) || "",
        digest: input.digest?.trim().slice(0, 120) || "",
        content: prepared.html,
        thumb_media_id: prepared.thumbMediaId,
        need_open_comment: input.needOpenComment === false ? 0 : 1,
        only_fans_can_comment: input.needOpenComment === false || !input.onlyFansCanComment ? 0 : 1
      }]
    });
    if (!result.media_id) throw new WechatApiError("微信没有返回草稿 media_id。");
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO wechat_publish_jobs
      (id, workspace_id, account_id, project_id, source_relative_path, mode, title, draft_media_id, status, declare_original, enable_reward, collection_name, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, 'draft', ?, ?, 'draft_ready', ?, ?, ?, ?, ?)`)
      .run(id, account.workspaceId, account.id, article.relativePath, title, result.media_id,
        input.declareOriginal ? 1 : 0, input.enableReward ? 1 : 0, input.collectionName?.trim().slice(0, 80) || "", now, now);
    return this.requireJob(id);
  }

  async submit(jobId: string, mode: PublishMode): Promise<WechatPublishJob> {
    const job = this.requireJob(jobId);
    if (!job.draftMediaId) throw new WechatApiError("该任务没有可提交的微信草稿。");
    if (job.status !== "draft_ready" && job.status !== "failed") {
      throw new WechatApiError("该草稿已提交，请勿重复操作。");
    }
    try {
      const result = mode === "publish"
        ? await this.call(job.accountId, "/cgi-bin/freepublish/submit", { media_id: job.draftMediaId })
        : await this.call(job.accountId, "/cgi-bin/message/mass/sendall", {
            filter: { is_to_all: true },
            mpnews: { media_id: job.draftMediaId },
            msgtype: "mpnews",
            send_ignore_reprint: 0
          });
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE wechat_publish_jobs SET mode = ?, publish_id = ?, message_id = ?,
        status = 'submitted', error_message = NULL, status_source = 'system', status_note = NULL, updated_at = ? WHERE id = ?`)
        .run(mode, result.publish_id ?? null, result.msg_id == null ? null : String(result.msg_id), now, jobId);
      return this.requireJob(jobId);
    } catch (error) {
      this.db.prepare("UPDATE wechat_publish_jobs SET mode = ?, status = 'failed', error_message = ?, status_source = 'system', status_note = NULL, updated_at = ? WHERE id = ?")
        .run(mode, error instanceof Error ? error.message : String(error), new Date().toISOString(), jobId);
      throw error;
    }
  }

  list(workspaceId: string): WechatPublishJob[] {
    const rows = this.db.prepare("SELECT * FROM wechat_publish_jobs WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 100")
      .all(workspaceId) as Array<Record<string, string | null>>;
    return rows.map(mapJob);
  }

  deleteJob(jobId: string): void {
    this.requireJob(jobId);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM wechat_publish_job_events WHERE job_id = ?").run(jobId);
      this.db.prepare("DELETE FROM wechat_publish_jobs WHERE id = ?").run(jobId);
    })();
  }

  startBrowserAssistedPublishing(jobId: string): WechatPublishJob {
    const job = this.requireJob(jobId);
    if (job.status !== "draft_ready" && job.status !== "browser_editing") {
      throw new WechatApiError("只有已同步的微信草稿可以进入微信后台完善流程。");
    }
    const now = new Date().toISOString();
    const requestedSettings = [
      job.declareOriginal ? "申请原创" : "",
      job.enableReward ? "开启赞赏" : "",
      job.collectionName ? `加入合集「${job.collectionName}」` : ""
    ].filter(Boolean);
    const statusNote = requestedSettings.length > 0
      ? `已打开微信后台，将尝试${requestedSettings.join("、")}；请最后预览并点击发布。`
      : "已打开微信后台并定位草稿；请最后预览并点击发布。";
    this.db.transaction(() => {
      this.db.prepare(`UPDATE wechat_publish_jobs
        SET status = 'browser_editing', error_message = NULL, status_source = 'browser',
          status_note = ?, updated_at = ?
        WHERE id = ?`).run(statusNote, now, jobId);
      this.db.prepare(`INSERT INTO wechat_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, ?, 'browser_editing', 'browser', ?, ?)`)
        .run(randomUUID(), jobId, job.status, "启动可见浏览器后台完善流程", now);
    })();
    return this.requireJob(jobId);
  }

  correctStatus(jobId: string, status: "published" | "failed" | "cancelled", reason: string): WechatPublishJob {
    const job = this.requireJob(jobId);
    if (job.status !== "draft_ready" && job.status !== "browser_editing" && job.status !== "submitted" && job.status !== "failed") {
      throw new WechatApiError("只有微信草稿、等待微信回执或失败的任务可以人工校正状态。");
    }
    const normalizedReason = reason.trim();
    if (normalizedReason.length > 500) {
      throw new WechatApiError("核实依据不能超过 500 个字。");
    }
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      this.db.prepare(`UPDATE wechat_publish_jobs
        SET status = ?, error_message = ?, status_source = 'manual', status_note = ?, updated_at = ?
        WHERE id = ?`)
        .run(status, status === "failed" ? `人工确认发布失败：${normalizedReason}` : status === "cancelled" ? `人工确认取消发布：${normalizedReason}` : null, normalizedReason, now, jobId);
      this.db.prepare(`INSERT INTO wechat_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, ?, ?, 'manual', ?, ?)`)
        .run(randomUUID(), jobId, job.status, status, normalizedReason, now);
    });
    transaction();
    return this.requireJob(jobId);
  }

  async listImageMaterials(accountId: string, offset = 0, count = 20) {
    const result = await this.call(accountId, "/cgi-bin/material/batchget_material", {
      type: "image", offset, count: Math.min(20, Math.max(1, count))
    });
    return {
      totalCount: result.total_count ?? 0,
      items: (result.item ?? []).map((item) => ({
        mediaId: item.media_id,
        name: item.name,
        updatedAt: new Date(item.update_time * 1000).toISOString(),
        url: item.url ?? null
      }))
    };
  }

  async getImageMaterial(accountId: string, mediaId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const account = this.accounts.requireAccount(accountId);
    if (account.platform !== "wechat_official") throw new WechatApiError("所选账号不是微信公众号。");
    const accessToken = await this.getAccessToken(accountId);
    const response = await this.fetcher(`https://api.weixin.qq.com/cgi-bin/material/get_material?access_token=${encodeURIComponent(accessToken)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ media_id: mediaId })
    });
    const mimeType = response.headers.get("content-type") ?? "";
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new WechatApiError(`读取微信素材失败（HTTP ${response.status}）。`);
    if (mimeType.includes("application/json") || mimeType.includes("text/plain")) {
      const payload = JSON.parse(bytes.toString("utf8")) as WechatResponse;
      throw new WechatApiError(`读取微信素材失败：${payload.errmsg ?? "微信返回未知错误"}`, payload.errcode);
    }
    return { bytes, mimeType: mimeType.split(";")[0] || "image/jpeg" };
  }

  private async prepareWechatArticle(
    accountId: string,
    markdown: string,
    suppliedThumbMediaId: string | undefined,
    coverSource: string | undefined,
    resolveLocalImage: (source: string) => Promise<{ bytes: Buffer; mimeType: string; fileName: string } | null>
  ) {
    let thumbMediaId = suppliedThumbMediaId?.trim() || "";
    const uploaded = new Map<string, string>();
    const imagePattern = /!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
    // 代码示例中的 ![](...) 只是文本，不能作为要上传的正文图片处理。
    const matches = [...withoutFencedCodeBlocks(markdown).matchAll(imagePattern)];
    for (const match of matches) {
      const source = match[2];
      if (/^https?:\/\//i.test(source)) continue;
      const local = await resolveLocalImage(source);
      if (!local) {
        throw new WechatApiError(`正文图片“${source}”尚未进入 ContentFerry 素材库，无法上传到微信。`);
      }
      const wechatUrl = await this.uploadMultipart(accountId, "/cgi-bin/media/uploadimg", local.bytes, local.mimeType, local.fileName, "url");
      uploaded.set(source, wechatUrl);
    }
    if (!thumbMediaId && coverSource) {
      const cover = await resolveLocalImage(coverSource);
      if (!cover) throw new WechatApiError("找不到所选封面图片，请重新选择。");
      thumbMediaId = await this.uploadMultipart(accountId, "/cgi-bin/material/add_material?type=image", cover.bytes, cover.mimeType, cover.fileName, "media_id");
    }
    if (!thumbMediaId) {
      throw new WechatApiError("微信公众号草稿必须有封面。请先选择本地图片、生成封面或从微信素材库选择。");
    }
    const html = markdownToWechatHtml(markdown, uploaded);
    return { html, thumbMediaId };
  }

  private async getAccessToken(accountId: string, forceRefresh = false): Promise<string> {
    const cached = this.tokens.get(accountId);
    if (!forceRefresh && cached && Date.now() < cached.expiresAt - 5 * 60_000) return cached.value;
    const pending = this.tokenRequests.get(accountId);
    if (pending) return pending;
    const request = (async () => {
      let appId: string;
      let appSecret: string;
      try {
        appId = this.accounts.getCredential(accountId, "app_id", this.vault);
        appSecret = this.accounts.getCredential(accountId, "app_secret", this.vault);
      } catch {
        throw new WechatApiError("该公众号尚未完整配置 AppID 和 AppSecret，请先到账号页连接微信。");
      }
      const response = await this.fetcher("https://api.weixin.qq.com/cgi-bin/stable_token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "client_credential", appid: appId, secret: appSecret, force_refresh: forceRefresh })
      });
      const result = await response.json() as WechatResponse;
      ensureWechatSuccess(response, result, "获取 access_token");
      if (!result.access_token) throw new WechatApiError("微信没有返回 access_token。");
      this.tokens.set(accountId, {
        value: result.access_token,
        expiresAt: Date.now() + Math.max(300, result.expires_in ?? 7200) * 1000
      });
      return result.access_token;
    })().finally(() => this.tokenRequests.delete(accountId));
    this.tokenRequests.set(accountId, request);
    return request;
  }

  private async call(accountId: string, apiPath: string, body: unknown, retry = true): Promise<WechatResponse> {
    const token = await this.getAccessToken(accountId);
    const separator = apiPath.includes("?") ? "&" : "?";
    const response = await this.fetcher(`https://api.weixin.qq.com${apiPath}${separator}access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json() as WechatResponse;
    if (retry && (result.errcode === 40001 || result.errcode === 40014 || result.errcode === 42001)) {
      await this.getAccessToken(accountId, true);
      return this.call(accountId, apiPath, body, false);
    }
    ensureWechatSuccess(response, result, apiPath);
    return result;
  }

  private async uploadMultipart(
    accountId: string,
    apiPath: string,
    bytes: Buffer,
    mimeType: string,
    fileName: string,
    resultField: "url" | "media_id"
  ): Promise<string> {
    const token = await this.getAccessToken(accountId);
    const separator = apiPath.includes("?") ? "&" : "?";
    const form = new FormData();
    form.append("media", new Blob([new Uint8Array(bytes)], { type: mimeType }), fileName);
    const response = await this.fetcher(`https://api.weixin.qq.com${apiPath}${separator}access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      body: form
    });
    const result = await response.json() as WechatResponse;
    ensureWechatSuccess(response, result, apiPath);
    const value = result[resultField];
    if (!value) throw new WechatApiError(`微信没有返回 ${resultField}。`);
    return value;
  }

  private requireJob(id: string): WechatPublishJob {
    const row = this.db.prepare("SELECT * FROM wechat_publish_jobs WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!row) throw new WechatApiError("找不到微信发布任务。");
    return mapJob(row);
  }
}

export interface WechatPublishJob {
  id: string;
  workspaceId: string;
  accountId: string;
  projectId: string | null;
  sourceRelativePath: string | null;
  mode: "draft" | PublishMode;
  title: string;
  draftMediaId: string | null;
  publishId: string | null;
  messageId: string | null;
  status: "draft_ready" | "browser_editing" | "submitted" | "published" | "failed" | "cancelled";
  errorMessage: string | null;
  statusSource: "system" | "wechat" | "browser" | "manual";
  statusNote: string | null;
  declareOriginal: boolean;
  enableReward: boolean;
  collectionName: string;
  createdAt: string;
  updatedAt: string;
}

function mapJob(row: Record<string, string | null>): WechatPublishJob {
  return {
    id: row.id!, workspaceId: row.workspace_id!, accountId: row.account_id!, projectId: row.project_id,
    sourceRelativePath: row.source_relative_path,
    mode: row.mode as WechatPublishJob["mode"], title: row.title!, draftMediaId: row.draft_media_id,
    publishId: row.publish_id, messageId: row.message_id, status: row.status as WechatPublishJob["status"],
    errorMessage: row.error_message,
    statusSource: (row.status_source ?? "system") as WechatPublishJob["statusSource"],
    statusNote: row.status_note,
    declareOriginal: Number(row.declare_original ?? 0) === 1,
    enableReward: Number(row.enable_reward ?? 0) === 1,
    collectionName: row.collection_name ?? "",
    createdAt: row.created_at!, updatedAt: row.updated_at!
  };
}

function ensureWechatSuccess(response: Response, result: WechatResponse, action: string): void {
  if (!response.ok) throw new WechatApiError(`微信接口 ${action} 请求失败（HTTP ${response.status}）。`);
  if (result.errcode != null && result.errcode !== 0) {
    throw new WechatApiError(`微信接口 ${action} 失败：${result.errmsg ?? "未知错误"}（${result.errcode}）`, result.errcode);
  }
}

function parseContentFerryAsset(source: string): { contextId: string; fileName: string } | null {
  const match = /^contentferry-asset:\/\/([A-Za-z0-9_-]{1,100})\/([A-Fa-f0-9-]{36}\.(?:jpg|png|gif|webp))$/i.exec(source);
  return match ? { contextId: match[1], fileName: match[2] } : null;
}

export function markdownToWechatHtml(markdown: string, uploadedImages: Map<string, string> = new Map()): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let codeLines: string[] | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (/^```/.test(line)) {
      if (codeLines) {
        html.push(renderWechatCodeBlock(codeLines));
        codeLines = null;
      } else {
        codeLines = [];
      }
      continue;
    }
    if (codeLines) { codeLines.push(rawLine); continue; }
    if (!line) continue;
    if (isTableRow(line) && isTableDelimiter(lines[index + 1]?.trim() ?? "")) {
      const header = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isTableRow(lines[index].trim())) {
        rows.push(splitTableRow(lines[index].trim()));
        index += 1;
      }
      index -= 1;
      html.push(`<table style="width:100%;border-collapse:collapse;margin:1em 0;font-size:14px;"><thead><tr>${header.map((cell) => `<th style="padding:8px;border:1px solid #d8dee8;background:#f6f8fa;text-align:left;">${inlineMarkdown(cell, uploadedImages)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${header.map((_cell, cellIndex) => `<td style="padding:8px;border:1px solid #d8dee8;vertical-align:top;">${inlineMarkdown(row[cellIndex] ?? "", uploadedImages)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const sourceLevel = heading[1].length;
      const fontSize = [22, 20, 18, 17][sourceLevel - 1];
      const topMargin = sourceLevel === 1 ? "1.6em" : "1.4em";
      // WeChat applies its own typography to native h2/h3/h4 elements and
      // can make them smaller than the 17px article body. A neutral section
      // with explicit inline styles keeps the hierarchy stable in drafts and
      // published articles.
      html.push(`<section style="margin:${topMargin} 0 .65em;font-size:${fontSize}px;font-weight:700;line-height:1.45;color:#1f2329;">${inlineMarkdown(heading[2], uploadedImages)}</section>`);
      continue;
    }
    // Some Markdown editors leave bare list markers behind after deleting
    // an item's text (for example `- ` or `* `). Sending those markers as
    // ordinary paragraphs lets the WeChat editor auto-convert them into
    // empty bullet items, which produces the large blank gaps seen in draft
    // previews. They carry no content, so omit them from the channel HTML.
    if (/^[-*+]\s*$/.test(line) || /^\d+[.)]\s*$/.test(line)) {
      continue;
    }
    const list = /^[-*+]\s+(.+)$/.exec(line);
    const orderedList = /^(\d+)[.)](?:\s+(.*))?$/.exec(line);
    if (list) {
      // Avoid native <ul>/<li>: the WeChat draft editor may normalize
      // adjacent or loose Markdown lists into extra empty list items.
      // An explicit bullet preserves the visual list without giving WeChat
      // any structural list nodes to rewrite.
      html.push(`<p style="display:flex;margin:.55em 0;font-size:17px;line-height:1.8;"><span style="flex:0 0 1.4em;font-weight:600;">•</span><span style="min-width:0;">${inlineMarkdown(list[1], uploadedImages)}</span></p>`);
      continue;
    }
    if (orderedList) {
      // WeChat sanitizes <ol>/<li> inconsistently when a list item contains
      // indented paragraphs or images. Render the source number explicitly so
      // preview, draft editor and the published article keep the same sequence.
      html.push(`<p style="display:flex;margin:.55em 0;font-size:17px;line-height:1.8;"><span style="flex:0 0 2em;font-weight:600;">${orderedList[1]}.</span><span style="min-width:0;">${inlineMarkdown(orderedList[2] ?? "", uploadedImages)}</span></p>`);
      continue;
    }
    if (line.startsWith(">")) {
      html.push(`<blockquote style="margin:1em 0;padding:.6em 1em;border-left:3px solid #07c160;font-size:17px;line-height:1.8;color:#57606a;background:#f6f8fa;">${inlineMarkdown(line.replace(/^>\s?/, ""), uploadedImages)}</blockquote>`);
    } else if (/^<[\w!/]/.test(line)) {
      html.push(rawLine);
    } else {
      html.push(`<p style="margin:.8em 0;font-size:17px;line-height:1.9;">${inlineMarkdown(line, uploadedImages)}</p>`);
    }
  }
  if (codeLines) html.push(renderWechatCodeBlock(codeLines));
  return html.join("\n");
}

function renderWechatCodeBlock(lines: string[]): string {
  // The WeChat draft editor may normalize text-node newlines while saving a
  // draft. Keep the semantic pre/code container, but emit explicit <br/> tags
  // as a second preservation mechanism so a later editor rewrite cannot merge
  // all source lines into one visual line. `pre-wrap` retains indentation and
  // still permits narrow mobile screens to wrap long unbroken lines.
  const content = escapeHtml(lines.join("\n")).replace(/\n/g, "<br/>");
  return `<pre style="overflow:auto;margin:1em 0;padding:1em;border-radius:6px;background:#f6f8fa;line-height:1.6;white-space:pre-wrap;word-break:break-word;"><code style="white-space:inherit;">${content}</code></pre>`;
}

export function removeDuplicateLeadingTitle(markdown: string, title: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const firstContentLine = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentLine < 0) return markdown;
  const heading = /^#\s+(.+?)\s*#*\s*$/.exec(lines[firstContentLine].trim());
  if (!heading || normalizeTitleText(heading[1]) !== normalizeTitleText(title)) return markdown;
  lines.splice(firstContentLine, 1);
  while (firstContentLine < lines.length && lines[firstContentLine].trim() === "") {
    lines.splice(firstContentLine, 1);
  }
  return lines.join("\n");
}

function normalizeTitleText(value: string): string {
  return value
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function withoutFencedCodeBlocks(markdown: string): string {
  return markdown.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, "$1");
}

function isTableRow(line: string): boolean {
  return line.includes("|") && /^\|?.+\|.+\|?$/.test(line);
}

function isTableDelimiter(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line);
}

function splitTableRow(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function inlineMarkdown(value: string, uploadedImages: Map<string, string>): string {
  const images: string[] = [];
  let text = value.replace(/!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_whole, alt: string, source: string) => {
    const url = uploadedImages.get(source) ?? source;
    const token = `\u0000IMG${images.length}\u0000`;
    images.push(`<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" style="display:block;max-width:100%;height:auto;margin:1em auto;" />`);
    return token;
  });
  text = escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, '<code style="padding:.15em .35em;background:#f2f3f5;border-radius:3px;">$1</code>')
    .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>');
  return text.replace(/\u0000IMG(\d+)\u0000/g, (_whole, index: string) => images[Number(index)] ?? "");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Lightweight HTTP client for the Juejin (掘金) content_api.
 *
 * Juejin exposes a JSON REST API under https://api.juejin.cn/content_api/v1/.
 * The write endpoints (draft create/update, publish) do NOT require the
 * anti-crawl signature (msToken / a_bogus) that the read endpoints need, so a
 * plain `fetch` with the user cookie plus the `aid` / `uuid` query parameters
 * is sufficient. The read endpoints that DO require the signature
 * (article/detail) are intentionally avoided; we use list_by_user +
 * article_draft/detail instead, which are signature-free.
 *
 * All errors are normalised into {@link JuejinApiError}.
 */
type FetchLike = typeof fetch;

export class JuejinApiError extends Error {
  constructor(
    message: string,
    readonly errNo?: number,
    readonly errMsg?: string
  ) {
    super(message);
    this.name = "JuejinApiError";
  }
}

export interface JuejinDraftPayload {
  title: string;
  markContent: string;
  briefContent: string;
  categoryId: string;
  tagIds: string[];
  coverImage: string;
  editType: number;
}

export interface JuejinDraft {
  draftId: string;
  articleId: string;
  title: string;
  briefContent: string;
  categoryId: string;
  tagIds: string[];
  coverImage: string;
  markContent: string;
  linkUrl: string;
}

export interface JuejinPublishResult {
  articleId: string;
  draftId: string;
  linkUrl: string;
}

export interface JuejinListEntry {
  articleId: string;
  draftId: string;
  title: string;
}

const API_BASE = "https://api.juejin.cn";
const CONTENT_API = `${API_BASE}/content_api/v1`;
const DEFAULT_AID = "2608";

export class JuejinClient {
  constructor(
    private readonly cookie: string,
    private readonly aid: string = DEFAULT_AID,
    private readonly uuid: string = "",
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = 30_000
  ) {}

  /** Create a draft. Returns the draft id and the assigned article id. */
  async createDraft(payload: JuejinDraftPayload): Promise<JuejinDraft> {
    const data = await this.call<{ id: string; article_id: string }>(
      "article_draft/create",
      {
        title: payload.title,
        mark_content: payload.markContent,
        brief_content: payload.briefContent,
        category_id: String(payload.categoryId),
        tag_ids: payload.tagIds.map(String),
        cover_image: payload.coverImage,
        edit_type: payload.editType,
        html_content: "deprecated"
      }
    );
    return {
      draftId: String(data.id ?? ""),
      articleId: String(data.article_id ?? ""),
      title: payload.title,
      briefContent: payload.briefContent,
      categoryId: String(payload.categoryId),
      tagIds: payload.tagIds.map(String),
      coverImage: payload.coverImage,
      markContent: payload.markContent,
      linkUrl: data.article_id ? `https://juejin.cn/post/${data.article_id}` : ""
    };
  }

  /** Update an existing draft. */
  async updateDraft(draftId: string, payload: JuejinDraftPayload): Promise<JuejinDraft> {
    const data = await this.call<{ id: string; article_id: string }>(
      "article_draft/update",
      {
        id: String(draftId),
        title: payload.title,
        mark_content: payload.markContent,
        brief_content: payload.briefContent,
        category_id: String(payload.categoryId),
        tag_ids: payload.tagIds.map(String),
        cover_image: payload.coverImage,
        edit_type: payload.editType,
        html_content: "deprecated"
      }
    );
    return {
      draftId: String(data.id ?? draftId),
      articleId: String(data.article_id ?? ""),
      title: payload.title,
      briefContent: payload.briefContent,
      categoryId: String(payload.categoryId),
      tagIds: payload.tagIds.map(String),
      coverImage: payload.coverImage,
      markContent: payload.markContent,
      linkUrl: data.article_id ? `https://juejin.cn/post/${data.article_id}` : ""
    };
  }

  /** Publish a previously created draft. */
  async publish(draftId: string): Promise<JuejinPublishResult> {
    const data = await this.call<{ article_id: string; draft_id: string }>("article/publish", {
      draft_id: String(draftId),
      sync_to_org: false,
      column_ids: [],
      theme_ids: []
    });
    const articleId = String(data.article_id ?? "");
    return {
      articleId,
      draftId: String(data.draft_id ?? draftId),
      linkUrl: articleId ? `https://juejin.cn/post/${articleId}` : ""
    };
  }

  /** Fetch a single draft's full content (signature-free endpoint). */
  async getDraft(draftId: string): Promise<JuejinDraft> {
    const data = await this.call<{ article_draft: Record<string, unknown> }>(
      "article_draft/detail",
      { draft_id: String(draftId) }
    );
    const draft = (data.article_draft ?? {}) as Record<string, unknown>;
    const articleInfo = (draft.article_info ?? {}) as Record<string, unknown>;
    const articleId = String(articleInfo.article_id ?? "");
    return {
      draftId: String(draftId),
      articleId,
      title: String(articleInfo.title ?? ""),
      briefContent: String(articleInfo.brief_content ?? ""),
      categoryId: String(articleInfo.category_id ?? ""),
      tagIds: Array.isArray(articleInfo.tag_ids)
        ? (articleInfo.tag_ids as unknown[]).map((t) => String(t))
        : [],
      coverImage: String(articleInfo.cover_image ?? ""),
      markContent: String(articleInfo.mark_content ?? ""),
      linkUrl: articleId ? `https://juejin.cn/post/${articleId}` : ""
    };
  }

  /** List the authenticated user's articles. audit_status/status MUST be null. */
  async listByUser(pageNo = 1, pageSize = 50): Promise<JuejinListEntry[]> {
    const data = await this.call<Array<Record<string, unknown>>>("article/list_by_user", {
      page_no: pageNo,
      page_size: pageSize,
      audit_status: null,
      status: null
    });
    if (!Array.isArray(data)) return [];
    return data.map((entry) => {
      const info = (entry.article_info ?? {}) as Record<string, unknown>;
      return {
        articleId: String(info.article_id ?? ""),
        draftId: String(info.draft_id ?? ""),
        title: String(info.title ?? "")
      };
    });
  }

  /** Resolve the draft id for a published article id. */
  async findDraftId(articleId: string): Promise<string | null> {
    const list = await this.listByUser(1, 100);
    for (const entry of list) {
      if (entry.articleId === String(articleId)) return entry.draftId;
    }
    return null;
  }

  private async call<T>(endpoint: string, body: unknown): Promise<T> {
    const url = new URL(`${CONTENT_API}/${endpoint}`);
    url.searchParams.set("aid", this.aid);
    if (this.uuid) url.searchParams.set("uuid", this.uuid);
    url.searchParams.set("spider", "0");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cookie": this.cookie,
          "user-agent": "ContentFerry/1.0",
          "referer": "https://juejin.cn/editor/drafts"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new JuejinApiError("请求掘金接口超时，请稍后重试。");
      }
      throw new JuejinApiError(`无法连接掘金接口：${cause instanceof Error ? cause.message : "网络错误"}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new JuejinApiError(`掘金接口请求失败（HTTP ${response.status}）。`);
    }

    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new JuejinApiError("掘金接口返回的数据无法解析。");
    }

    const errNo = Number(json.err_no ?? 0);
    if (errNo !== 0) {
      const errMsg = String(json.err_msg ?? "未知错误");
      throw new JuejinApiError(`掘金接口返回错误：${errMsg}`, errNo, errMsg);
    }

    return json.data as T;
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { JuejinApiError, JuejinClient, type JuejinDraftPayload } from "./juejin-client";

function jsonResponse(data: unknown, errNo = 0, errMsg = ""): Response {
  return new Response(JSON.stringify({ err_no: errNo, err_msg: errMsg, data }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function draftPayload(overrides: Partial<JuejinDraftPayload> = {}): JuejinDraftPayload {
  return {
    title: "掘金测试文章",
    markContent: "# 掘金测试文章\n\n正文内容",
    briefContent: "这是一段摘要",
    categoryId: "6809637769959178254",
    tagIds: ["7467857238494020000", "6809641073527226000"],
    coverImage: "",
    editType: 10,
    ...overrides
  };
}

describe("JuejinClient request construction", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function capture(captured: { url: string; headers: Record<string, string>; body: string }) {
    globalThis.fetch = vi.fn(async (input, init) => {
      captured.url = String(input);
      captured.headers = Object.fromEntries(new Headers(init?.headers).entries());
      captured.body = String(init?.body ?? "");
      return jsonResponse({ id: "draft-1", article_id: "article-1" });
    }) as unknown as typeof fetch;
  }

  it("targets the content_api endpoint with aid/uuid/spider query params and cookie header", async () => {
    const captured = { url: "", headers: {} as Record<string, string>, body: "" };
    capture(captured);
    const client = new JuejinClient("sessionid=abc; passport_csrf_token=xyz", "2608", "uuid-123", globalThis.fetch);
    await client.createDraft(draftPayload());

    expect(captured.url).toContain("https://api.juejin.cn/content_api/v1/article_draft/create");
    expect(captured.url).toContain("aid=2608");
    expect(captured.url).toContain("uuid=uuid-123");
    expect(captured.url).toContain("spider=0");
    expect(captured.headers["cookie"]).toContain("sessionid=abc");
    expect(captured.headers["content-type"]).toBe("application/json");
    expect(captured.headers["referer"]).toContain("juejin.cn");
  });

  it("omits uuid from the query string when it is empty", async () => {
    const captured = { url: "", headers: {} as Record<string, string>, body: "" };
    capture(captured);
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch);
    await client.createDraft(draftPayload());
    expect(captured.url).not.toContain("uuid=");
  });

  it("sends the draft payload with string category and string-array tags", async () => {
    const captured = { url: "", headers: {} as Record<string, string>, body: "" };
    capture(captured);
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch);
    await client.createDraft(draftPayload({ tagIds: [7467857238494020000, "tag-b"] }));

    const body = JSON.parse(captured.body) as Record<string, unknown>;
    expect(body.title).toBe("掘金测试文章");
    expect(body.mark_content).toContain("正文内容");
    expect(body.brief_content).toBe("这是一段摘要");
    expect(body.category_id).toBe("6809637769959178254");
    // tag_ids 必须统一转成 string array（detail 返回 number 时也要能转换）。
    expect(body.tag_ids).toEqual(["7467857238494020000", "tag-b"]);
    expect(body.cover_image).toBe("");
    expect(body.edit_type).toBe(10);
    expect(body.html_content).toBe("deprecated");
  });

  it("sends the draft id for article_draft/update", async () => {
    const captured = { url: "", headers: {} as Record<string, string>, body: "" };
    capture(captured);
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch);
    await client.updateDraft("draft-9", draftPayload({ title: "更新后的标题" }));
    expect(captured.url).toContain("/article_draft/update");
    const body = JSON.parse(captured.body) as Record<string, unknown>;
    expect(body.id).toBe("draft-9");
    expect(body.title).toBe("更新后的标题");
  });

  it("sends the publish payload with sync_to_org false and empty column/theme ids", async () => {
    const captured = { url: "", headers: {} as Record<string, string>, body: "" };
    capture(captured);
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch);
    await client.publish("draft-7");
    expect(captured.url).toContain("/article/publish");
    const body = JSON.parse(captured.body) as Record<string, unknown>;
    expect(body.draft_id).toBe("draft-7");
    expect(body.sync_to_org).toBe(false);
    expect(body.column_ids).toEqual([]);
    expect(body.theme_ids).toEqual([]);
  });
});

describe("JuejinClient response parsing", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses createDraft into draft/article ids and a post URL", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ id: "draft-42", article_id: "article-42" })) as unknown as typeof fetch;
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch);
    const draft = await client.createDraft(draftPayload());
    expect(draft.draftId).toBe("draft-42");
    expect(draft.articleId).toBe("article-42");
    expect(draft.linkUrl).toBe("https://juejin.cn/post/article-42");
  });

  it("parses publish into article id and link url", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ article_id: "article-99", draft_id: "draft-42" })) as unknown as typeof fetch;
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch);
    const result = await client.publish("draft-42");
    expect(result.articleId).toBe("article-99");
    expect(result.draftId).toBe("draft-42");
    expect(result.linkUrl).toBe("https://juejin.cn/post/article-99");
  });

  it("parses draft detail from article_draft", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      article_draft: {
        article_info: {
          article_id: "article-5",
          title: "草稿标题",
          brief_content: "摘要",
          category_id: "6809637769959178254",
          tag_ids: [7467857238494020000],
          cover_image: "https://example.com/cover.png",
          mark_content: "# 草稿标题"
        }
      }
    })) as unknown as typeof fetch;
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch);
    const draft = await client.getDraft("draft-5");
    expect(draft.title).toBe("草稿标题");
    expect(draft.articleId).toBe("article-5");
    // detail 返回的 tag_ids 是 number，客户端必须转成 string。
    expect(draft.tagIds).toEqual(["7467857238494020000"]);
    expect(draft.markContent).toBe("# 草稿标题");
  });

  it("sends audit_status/status as null for list_by_user and parses the list", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return jsonResponse([
        { article_info: { article_id: "article-1", draft_id: "draft-1", title: "文章一" } },
        { article_info: { article_id: "article-2", draft_id: "draft-2", title: "文章二" } }
      ]);
    }) as unknown as typeof fetch;
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch);
    const list = await client.listByUser();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ articleId: "article-1", draftId: "draft-1", title: "文章一" });
    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(body.audit_status).toBeNull();
    expect(body.status).toBeNull();
  });

  it("finds the draft id for a published article", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse([
      { article_info: { article_id: "article-1", draft_id: "draft-1", title: "文章一" } },
      { article_info: { article_id: "article-2", draft_id: "draft-2", title: "文章二" } }
    ])) as unknown as typeof fetch;
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch);
    await expect(client.findDraftId("article-2")).resolves.toBe("draft-2");
    await expect(client.findDraftId("article-missing")).resolves.toBeNull();
  });
});

describe("JuejinClient error mapping", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("maps a non-zero err_no to JuejinApiError with errNo and errMsg", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(null, 2, "参数错误")) as unknown as typeof fetch;
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch);
    const error = await client.createDraft(draftPayload()).catch((caught) => caught);
    expect(error).toBeInstanceOf(JuejinApiError);
    expect((error as JuejinApiError).errNo).toBe(2);
    expect((error as JuejinApiError).errMsg).toBe("参数错误");
    expect((error as JuejinApiError).message).toContain("参数错误");
  });

  it("throws on a non-OK HTTP response", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch);
    await expect(client.publish("draft-1")).rejects.toThrow("HTTP 502");
  });

  it("throws a timeout error when the request is aborted", async () => {
    globalThis.fetch = ((_input: unknown, init: RequestInit | undefined) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as unknown as typeof fetch;
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch, 30);
    await expect(client.createDraft(draftPayload())).rejects.toThrow("请求掘金接口超时");
  });

  it("throws a connection error when fetch rejects without abort", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch);
    await expect(client.createDraft(draftPayload())).rejects.toThrow("无法连接掘金接口");
  });

  it("throws when the response is not valid JSON", async () => {
    globalThis.fetch = vi.fn(async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch;
    const client = new JuejinClient("sessionid=abc", "2608", "", globalThis.fetch);
    await expect(client.createDraft(draftPayload())).rejects.toThrow("数据无法解析");
  });
});

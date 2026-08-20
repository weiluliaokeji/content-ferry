import { afterEach, describe, expect, it, vi } from "vitest";
import { CnblogsApiError, CnblogsClient, type CnblogsPostPayload } from "./cnblogs-client";

function rpcResponse(valueXml: string): Response {
  return new Response(
    `<?xml version="1.0"?><methodResponse><params><param><value>${valueXml}</value></param></params></methodResponse>`,
    { status: 200, headers: { "content-type": "text/xml" } }
  );
}

function rpcFault(faultCode: number, faultString: string): Response {
  return new Response(
    `<?xml version="1.0"?><methodResponse><fault><value><struct>` +
      `<member><name>faultCode</name><value><int>${faultCode}</int></value></member>` +
      `<member><name>faultString</name><value><string>${faultString}</string></value></member>` +
      `</struct></value></fault></methodResponse>`,
    { status: 200, headers: { "content-type": "text/xml" } }
  );
}

function extractMethodName(body: string): string {
  return /<methodName>([^<]+)<\/methodName>/.exec(body)?.[1] ?? "";
}

function postPayload(overrides: Partial<CnblogsPostPayload> = {}): CnblogsPostPayload {
  return {
    title: "测试文章",
    description: "# 测试文章\n\n正文内容",
    categories: ["[Markdown]"],
    mt_keywords: "标签A,标签B",
    mt_excerpt: "摘要",
    mt_allow_comments: 1,
    ...overrides
  };
}

describe("CnblogsClient request construction", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("constructs a well-formed XML-RPC methodCall with escaped values", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return rpcResponse("<string>post-42</string>");
    }) as unknown as typeof fetch;

    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch);
    await client.newPost("blog-1", "user<&", "pass", postPayload({ title: "a<b>&c", description: "# a<b>\n\nx&y" }), false);

    expect(capturedBody).toContain("<methodName>metaWeblog.newPost</methodName>");
    expect(capturedBody).toContain("<param><value><string>blog-1</string></value></param>");
    // XML escaping must protect title/description from breaking the payload.
    expect(capturedBody).toContain("<string>a&lt;b&gt;&amp;c</string>");
    expect(capturedBody).toContain("<string>user&lt;&amp;</string>");
    // boolean publish=false is encoded as 0 (independent 5th param, not a struct member).
    expect(capturedBody).toContain("<param><value><boolean>0</boolean></value></param>");
    expect(capturedBody).not.toContain("<name>publish</name>");
    // categories array, int and struct member names are present.
    expect(capturedBody).toContain("<name>categories</name><value><array><data>");
    expect(capturedBody).toContain("<string>[Markdown]</string>");
    expect(capturedBody).toContain("<name>mt_allow_comments</name><value><int>1</int></value>");
    expect(capturedBody).toContain("<name>mt_keywords</name><value><string>标签A,标签B</string></value>");
  });

  it("omits wp_slug when it is empty", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return rpcResponse("<string>post-42</string>");
    }) as unknown as typeof fetch;

    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch);
    await client.newPost("blog-1", "user", "pass", postPayload({ wp_slug: "" }), false);
    expect(capturedBody).not.toContain("wp_slug");
  });

  it("sends binary image bits as a base64 node", async () => {
    let capturedBody = "";
    globalThis.fetch = vi.fn(async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return rpcResponse("<struct><member><name>url</name><value><string>https://img.cnblogs.com/a.png</string></value></member></struct>");
    }) as unknown as typeof fetch;

    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch);
    const result = await client.newMediaObject("blog-1", "user", "pass", {
      name: "a.png",
      type: "image/png",
      bits: Buffer.from([0, 1, 2, 3])
    });

    expect(result.url).toBe("https://img.cnblogs.com/a.png");
    expect(capturedBody).toContain("<methodName>metaWeblog.newMediaObject</methodName>");
    expect(capturedBody).toContain(`<value><base64>${Buffer.from([0, 1, 2, 3]).toString("base64")}</base64></value>`);
  });
});

describe("CnblogsClient response parsing", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses a string response into the newPost post id", async () => {
    globalThis.fetch = vi.fn(async () => rpcResponse("<string>123456</string>")) as unknown as typeof fetch;
    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch);
    await expect(client.newPost("blog-1", "user", "pass", postPayload(), false)).resolves.toBe("123456");
  });

  it("parses a boolean response for editPost", async () => {
    globalThis.fetch = vi.fn(async () => rpcResponse("<boolean>1</boolean>")) as unknown as typeof fetch;
    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch);
    await expect(client.editPost("post-1", "user", "pass", postPayload(), true)).resolves.toBe(true);
  });

  it("parses getUsersBlogs struct array and normalises blog info", async () => {
    globalThis.fetch = vi.fn(async () => rpcResponse(
      "<array><data>" +
        "<value><struct>" +
          "<member><name>blogid</name><value><int>7</int></value></member>" +
          "<member><name>blogName</name><value><string>weiluliaokeji</string></value></member>" +
          "<member><name>url</name><value><string>https://www.cnblogs.com/weiluliaokeji</string></value></member>" +
        "</struct></value>" +
      "</data></array>"
    )) as unknown as typeof fetch;

    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch);
    const blogs = await client.getUsersBlogs("ContentFerry", "user", "pass");
    expect(blogs).toEqual([
      { blogId: "7", blogName: "weiluliaokeji", url: "https://www.cnblogs.com/weiluliaokeji" }
    ]);
  });

  it("throws when the media object response has no url", async () => {
    globalThis.fetch = vi.fn(async () => rpcResponse("<struct></struct>")) as unknown as typeof fetch;
    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch);
    await expect(client.newMediaObject("blog-1", "user", "pass", {
      name: "a.png", type: "image/png", bits: Buffer.from("x")
    })).rejects.toThrow("博客园没有返回图片地址。");
  });
});

describe("CnblogsClient error mapping", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("maps an XML fault to CnblogsApiError with faultCode and faultString", async () => {
    globalThis.fetch = vi.fn(async () => rpcFault(403, "Invalid username or password")) as unknown as typeof fetch;
    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch);
    const error = await client.getUsersBlogs("ContentFerry", "user", "bad-key").catch((caught) => caught);
    expect(error).toBeInstanceOf(CnblogsApiError);
    expect((error as CnblogsApiError).faultCode).toBe(403);
    expect((error as CnblogsApiError).faultString).toBe("Invalid username or password");
    expect((error as CnblogsApiError).message).toContain("Invalid username or password");
  });

  it("throws on a non-OK HTTP response", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch);
    await expect(client.newPost("blog-1", "user", "pass", postPayload(), false))
      .rejects.toThrow("HTTP 502");
  });

  it("throws a timeout error when the request is aborted", async () => {
    globalThis.fetch = ((_input: unknown, init: RequestInit | undefined) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as unknown as typeof fetch;
    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch, 30);
    await expect(client.newPost("blog-1", "user", "pass", postPayload(), false))
      .rejects.toThrow("请求博客园接口超时");
  });

  it("throws a connection error when fetch rejects without abort", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch);
    await expect(client.newPost("blog-1", "user", "pass", postPayload(), false))
      .rejects.toThrow("无法连接博客园接口");
  });

  it("throws XML 无法解析 when the response contains un-decodable entities", async () => {
    // decodeValue decodes &#x110000; via String.fromCodePoint which raises a RangeError
    // (outside the Unicode range); the client must normalise it to CnblogsApiError.
    globalThis.fetch = vi.fn(async () => new Response(
      `<?xml version="1.0"?><methodResponse><params><param><value><string>&#x110000;</string></value></param></params></methodResponse>`,
      { status: 200 }
    )) as unknown as typeof fetch;
    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch);
    await expect(client.newPost("blog-1", "user", "pass", postPayload(), false))
      .rejects.toThrow("XML 无法解析");
  });

  it("throws 缺少响应参数 when the response is not a valid methodResponse", async () => {
    // A non-XML-RPC document parses into a tree without params, so the client
    // reports the missing response param instead of a generic XML error.
    globalThis.fetch = vi.fn(async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch;
    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch);
    await expect(client.newPost("blog-1", "user", "pass", postPayload(), false))
      .rejects.toThrow("缺少响应参数");
  });

  it("throws when the response omits params", async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      `<?xml version="1.0"?><methodResponse></methodResponse>`, { status: 200 }
    )) as unknown as typeof fetch;
    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/test", globalThis.fetch);
    await expect(client.newPost("blog-1", "user", "pass", postPayload(), false))
      .rejects.toThrow("缺少响应参数");
  });

  it("uses the correct endpoint and Content-Type header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return rpcResponse("<string>post-1</string>");
    }) as unknown as typeof fetch;

    const client = new CnblogsClient("https://rpc.cnblogs.com/metaweblog/weiluliaokeji", globalThis.fetch);
    await client.newPost("blog-1", "user", "pass", postPayload(), false);
    expect(capturedUrl).toBe("https://rpc.cnblogs.com/metaweblog/weiluliaokeji");
    expect(capturedHeaders["content-type"]).toBe("text/xml");
    expect(capturedHeaders["user-agent"]).toContain("ContentFerry");
  });
});

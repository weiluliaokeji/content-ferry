import { describe, it, expect, vi } from "vitest";
import {
  BingRssProvider,
  BraveSearchProvider,
  browserHeaders,
  createWebSearchClient,
  DuckDuckGoProvider,
  TavilyProvider,
  normalizeTavilyImages,
  type WebSearchClient,
  type SearchResultItem
} from "./web-search";

// DuckDuckGo HTML uses <a class="result__a"> for titles and
// <a class="result__snippet"> for snippets; links are wrapped in redirect URLs.
const DDG_HTML = `<html><body>
<div class="result">
  <a class="result__a" href="/l/?url=https%3A%2F%2Fexample.com%2Fa">标题 A</a>
  <a class="result__a" href="/l/?url=https%3A%2F%2Fexample.com%2Fb">标题 B</a>
</div>
<a class="result__snippet">摘要 A</a>
<a class="result__snippet">摘要 B</a>
</body></html>`;

const BING_RSS = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Bing 标题 A]]></title><link>https://example.com/bing-a</link><description><![CDATA[Bing 摘要 A]]></description></item>
<item><title>Bing 标题 B</title><link>https://example.com/bing-b</link><description>Bing 摘要 B</description></item>
</channel></rss>`;

const BRAVE_HTML = `<html><body>
<div class="snippet svelte-a" data-pos="0" data-type="web"><div class="result-content"><a href="https://docs.example.com/install?a=1&amp;b=2"><div class="title search-snippet-title" title="官方安装指南">官方安装指南</div></a><div class="generic-snippet"><div class="content">适用于 <strong>Windows</strong> 的安装说明。</div></div></div></div>
<div class="snippet svelte-a" data-pos="1" data-type="web"><div class="result-content"><a href="javascript:alert(1)"><div class="title" title="不安全结果">不安全结果</div></a></div></div>
<div class="snippet svelte-a" data-pos="2" data-type="web"><div class="result-content"><a href="https://docs.example.com/verify"><div class="title search-snippet-title" title="验证安装">验证安装</div></a><div class="generic-snippet"><div class="content">运行版本检查。</div></div></div></div>
</body></html>`;

function jsonFetch(map: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const key = Object.keys(map).find((k) => String(url).includes(k));
    const body = key ? map[key] : { results: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

function htmlFetch(html: string) {
  return vi.fn(async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html" } })
  ) as unknown as typeof fetch;
}

describe("DuckDuckGoProvider", () => {
  it("parses titles, snippets and unwraps redirect URLs", async () => {
    const provider = new DuckDuckGoProvider(htmlFetch(DDG_HTML));
    const items = await provider.search("测试");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "标题 A", url: "https://example.com/a", snippet: "摘要 A" });
    expect(items[1]).toMatchObject({ title: "标题 B", url: "https://example.com/b", snippet: "摘要 B" });
  });

  it("throws WebSearchError when nothing is returned", async () => {
    const provider = new DuckDuckGoProvider(htmlFetch("<html><body>无结果</body></html>"));
    await expect(provider.search("测试")).rejects.toThrow(/未返回可用结果/);
  });

  it("throws a clear error on DuckDuckGo's anti-bot anomaly page", async () => {
    const provider = new DuckDuckGoProvider(htmlFetch("<html><body>anomaly detection triggered</body></html>"));
    await expect(provider.search("测试")).rejects.toThrow(/反爬虫验证页|TAVILY_API_KEY/);
  });

  it("retries with a rotated profile and recovers after an initial anomaly page", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls < 2) {
        return new Response("<html>anomaly detection triggered</html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(DDG_HTML, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const provider = new DuckDuckGoProvider(fetchImpl);
    const items = await provider.search("测试");
    expect(items).toHaveLength(2);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("is always available and supports both capabilities", () => {
    const provider = new DuckDuckGoProvider();
    expect(provider.isAvailable()).toBe(true);
    expect(provider.supportsSearch()).toBe(true);
    expect(provider.supportsExtract()).toBe(true);
  });
});

describe("BingRssProvider", () => {
  it("parses RSS results without an API key", async () => {
    const provider = new BingRssProvider(htmlFetch(BING_RSS));
    const items = await provider.search("测试");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "Bing 标题 A", url: "https://example.com/bing-a", snippet: "Bing 摘要 A" });
  });
});

describe("BraveSearchProvider", () => {
  it("parses server-rendered web results and drops unsafe links", async () => {
    const provider = new BraveSearchProvider(htmlFetch(BRAVE_HTML));
    const items = await provider.search("测试", 5);
    expect(items).toEqual([
      { title: "官方安装指南", url: "https://docs.example.com/install?a=1&b=2", snippet: "适用于 Windows 的安装说明。" },
      { title: "验证安装", url: "https://docs.example.com/verify", snippet: "运行版本检查。" }
    ]);
  });

  it("reports an empty or changed result page so the client can continue its fallback chain", async () => {
    await expect(new BraveSearchProvider(htmlFetch("<html><body>无可用搜索结果</body></html>")).search("测试"))
      .rejects.toThrow(/Brave 未返回可用搜索结果/);
  });
});

describe("TavilyProvider", () => {
  it("maps search results (content → snippet) and is available only with a key", async () => {
    const fetchImpl = jsonFetch({ "tavily.com/search": { results: [{ title: "T 结果", url: "https://tavily.com/x", content: "T 摘要" }] } });
    const provider = new TavilyProvider("tvly-xxx", fetchImpl);
    expect(provider.isAvailable()).toBe(true);
    const items = await provider.search("测试");
    expect(items[0]).toMatchObject({ title: "T 结果", url: "https://tavily.com/x", snippet: "T 摘要" });
  });

  it("is unavailable without an api key", () => {
    expect(new TavilyProvider("").isAvailable()).toBe(false);
  });

  it("requests and normalizes query images with source metadata", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.include_images).toBe(true);
      expect(body.include_image_descriptions).toBe(true);
      return new Response(JSON.stringify({
        images: [{ url: "https://cdn.example.com/query.png", description: "查询图片" }],
        results: [{
          title: "来源页面",
          url: "https://example.com/article",
          images: [{ url: "https://cdn.example.com/page.png", thumbnail_url: "https://cdn.example.com/thumb.png", description: "页面图片" }]
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const items = await new TavilyProvider("tvly-xxx", fetchImpl).searchImages("测试图片", 10);
    expect(items).toEqual([
      { imageUrl: "https://cdn.example.com/query.png", thumbnailUrl: null, caption: "查询图片", sourceUrl: null, sourceTitle: null },
      { imageUrl: "https://cdn.example.com/page.png", thumbnailUrl: "https://cdn.example.com/thumb.png", caption: "页面图片", sourceUrl: "https://example.com/article", sourceTitle: "来源页面" }
    ]);
  });

  it("drops unsafe or duplicate Tavily image URLs", () => {
    expect(normalizeTavilyImages({ images: [
      { url: "javascript:alert(1)" },
      { url: "https://example.com/a.png" },
      { url: "https://example.com/a.png" },
      "not-a-url"
    ] })).toEqual([{ imageUrl: "https://example.com/a.png", thumbnailUrl: null, caption: "", sourceUrl: null, sourceTitle: null }]);
  });
});

describe("createWebSearchClient registry + fallback", () => {
  it("reads the raw version of a public GitHub document when its HTML page fails", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).startsWith("https://github.com/")) return new Response("unavailable", { status: 503 });
      if (String(url) === "https://raw.githubusercontent.com/Example/Docs/main/README.md") {
        return new Response("# Installation\nRun `example install`.", { status: 200 });
      }
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;
    const client = createWebSearchClient({ fetchImpl });
    await expect(client.extract("https://github.com/Example/Docs/blob/main/README.md"))
      .resolves.toEqual({ content: "# Installation\nRun `example install`." });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not substitute a different host for unrelated extraction failures", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    const client = createWebSearchClient({ fetchImpl });
    await expect(client.extract("https://example.com/docs"))
      .rejects.toThrow(/HTTP 503/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects non-web extraction schemes before sending the URL to any provider", async () => {
    const fetchImpl = vi.fn(async () => new Response("should not run", { status: 200 })) as unknown as typeof fetch;
    const client = createWebSearchClient({ tavilyApiKey: "test-key", fetchImpl });

    await expect(client.extract("file:///C:/Users/example/private.txt"))
      .rejects.toThrow(/只支持 HTTP 或 HTTPS/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses DuckDuckGo (zero-key) when no Tavily key is configured", async () => {
    const client = createWebSearchClient({ fetchImpl: htmlFetch(DDG_HTML) });
    expect(client.activeProviderId).toBeNull();
    const items = await client.search("测试");
    expect(client.activeProviderId).toBe("duckduckgo");
    expect(items.length).toBeGreaterThan(0);
  });

  it("gives Tavily priority over DuckDuckGo when a key is present", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("tavily.com")) {
        return new Response(
          JSON.stringify({ results: [{ title: "T 结果", url: "https://tavily.com/x", content: "T 摘要" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(DDG_HTML, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;

    const client = createWebSearchClient({ tavilyApiKey: "tvly-xxx", fetchImpl });
    const items = await client.search("测试");
    expect(client.activeProviderId).toBe("tavily");
    expect(items[0]).toMatchObject({ title: "T 结果", url: "https://tavily.com/x" });
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes("tavily.com"))).toBe(true);
  });

  it("falls back when one public search provider fails", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("bing.com")) return new Response("<html>blocked</html>", { status: 200 });
      return new Response(DDG_HTML, { status: 200, headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const client = createWebSearchClient({ fetchImpl });
    const items = await client.search("测试");
    expect(client.activeProviderId).toBe("duckduckgo");
    expect(items).toHaveLength(2);
  });

  it("uses Brave before Bing and DuckDuckGo when its public results are available", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("search.brave.com")) return new Response(BRAVE_HTML, { status: 200, headers: { "content-type": "text/html" } });
      return new Response("<html>blocked</html>", { status: 503 });
    }) as unknown as typeof fetch;
    const client = createWebSearchClient({ fetchImpl });
    const items = await client.search("测试");
    expect(client.activeProviderId).toBe("brave-search");
    expect(items[0].title).toBe("官方安装指南");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects results outside a requested site before accepting a search provider", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("bing.com")) return new Response(
        '<rss><channel><item><title>无关页面</title><link>https://example.net/other</link><description>摘要</description></item></channel></rss>',
        { status: 200 });
      return new Response(`<html><body><div class="result"><a class="result__a" href="/l/?url=https%3A%2F%2Fgithub.com%2FExample%2FDocs%2Fblob%2Fmain%2FREADME.md">官方文件</a></div><a class="result__snippet">摘要</a></body></html>`,
        { status: 200 });
    }) as unknown as typeof fetch;
    const client = createWebSearchClient({ fetchImpl });
    const items = await client.search("site:github.com/Example/Docs installation");
    expect(items.map((item) => item.url)).toEqual(["https://github.com/Example/Docs/blob/main/README.md"]);
    expect(client.activeProviderId).toBe("duckduckgo");
  });

  it("surfaces an actionable error only after all providers fail", async () => {
    const failFetch = vi.fn(async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    const client = createWebSearchClient({ fetchImpl: failFetch });
    await expect(client.search("测试")).rejects.toThrow(/已尝试 brave-search、bing-rss、duckduckgo/);
  });

  it("keeps the explicit research-proxy option isolated from the fetch impl", async () => {
    // The proxy resolver must be accepted and must NOT override an explicitly
    // provided fetchImpl (the proxy path is only taken when no fetchImpl is set).
    const client = createWebSearchClient({
      getResearchProxyUrl: () => "http://127.0.0.1:7890",
      fetchImpl: htmlFetch(DDG_HTML)
    });
    const items = await client.search("测试");
    expect(client.activeProviderId).toBe("duckduckgo");
    expect(items.length).toBeGreaterThan(0);
  });

  it("uses the injected system-network route when the research proxy is empty", async () => {
    const systemFetchImpl = htmlFetch(DDG_HTML);
    const client = createWebSearchClient({ getResearchProxyUrl: () => "", systemFetchImpl });

    const items = await client.search("测试");

    expect(items).toHaveLength(2);
    expect(systemFetchImpl).toHaveBeenCalled();
  });

  it("falls back to the system-network route when the configured research proxy is invalid", async () => {
    const systemFetchImpl = htmlFetch(DDG_HTML);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createWebSearchClient({ getResearchProxyUrl: () => "not a proxy URL", systemFetchImpl });

    const items = await client.search("测试");

    expect(items).toHaveLength(2);
    expect(systemFetchImpl).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("使用系统网络路线"));
    expect(warn.mock.calls.flat().join(" ")).not.toContain("not a proxy URL");
    warn.mockRestore();
  });

  it("requires Tavily for image candidates instead of silently using text search", async () => {
    const client = createWebSearchClient({ fetchImpl: htmlFetch(DDG_HTML) });
    await expect(client.searchImages?.("测试图片")).rejects.toThrow(/配置 Tavily/);
  });
});

describe("browserHeaders consistency-first fingerprint", () => {
  it("defaults sec-fetch-site to cross-site for cross-origin GETs", () => {
    expect(browserHeaders(0)["sec-fetch-site"]).toBe("cross-site");
  });

  it("emits same-origin for the DuckDuckGo form POST to its own host", () => {
    expect(browserHeaders(0, "same-origin")["sec-fetch-site"]).toBe("same-origin");
    expect(browserHeaders(0, "same-origin")["sec-fetch-mode"]).toBe("navigate");
  });
});

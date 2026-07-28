import { describe, it, expect, vi } from "vitest";
import {
  createWebSearchClient,
  DuckDuckGoProvider,
  TavilyProvider,
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

  it("is always available and supports both capabilities", () => {
    const provider = new DuckDuckGoProvider();
    expect(provider.isAvailable()).toBe(true);
    expect(provider.supportsSearch()).toBe(true);
    expect(provider.supportsExtract()).toBe(true);
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
});

describe("createWebSearchClient registry + fallback", () => {
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

  it("surfaces WebSearchError when the selected provider fails", async () => {
    const failFetch = vi.fn(async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    const client = createWebSearchClient({ fetchImpl: failFetch });
    await expect(client.search("测试")).rejects.toThrow(/DuckDuckGo 检索失败/);
  });
});

/**
 * App-owned web retrieval layer for 联网资料补研.
 *
 * This decouples research from any single model: retrieval (search + fetch) is
 * performed by pluggable providers behind a small registry, so the synthesis
 * step can run on *any* configured text model — not just OpenAI Codex.
 *
 * Providers declare capability flags (supportsSearch / supportsExtract) and the
 * client picks the first available one per capability. The fallback chain is
 * Tavily (when an API key is present) → DuckDuckGo (zero-key, always available).
 */

import { ProxyAgent, fetch as undiciFetch } from "undici";

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  readonly id: string;
  isAvailable(): boolean;
  supportsSearch(): boolean;
  supportsExtract(): boolean;
  search(query: string, limit?: number): Promise<SearchResultItem[]>;
  extract(url: string): Promise<{ content: string }>;
}

export interface WebSearchClient {
  /** Run a web search, returning cleaned result items. */
  search(query: string, limit?: number): Promise<SearchResultItem[]>;
  /** Fetch a single URL and return its main text content. */
  extract(url: string): Promise<{ content: string }>;
  /** The provider id that handled the most recent search (for diagnostics). */
  readonly activeProviderId: string | null;
}

export class WebSearchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebSearchError";
  }
}

type FetchImpl = typeof fetch;

const DEFAULT_TIMEOUT_MS = 20_000;

function safeFetch(fetchImpl: FetchImpl, url: string, init?: RequestInit): Promise<Response> {
  return fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "accept-language": "zh-CN,zh;q=0.9",
      ...(init?.headers ?? {})
    }
  });
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** DuckDuckGo HTML result links are wrapped in redirect URLs; unwrap them. */
function decodeDdgUrl(href: string): string {
  try {
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) {
      const b64 = uddg[1].replace(/-/g, "+").replace(/_/g, "/");
      return decodeURIComponent(Buffer.from(b64, "base64").toString("utf8"));
    }
    const urlParam = /[?&]url=([^&]+)/.exec(href);
    if (urlParam) return decodeURIComponent(urlParam[1]);
  } catch {
    /* fall through */
  }
  return href;
}

function parseDuckDuckGoResults(html: string, limit: number): SearchResultItem[] {
  const titleRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const titles: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html))) titles.push({ url: decodeDdgUrl(m[1]), title: stripTags(m[2]) });
  while ((m = snippetRe.exec(html))) snippets.push(stripTags(m[1]));
  const items: SearchResultItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < titles.length && items.length < limit; i++) {
    const url = titles[i].url;
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    items.push({ title: titles[i].title || url, url, snippet: snippets[i] ?? "" });
  }
  return items;
}

export class DuckDuckGoProvider implements WebSearchProvider {
  readonly id = "duckduckgo";
  constructor(private readonly fetchImpl: FetchImpl = fetch) {}

  isAvailable(): boolean {
    return true;
  }
  supportsSearch(): boolean {
    return true;
  }
  supportsExtract(): boolean {
    return true;
  }

  async search(query: string, limit = 8): Promise<SearchResultItem[]> {
    // Use the POST endpoint at html.duckduckgo.com — the GET form on duckduckgo.com
    // now returns a 202 anti-bot "anomaly" challenge page instead of results.
    const body = new URLSearchParams({ q: query, kl: "cn-zh" }).toString();
    const res = await safeFetch(this.fetchImpl, "https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    if (!res.ok) throw new WebSearchError(`DuckDuckGo 检索失败（HTTP ${res.status}）。`);
    const html = await res.text();
    if (/anomaly/i.test(html) || res.status === 202) {
      throw new WebSearchError(
        "DuckDuckGo 返回了反爬虫验证页，无法自动检索。请配置 Tavily 搜索服务（设置 TAVILY_API_KEY 环境变量），或在「技能与模型」里为模型连接配置网络代理后重试。"
      );
    }
    const items = parseDuckDuckGoResults(html, limit);
    if (items.length === 0) {
      throw new WebSearchError("DuckDuckGo 未返回可用结果，请换个检索词，或配置 Tavily 搜索服务（设置 TAVILY_API_KEY 环境变量）。");
    }
    return items;
  }

  async extract(targetUrl: string): Promise<{ content: string }> {
    const res = await safeFetch(this.fetchImpl, targetUrl);
    if (!res.ok) throw new WebSearchError(`无法抓取页面（HTTP ${res.status}）。`);
    const html = await res.text();
    return { content: truncate(stripTags(html), 6000) };
  }
}

export class TavilyProvider implements WebSearchProvider {
  readonly id = "tavily";
  constructor(private readonly apiKey: string, private readonly fetchImpl: FetchImpl = fetch) {}

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }
  supportsSearch(): boolean {
    return true;
  }
  supportsExtract(): boolean {
    return true;
  }

  async search(query: string, limit = 8): Promise<SearchResultItem[]> {
    const res = await safeFetch(this.fetchImpl, "https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: limit,
        search_depth: "advanced",
        include_raw_content: false
      })
    });
    if (!res.ok) throw new WebSearchError(`Tavily 检索失败（HTTP ${res.status}）。`);
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const results = (data.results ?? []).filter((r) => r.url).slice(0, limit);
    if (results.length === 0) throw new WebSearchError("Tavily 未返回可用结果，请换个检索词。");
    return results.map((r) => ({
      title: r.title?.trim() || r.url!,
      url: r.url!,
      snippet: truncate((r.content ?? "").trim(), 2000)
    }));
  }

  async extract(targetUrl: string): Promise<{ content: string }> {
    const res = await safeFetch(this.fetchImpl, "https://api.tavily.com/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey, urls: [targetUrl] })
    });
    if (res.ok) {
      const data = (await res.json()) as { results?: Array<{ raw_content?: string; content?: string }> };
      const text = data.results?.[0]?.raw_content ?? data.results?.[0]?.content;
      if (text) return { content: truncate(text, 6000) };
    }
    // Fall back to a plain fetch if the dedicated extract endpoint is unavailable.
    const plain = await safeFetch(this.fetchImpl, targetUrl);
    if (!plain.ok) throw new WebSearchError(`无法抓取页面（HTTP ${plain.status}）。`);
    return { content: truncate(stripTags(await plain.text()), 6000) };
  }
}

export interface CreateWebSearchClientOptions {
  tavilyApiKey?: string;
  fetchImpl?: FetchImpl;
  /** Static proxy URL (e.g. http://127.0.0.1:7890). Used for all outbound requests. */
  proxyUrl?: string;
  /** Resolver returning the current proxy URL; consulted on every request so changes
   *  take effect without restarting the process. Takes precedence over `proxyUrl`. */
  getProxyUrl?: () => string | undefined;
}

export function createWebSearchClient(options: CreateWebSearchClientOptions = {}): WebSearchClient {
  const fallbackFetch = options.fetchImpl ?? fetch;
  const resolveProxy = options.getProxyUrl ?? (() => options.proxyUrl ?? undefined);
  // Route every provider request through a proxy-aware fetcher so the search layer
  // honors the same network proxy the user configured for model connections.
  const fetchWithProxy: FetchImpl = (url, init) => {
    const proxy = resolveProxy()?.trim();
    if (proxy) return undiciFetch(url as string | URL, { ...init, dispatcher: new ProxyAgent(proxy) } as Parameters<typeof undiciFetch>[1]);
    return fallbackFetch(url, init);
  };
  const providers: WebSearchProvider[] = [];
  if (options.tavilyApiKey) providers.push(new TavilyProvider(options.tavilyApiKey, fetchWithProxy));
  providers.push(new DuckDuckGoProvider(fetchWithProxy));

  const pick = (capability: "supportsSearch" | "supportsExtract"): WebSearchProvider | null => {
    for (const provider of providers) {
      if (provider.isAvailable() && provider[capability]()) return provider;
    }
    return null;
  };

  let lastSearchProvider: string | null = null;
  return {
    get activeProviderId() {
      return lastSearchProvider;
    },
    async search(query, limit = 8) {
      const provider = pick("supportsSearch");
      if (!provider) throw new WebSearchError("未配置可用的联网检索服务。");
      lastSearchProvider = provider.id;
      return provider.search(query, limit);
    },
    async extract(targetUrl) {
      const provider = pick("supportsExtract");
      if (!provider) throw new WebSearchError("未配置可用的网页抓取服务。");
      return provider.extract(targetUrl);
    }
  };
}

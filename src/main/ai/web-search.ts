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

export type VisibleBrowserSearch = (query: string, limit: number) => Promise<SearchResultItem[]>;

export class WebSearchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebSearchError";
  }
}

export class BrowserVerificationRequiredError extends WebSearchError {
  constructor(message = "联网检索页面需要人工完成验证。文渡已打开持久浏览器窗口，请完成验证后回到资料窗口重试。") {
    super(message);
    this.name = "BrowserVerificationRequiredError";
  }
}

type FetchImpl = typeof fetch;

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Consistent, browser-like request header profile. This is the fetch-world
 * port of gstack's "consistency-first fingerprint" stealth: instead of a thin
 * or mismatched header set (which anti-bot filters flag), we send a *coherent*
 * Chrome fingerprint where the User-Agent, Client Hints (sec-ch-ua*) and
 * sec-fetch-* all agree with each other. `variant` rotates the Chrome build so
 * repeated requests don't all collapse to one identical tell.
 *
 * gstack's full stealth (navigator.webdriver mask, window.chrome.* shape, WebGL
 * spoof, …) is a Chromium page init-script and has no meaning in a raw fetch —
 * there is no DOM/JS runtime to deceive. The header discipline + cookie
 * persistence below are the parts that *are* portable to a fetch scraper.
 */
const BROWSER_PROFILES: ReadonlyArray<{
  ua: string;
  chUa: string;
  chUaFull: string;
  platform: string;
}> = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    chUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    chUaFull: '"Google Chrome";v="124.0.0.0"',
    platform: '"Windows"'
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    chUa: '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
    chUaFull: '"Google Chrome";v="126.0.0.0"',
    platform: '"Windows"'
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    chUa: '"Chromium";v="128", "Google Chrome";v="128", "Not-A.Brand";v="99"',
    chUaFull: '"Google Chrome";v="128.0.0.0"',
    platform: '"Windows"'
  }
];

export function browserHeaders(
  variant = 0,
  fetchSite: "cross-site" | "same-origin" = "cross-site"
): Record<string, string> {
  const p = BROWSER_PROFILES[variant % BROWSER_PROFILES.length];
  return {
    "user-agent": p.ua,
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "accept-encoding": "gzip, deflate, br",
    "sec-ch-ua": p.chUa,
    "sec-ch-ua-full-version-list": p.chUaFull,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": p.platform,
    "sec-fetch-site": fetchSite,
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "upgrade-insecure-requests": "1",
    "connection": "keep-alive"
  };
}

function safeFetch(fetchImpl: FetchImpl, url: string, init?: RequestInit): Promise<Response> {
  return fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: {
      ...browserHeaders(0),
      ...(init?.headers ?? {})
    }
  });
}

/**
 * Build a fetch implementation that routes through the global research proxy
 * (an explicit, app-wide setting) when one is configured, and falls back to a
 * direct native fetch otherwise. The proxy is resolved lazily on every call so
 * a settings change takes effect without restarting the local service.
 *
 * A model connection's own proxy must never leak into research traffic — that
 * was the earlier bug (a hardcoded `gemini` proxy redirected all searches to a
 * dead local port). The research proxy is deliberately independent from any
 * model setting and only active when the user explicitly provides one here.
 */
function makeProxyAwareFetch(getProxyUrl?: () => string | undefined): FetchImpl {
  if (!getProxyUrl) return fetch;
  let cachedAgent: ProxyAgent | null = null;
  let cachedProxy = "";
  const resolveAgent = (): ProxyAgent | null => {
    const proxy = getProxyUrl()?.trim() ?? "";
    if (!proxy) return null;
    if (cachedAgent && cachedProxy === proxy) return cachedAgent;
    try {
      // Validate the URL up front; an invalid proxy must not crash research —
      // degrade to a direct connection and warn instead.
      new URL(proxy);
      cachedAgent = new ProxyAgent(proxy);
      cachedProxy = proxy;
      return cachedAgent;
    } catch {
      console.warn(`[contentferry] 检索代理地址无效，已忽略并直连：${proxy}`);
      cachedAgent = null;
      cachedProxy = proxy;
      return null;
    }
  };
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const agent = resolveAgent();
    if (!agent) return fetch(input, init);
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1]);
  };
}

/**
 * Minimal cookie jar — the fetch-world port of gstack's "persist credentials to
 * avoid repeat verification" layer. DuckDuckGo issues a few cookies (region
 * `kl`, a session id) on first contact; replaying them makes subsequent
 * requests look like a returning visitor rather than a fresh scraper. In-memory
 * per provider instance (survives the multi-round research loop); the
 * human-verification path carries the durable session instead.
 */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  ingest(response: Response): void {
    const headers = response.headers as unknown as { getSetCookie?: () => string[] };
    const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const eq = sc.indexOf("=");
      if (eq <= 0) continue;
      const name = sc.slice(0, eq).trim();
      const value = sc.slice(eq + 1).split(";")[0].trim();
      if (name) this.cookies.set(name, value);
    }
  }

  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    const parts: string[] = [];
    this.cookies.forEach((value, name) => parts.push(`${name}=${value}`));
    return parts.join("; ");
  }

  clear(): void {
    this.cookies.clear();
  }
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

const MAX_DDG_ATTEMPTS = 3;

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
    // Layered bypass, mirroring gstack's "lightweight disguise → escalate"
    // logic. Each attempt (1) rotates the Chrome build via header variant and
    // (2) drops any cookies so a flagged session can't poison the retry. If the
    // request succeeds we ingest DDG's cookies so later rounds look like a
    // returning visitor. Only after every attempt hits the anomaly page do we
    // throw — the client then falls back to Bing/Tavily.
    const jar = new CookieJar();
    let lastError: Error = new WebSearchError("DuckDuckGo 检索失败。");
    for (let attempt = 0; attempt < MAX_DDG_ATTEMPTS; attempt++) {
      const headers: Record<string, string> = {
        ...browserHeaders(attempt, "same-origin"),
        "content-type": "application/x-www-form-urlencoded"
      };
      const cookie = jar.header();
      if (cookie) headers.cookie = cookie;
      const body = new URLSearchParams({ q: query, kl: "cn-zh" }).toString();
      let res: Response;
      try {
        res = await safeFetch(this.fetchImpl, "https://html.duckduckgo.com/html/", {
          method: "POST",
          headers,
          body
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new WebSearchError(String(error));
        jar.clear();
        continue;
      }
      if (!res.ok) {
        lastError = new WebSearchError(`DuckDuckGo 检索失败（HTTP ${res.status}）。`);
        jar.clear();
        continue;
      }
      jar.ingest(res);
      const html = await res.text();
      if (/anomaly/i.test(html) || res.status === 202) {
        lastError = new WebSearchError(
          "DuckDuckGo 返回了反爬虫验证页。文渡会自动改用其他搜索源；若仍失败，请稍后重试或配置 Tavily 搜索服务（TAVILY_API_KEY）。"
        );
        jar.clear();
        continue;
      }
      const items = parseDuckDuckGoResults(html, limit);
      if (items.length === 0) {
        throw new WebSearchError("DuckDuckGo 未返回可用结果，请换个检索词，或在“技能与模型 → 联网检索服务”配置 Tavily。");
      }
      return items;
    }
    throw lastError;
  }

  async extract(targetUrl: string): Promise<{ content: string }> {
    const res = await safeFetch(this.fetchImpl, targetUrl);
    if (!res.ok) throw new WebSearchError(`无法抓取页面（HTTP ${res.status}）。`);
    const html = await res.text();
    return { content: truncate(stripTags(html), 6000) };
  }
}

function parseBingRssResults(xml: string, limit: number): SearchResultItem[] {
  const items: SearchResultItem[] = [];
  const seen = new Set<string>();
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) && items.length < limit) {
    const title = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(match[1])?.[1];
    const url = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i.exec(match[1])?.[1]?.trim();
    const description = /<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i.exec(match[1])?.[1];
    if (!url || !/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    items.push({
      title: stripTags(title ?? url),
      url,
      snippet: stripTags(description ?? "")
    });
  }
  return items;
}

/** A no-key search fallback for cases where the DuckDuckGo HTML endpoint
 * returns an anti-bot challenge. */
export class BingRssProvider implements WebSearchProvider {
  readonly id = "bing-rss";
  constructor(private readonly fetchImpl: FetchImpl = fetch) {}

  isAvailable(): boolean { return true; }
  supportsSearch(): boolean { return true; }
  supportsExtract(): boolean { return false; }

  async search(query: string, limit = 8): Promise<SearchResultItem[]> {
    const url = `https://www.bing.com/search?format=rss&setlang=zh-Hans&q=${encodeURIComponent(query)}`;
    const res = await safeFetch(this.fetchImpl, url);
    if (!res.ok) throw new WebSearchError(`Bing RSS 检索失败（HTTP ${res.status}）。`);
    const items = parseBingRssResults(await res.text(), limit);
    if (items.length === 0) throw new WebSearchError("Bing RSS 未返回可用结果。");
    return items;
  }

  async extract(): Promise<{ content: string }> {
    throw new WebSearchError("Bing RSS 不支持网页正文抓取。");
  }
}

class VisibleBrowserSearchProvider implements WebSearchProvider {
  readonly id = "visible-browser";
  constructor(private readonly searchInBrowser: VisibleBrowserSearch) {}
  isAvailable(): boolean { return true; }
  supportsSearch(): boolean { return true; }
  supportsExtract(): boolean { return false; }
  search(query: string, limit = 8): Promise<SearchResultItem[]> { return this.searchInBrowser(query, limit); }
  async extract(): Promise<{ content: string }> { throw new WebSearchError("可见浏览器检索不支持网页正文抓取。"); }
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
  /** Resolves the locally stored key at request time, so saving a key in the
   * application takes effect without restarting the local service. */
  getTavilyApiKey?: () => string | undefined;
  /** Resolves the global research-proxy URL at request time (independent from
   * any model connection's proxy). Empty/blank means direct connection. */
  getResearchProxyUrl?: () => string | undefined;
  visibleBrowserSearch?: VisibleBrowserSearch;
  fetchImpl?: FetchImpl;
}

export function createWebSearchClient(options: CreateWebSearchClientOptions = {}): WebSearchClient {
  // Web research is app-owned traffic. A proxy configured for one model connection
  // must never silently redirect searches performed for another model or skill.
  // The global research-proxy (if the user sets one) is explicit and independent
  // from model settings; when unset, searches go direct.
  const directFetch = options.fetchImpl ?? makeProxyAwareFetch(options.getResearchProxyUrl);
  const getProviders = (): WebSearchProvider[] => {
    const providers: WebSearchProvider[] = [];
    const tavilyApiKey = options.getTavilyApiKey?.()?.trim() || options.tavilyApiKey?.trim();
    if (tavilyApiKey) providers.push(new TavilyProvider(tavilyApiKey, directFetch));
    providers.push(new BingRssProvider(directFetch));
    providers.push(new DuckDuckGoProvider(directFetch));
    if (options.visibleBrowserSearch) providers.push(new VisibleBrowserSearchProvider(options.visibleBrowserSearch));
    return providers;
  };

  const pick = (capability: "supportsSearch" | "supportsExtract"): WebSearchProvider | null => {
    for (const provider of getProviders()) {
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
      const searchProviders = getProviders().filter((provider) => provider.isAvailable() && provider.supportsSearch());
      if (searchProviders.length === 0) throw new WebSearchError("未配置可用的联网检索服务。");
      const errors: string[] = [];
      for (const provider of searchProviders) {
        try {
          const results = await provider.search(query, limit);
          lastSearchProvider = provider.id;
          return results;
        } catch (error) {
          // Human handoff (visible browser, gstack Layer 3) must surface verbatim
          // so the UI can instruct the user to complete verification in the opened
          // window — it must not be absorbed into the generic aggregated failure.
          if (error instanceof BrowserVerificationRequiredError) throw error;
          errors.push(`${provider.id}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      throw new WebSearchError(
        `联网检索暂时不可用。已尝试 ${searchProviders.map((provider) => provider.id).join("、")}。${errors.join(" ")} 可稍后重试；若需要更稳定的检索，可配置 Tavily 搜索服务（TAVILY_API_KEY）。`
      );
    },
    async extract(targetUrl) {
      const provider = pick("supportsExtract");
      if (!provider) throw new WebSearchError("未配置可用的网页抓取服务。");
      return provider.extract(targetUrl);
    }
  };
}

export type ResearchProxyConfig = { mode: "system" } | { proxyRules: string };

const SUPPORTED_RESEARCH_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:"]);

/** Resolve the app-specific research proxy without losing the OS route. */
export function resolveResearchProxyConfig(value: string | undefined): ResearchProxyConfig {
  const proxy = value?.trim() ?? "";
  if (!proxy) return { mode: "system" };

  try {
    const parsed = new URL(proxy);
    if (SUPPORTED_RESEARCH_PROXY_PROTOCOLS.has(parsed.protocol)) return { proxyRules: proxy };
  } catch {
    // Invalid values preserve the user's Windows proxy/PAC route.
  }

  return { mode: "system" };
}

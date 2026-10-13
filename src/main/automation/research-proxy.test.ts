import { describe, expect, it } from "vitest";
import { resolveResearchProxyConfig } from "./research-proxy";

describe("resolveResearchProxyConfig", () => {
  it("uses Windows system proxy and PAC when no app proxy is configured", () => {
    expect(resolveResearchProxyConfig(undefined)).toEqual({ mode: "system" });
    expect(resolveResearchProxyConfig("  ")).toEqual({ mode: "system" });
  });

  it("uses a valid app-specific research proxy", () => {
    expect(resolveResearchProxyConfig(" socks5://127.0.0.1:1080 "))
      .toEqual({ proxyRules: "socks5://127.0.0.1:1080" });
  });

  it("falls back to Windows system networking for invalid or unsupported proxy values", () => {
    expect(resolveResearchProxyConfig("not a proxy URL")).toEqual({ mode: "system" });
    expect(resolveResearchProxyConfig("file://proxy-config")).toEqual({ mode: "system" });
  });
});

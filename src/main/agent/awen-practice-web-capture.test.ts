import { describe, expect, it } from "vitest";
import { assertPublicWebRequestRoute, canOpenManualHandoverPopup, isAllowedManualHandoverNavigation, isAuthenticationChallenge, isAuthenticationPost, isPrivateOrSpecialAddress, shareableOperationSummary, validateLowRiskWebActionUrl, validatePublicWebUrl } from "./awen-practice-web-capture";

describe("Awen practice web capture network boundary", () => {
  it("blocks loopback, private, link-local, and special IPv4 destinations", () => {
    for (const address of ["127.0.0.1", "10.4.3.2", "172.16.0.1", "192.168.1.2", "169.254.10.20", "0.0.0.0", "224.0.0.1", "255.255.255.255"]) {
      expect(isPrivateOrSpecialAddress(address), address).toBe(true);
    }
    expect(isPrivateOrSpecialAddress("8.8.8.8")).toBe(false);
  });

  it("blocks loopback, private, unique-local, and link-local IPv6 destinations", () => {
    for (const address of ["::", "::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2001:db8::1", "2002:0808:0808::1"]) {
      expect(isPrivateOrSpecialAddress(address), address).toBe(true);
    }
    expect(isPrivateOrSpecialAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("rejects non-HTTPS, credentialed, local, and literal-private URLs before opening a window", () => {
    expect(() => validatePublicWebUrl("http://example.com")).toThrow("HTTPS");
    expect(() => validatePublicWebUrl("https://user:secret@example.com")).toThrow("HTTPS");
    expect(() => validatePublicWebUrl("https://localhost/")).toThrow("公开网站");
    expect(() => validatePublicWebUrl("https://router.home.arpa/")).toThrow("公开网站");
    expect(() => validatePublicWebUrl("https://printer/")).toThrow("公开网站");
    expect(() => validatePublicWebUrl("https://192.168.1.2/")).toThrow("本机网络");
  });

  it("uses the active Chromium proxy route and does not substitute Node DNS when a remote-only proxy handles DNS", async () => {
    let resolveHostCalls = 0;
    await expect(assertPublicWebRequestRoute("https://github.com/ScoopInstaller/Scoop", {
      resolveProxy: async () => "PROXY 127.0.0.1:7890",
      resolveHost: async () => { resolveHostCalls += 1; return { endpoints: [{ address: "198.18.1.98", family: "ipv4" }] }; }
    })).resolves.toBeUndefined();
    expect(resolveHostCalls).toBe(0);
  });

  it("blocks private DNS answers when the active route may fall back to a direct connection", async () => {
    await expect(assertPublicWebRequestRoute("https://example.com", {
      resolveProxy: async () => "PROXY 127.0.0.1:7890; DIRECT",
      resolveHost: async () => ({ endpoints: [{ address: "10.0.0.8", family: "ipv4" }] })
    })).rejects.toThrow("10.0.0.0/8");
  });

  it("uses Chromium's resolver for direct routes and rejects special-purpose mappings", async () => {
    await expect(assertPublicWebRequestRoute("https://github.com/ScoopInstaller/Scoop", {
      resolveProxy: async () => "DIRECT",
      resolveHost: async () => ({ endpoints: [{ address: "198.18.1.98", family: "ipv4" }] })
    }, [])).rejects.toThrow(/github\.com.*198\.18\.0\.0\/15/iu);
  });

  it("allows RFC 2544 fake-IP DNS mappings only when the configured system resolver uses that pool", async () => {
    const network = {
      resolveProxy: async () => "DIRECT",
      resolveHost: async () => ({ endpoints: [{ address: "198.18.1.98", family: "ipv4" as const }] })
    };

    await expect(assertPublicWebRequestRoute("https://github.com/ScoopInstaller/Scoop", network, ["198.18.0.2", "192.168.0.1"]))
      .resolves.toBeUndefined();
    await expect(assertPublicWebRequestRoute("https://github.com/ScoopInstaller/Scoop", network, ["192.168.0.1"]))
      .rejects.toThrow("198.18.0.0/15");
    expect(() => validatePublicWebUrl("https://198.18.1.98/"))
      .toThrow("本机网络");
  });

  it("still blocks private endpoints when a fake-IP resolver is configured", async () => {
    await expect(assertPublicWebRequestRoute("https://example.com", {
      resolveProxy: async () => "DIRECT",
      resolveHost: async () => ({ endpoints: [
        { address: "198.18.1.98", family: "ipv4" },
        { address: "10.0.0.8", family: "ipv4" }
      ] })
    }, ["198.18.0.2"])).rejects.toThrow("10.0.0.0/8");
  });

  it("keeps search, filter, and pagination actions on the authorized HTTPS origin", () => {
    expect(validateLowRiskWebActionUrl("https://example.com/search?q=demo", "https://example.com").href)
      .toBe("https://example.com/search?q=demo");
    expect(validateLowRiskWebActionUrl("https://example.com/topics?tag=agent", "https://example.com").pathname)
      .toBe("/topics");
    expect(() => validateLowRiskWebActionUrl("https://other.example/next", "https://example.com")).toThrow("本次授权");
    expect(() => validateLowRiskWebActionUrl("http://example.com/next", "https://example.com")).toThrow("HTTPS");
    expect(() => validateLowRiskWebActionUrl("https://example.com/logout", "https://example.com")).toThrow("外部操作");
    expect(() => validateLowRiskWebActionUrl("https://example.com/action?action=delete", "https://example.com")).toThrow("外部影响");
  });

  it("keeps private search and filter terms out of the portable article summary", () => {
    const searchSummary = shareableOperationSummary({ kind: "search", query: "private customer name" });
    const filterSummary = shareableOperationSummary({ kind: "filter", name: "account", option: "private segment" });
    expect(searchSummary).not.toContain("private customer name");
    expect(filterSummary).not.toContain("account");
    expect(filterSummary).not.toContain("private segment");
  });

  it("recognizes login and captcha handover pages without inspecting credentials", () => {
    expect(isAuthenticationChallenge({ title: "Account", text: "", hasPasswordField: true })).toBe(true);
    expect(isAuthenticationChallenge({ title: "Security check", text: "Please verify you are human" })).toBe(true);
    expect(isAuthenticationChallenge({ title: "Continue", text: "", url: "https://example.com/oauth/authorize" })).toBe(true);
    expect(isAuthenticationChallenge({ title: "Public article", text: "The author signs in to the demo app." })).toBe(false);
  });

  it("limits manual handover navigation to public HTTPS addresses and POST to authentication routes", () => {
    expect(isAllowedManualHandoverNavigation("https://login.example.com/sign-in")).toBe(true);
    expect(isAllowedManualHandoverNavigation("http://login.example.com/sign-in")).toBe(false);
    expect(isAllowedManualHandoverNavigation("https://user:pass@login.example.com/sign-in")).toBe(false);
    expect(isAllowedManualHandoverNavigation("https://192.168.1.8/login")).toBe(false);
    expect(isAllowedManualHandoverNavigation("https://internal.local/login")).toBe(false);
    expect(isAuthenticationPost("https://login.example.com/api/auth/login")).toBe(true);
    expect(isAuthenticationPost("https://example.com/captcha/verify")).toBe(true);
    expect(isAuthenticationPost("https://example.com/article/publish")).toBe(false);
    expect(isAuthenticationPost("https://example.com/api/auth/logout")).toBe(false);
    expect(isAuthenticationPost("https://example.com/api/session")).toBe(false);
    expect(isAuthenticationPost("https://example.com/api/auth/login?action=delete")).toBe(false);
  });

  it("allows secure SSO popups only during manual handover and blocks local destinations", () => {
    expect(canOpenManualHandoverPopup("https://login.example.com/oauth/authorize", false)).toBe(false);
    expect(canOpenManualHandoverPopup("https://login.example.com/oauth/authorize", true)).toBe(true);
    expect(canOpenManualHandoverPopup("https://127.0.0.1/login", true)).toBe(false);
    expect(canOpenManualHandoverPopup("https://[::1]/login", true)).toBe(false);
    expect(canOpenManualHandoverPopup("http://login.example.com/login", true)).toBe(false);
  });

});

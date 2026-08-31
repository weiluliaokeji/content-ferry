import { describe, expect, it } from "vitest";
import { buildCookieString, hasLoginCandidate } from "./fiftyone-cto-cookie-grab-utils";

describe("buildCookieString", () => {
  it("joins name=value pairs with '; '", () => {
    expect(
      buildCookieString([
        { name: "sessionid", value: "abc123", domain: ".51cto.com" },
        { name: "auth_token", value: "token-xyz", domain: ".51cto.com" }
      ])
    ).toBe("sessionid=abc123; auth_token=token-xyz");
  });

  it("filters empty names and empty values", () => {
    expect(
      buildCookieString([
        { name: "a", value: "" },
        { name: "", value: "x" },
        { name: "b", value: "2" }
      ])
    ).toBe("b=2");
  });

  it("returns an empty string when there are no cookies", () => {
    expect(buildCookieString([])).toBe("");
  });
});

describe("hasLoginCandidate (候选触发，登录成功以接口验证为准)", () => {
  it("returns true for a non-empty 51cto-domain cookie", () => {
    expect(hasLoginCandidate([{ name: "sessionid", value: "sid-1", domain: ".51cto.com" }])).toBe(true);
  });

  it("returns true for blog.51cto.com subdomain", () => {
    expect(hasLoginCandidate([{ name: "user_id", value: "123", domain: "blog.51cto.com" }])).toBe(true);
  });

  it("returns false for cookies from other domains", () => {
    expect(hasLoginCandidate([{ name: "sessionid", value: "sid-1", domain: ".juejin.cn" }])).toBe(false);
  });

  it("returns false for empty-value 51cto cookies", () => {
    expect(hasLoginCandidate([{ name: "sessionid", value: "", domain: ".51cto.com" }])).toBe(false);
  });

  it("returns false for an empty cookie list", () => {
    expect(hasLoginCandidate([])).toBe(false);
  });
});

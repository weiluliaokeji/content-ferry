import { describe, expect, it } from "vitest";
import {
  DEFAULT_JUJIN_AID,
  buildCookieString,
  extractUuidFromCookie,
  hasLoginCandidate,
  mapVerifyResult,
  resolveUuid,
  shouldRecordCookieGrabLoadError
} from "./cookie-grab-utils";

describe("buildCookieString", () => {
  it("joins name=value pairs with '; '", () => {
    expect(
      buildCookieString([
        { name: "sessionid", value: "abc123" },
        { name: "passport_csrf_token", value: "token-xyz" }
      ])
    ).toBe("sessionid=abc123; passport_csrf_token=token-xyz");
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
  it("returns true when sessionid is present", () => {
    expect(hasLoginCandidate([{ name: "sessionid", value: "sid-1" }])).toBe(true);
  });

  it("returns true when passport_csrf_token is present", () => {
    expect(hasLoginCandidate([{ name: "passport_csrf_token", value: "csrf" }])).toBe(true);
  });

  it("returns false for anonymous cookies only", () => {
    expect(hasLoginCandidate([{ name: "uuid", value: "u-1" }, { name: "nid", value: "n-1" }])).toBe(false);
  });

  it("returns false for an empty cookie list", () => {
    expect(hasLoginCandidate([])).toBe(false);
  });

  it("anonymous passport_csrf_token is only a candidate, not proof of login (verification must fail)", () => {
    // 未登录时掘金也会种匿名 passport_csrf_token / sessionid：候选条件通过，
    // 但匿名态调用接口返回非 0 err_no，最终必须判定为未登录、不得抓取成功。
    const anonymousCookies = [{ name: "passport_csrf_token", value: "anon-csrf" }];
    expect(hasLoginCandidate(anonymousCookies)).toBe(true);
    expect(mapVerifyResult(401)).toBe(false);
    expect(mapVerifyResult("1000")).toBe(false);
  });

  it("logged-in candidate must also pass interface verification to be treated as success", () => {
    const loggedInCookies = [{ name: "sessionid", value: "sid-9" }];
    expect(hasLoginCandidate(loggedInCookies)).toBe(true);
    expect(mapVerifyResult(0)).toBe(true);
  });
});

describe("extractUuidFromCookie", () => {
  it("prefers the uuid cookie key", () => {
    expect(
      extractUuidFromCookie([
        { name: "sessionid", value: "sid-1" },
        { name: "uuid", value: "cookie-uuid" }
      ])
    ).toBe("cookie-uuid");
  });

  it("falls back to sessionid when uuid key is absent", () => {
    expect(extractUuidFromCookie([{ name: "sessionid", value: "sid-2" }])).toBe("sid-2");
  });

  it("returns empty when neither key exists", () => {
    expect(extractUuidFromCookie([{ name: "nid", value: "n-1" }])).toBe("");
  });
});

describe("resolveUuid (localStorage first, cookie fallback)", () => {
  it("uses the localStorage uuid when present", () => {
    expect(resolveUuid("ls-uuid", [{ name: "uuid", value: "cookie-uuid" }])).toBe("ls-uuid");
  });

  it("trims the localStorage uuid", () => {
    expect(resolveUuid("  ls-uuid  ", [{ name: "uuid", value: "cookie-uuid" }])).toBe("ls-uuid");
  });

  it("falls back to the cookie uuid when localStorage is empty", () => {
    expect(resolveUuid("", [{ name: "uuid", value: "cookie-uuid" }])).toBe("cookie-uuid");
  });

  it("falls back to sessionid when localStorage empty and no uuid cookie", () => {
    expect(resolveUuid(null, [{ name: "sessionid", value: "sid-3" }])).toBe("sid-3");
  });

  it("returns empty when nothing is available", () => {
    expect(resolveUuid("", [])).toBe("");
    expect(resolveUuid(undefined, [{ name: "nid", value: "n-1" }])).toBe("");
  });
});

describe("mapVerifyResult (err_no === 0)", () => {
  it("maps err_no 0 to true", () => {
    expect(mapVerifyResult(0)).toBe(true);
    expect(mapVerifyResult("0")).toBe(true);
  });

  it("maps non-zero err_no to false", () => {
    expect(mapVerifyResult(1)).toBe(false);
    expect(mapVerifyResult("401")).toBe(false);
  });

  it("maps missing err_no to false", () => {
    expect(mapVerifyResult(undefined)).toBe(false);
    expect(mapVerifyResult(null)).toBe(false);
  });
});

describe("DEFAULT_JUJIN_AID", () => {
  it("is 2608", () => {
    expect(DEFAULT_JUJIN_AID).toBe("2608");
  });
});

describe("shouldRecordCookieGrabLoadError（延迟 loadURL reject 不覆盖成功结果）", () => {
  it("only records load error while still in the initial waiting_login state", () => {
    expect(shouldRecordCookieGrabLoadError("waiting_login")).toBe(true);
  });

  it("ignores the deferred reject once grabbing/success/error/cancelled", () => {
    expect(shouldRecordCookieGrabLoadError("grabbing")).toBe(false);
    expect(shouldRecordCookieGrabLoadError("success")).toBe(false);
    expect(shouldRecordCookieGrabLoadError("error")).toBe(false);
    expect(shouldRecordCookieGrabLoadError("cancelled")).toBe(false);
  });
});

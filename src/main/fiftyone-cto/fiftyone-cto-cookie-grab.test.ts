import { describe, expect, it } from "vitest";
import {
  buildCookieString,
  hasLoginCandidate,
  isAuthenticatedFiftyoneCtoPublishPage,
  shouldRecordCookieGrabLoadError
} from "./fiftyone-cto-cookie-grab-utils";

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

describe("isAuthenticatedFiftyoneCtoPublishPage（用发布页本身做登录态校验）", () => {
  const loginHtml =
    '<html><head><meta name="csrf-token" content="abc"></head>' +
    '<body><form><input type="text" name="user"><input type="password" name="pass"></form></body></html>';

  // 51CTO 登录页密码框由前端 JS 渲染，初始 HTML 是空壳、不含密码框，
  // 但也不含编辑器容器——这正是此前 verify 假阳性的场景。
  const spaLoginShellHtml =
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
    '<meta name="csrf-param" content="_csrf"><meta name="csrf-token" content="abc">' +
    '</head><body><div id="app"></div><script src="/passport/login.js"></script></body></html>';

  const editorHtml =
    '<html><head><meta name="csrf-token" content="abc"></head>' +
    '<body><div class="editor-container container am-engine" id="container" data-element="root">' +
    "<script>var pid='176'; var cate_id='200';</script></body></html>";

  it("rejects a 302 redirect to the passport login page", () => {
    expect(
      isAuthenticatedFiftyoneCtoPublishPage({
        status: 302,
        location: "https://passport.51cto.com/login?xxx",
        html: ""
      })
    ).toBe(false);
  });

  it("rejects a 200 response that is actually the login form (password input)", () => {
    expect(isAuthenticatedFiftyoneCtoPublishPage({ status: 200, html: loginHtml })).toBe(false);
  });

  it("rejects a 200 SPA login shell without a password field but also without an editor container", () => {
    // 回归：此前用“不含 password 即已登录”会把这种匿名 Cookie 误判为成功。
    expect(isAuthenticatedFiftyoneCtoPublishPage({ status: 200, html: spaLoginShellHtml })).toBe(false);
  });

  it("rejects non-200 statuses", () => {
    expect(isAuthenticatedFiftyoneCtoPublishPage({ status: 503, html: editorHtml })).toBe(false);
  });

  it("accepts a 200 response with the am-editor container (authenticated editor page)", () => {
    expect(isAuthenticatedFiftyoneCtoPublishPage({ status: 200, html: editorHtml })).toBe(true);
  });

  it("accepts a 200 editor page identified by editor-container even without am-engine", () => {
    const alt = '<html><body><div class="editor-container">文章标题</div></body></html>';
    expect(isAuthenticatedFiftyoneCtoPublishPage({ status: 200, html: alt })).toBe(true);
  });
});

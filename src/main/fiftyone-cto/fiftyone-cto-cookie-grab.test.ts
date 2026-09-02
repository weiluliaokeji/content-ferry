import { describe, expect, it } from "vitest";
import {
  buildCookieString,
  hasLoginCandidate,
  isFiftyoneCtoLoggedInHtml,
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

describe("isFiftyoneCtoLoggedInHtml（用首页 SSR HTML 标记判断登录态）", () => {
  // 已登录：右上角是 <li class="more user">，含「退出」按钮与头像 data-uid
  const loggedInHtml =
    '<li class="more user"><a class="login-out" href="/user/logout">退出</a>' +
    '<img class="user-img" src="https://avatar.51cto.com/abc.jpg" data-uid="123456"></li>';

  // 未登录：右上角是 <li class="logins">，含「登录 / 注册」入口
  const loggedOutHtml =
    '<li class="logins"><a href="/user/login">登录</a><a href="/user/reg">注册</a></li>';

  it("accepts the logged-in home page markup (more user + logout + data-uid)", () => {
    expect(isFiftyoneCtoLoggedInHtml(loggedInHtml)).toBe(true);
  });

  it("rejects the logged-out home page markup (class='logins')", () => {
    // 未登录时地址栏同样可以是 blog.51cto.com，必须靠 HTML 标记区分。
    expect(isFiftyoneCtoLoggedInHtml(loggedOutHtml)).toBe(false);
  });

  it("rejects empty html", () => {
    expect(isFiftyoneCtoLoggedInHtml("")).toBe(false);
  });

  it("treats ambiguous html without either marker as not logged-in", () => {
    // 既无 more user 也无 logins（例如 SPA 空壳），保守判失败，等待真实登录页。
    expect(isFiftyoneCtoLoggedInHtml('<div id="app"></div>')).toBe(false);
  });
});

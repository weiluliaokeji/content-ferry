import { describe, expect, it } from "vitest";
import { buildShareablePracticeConditions } from "./practice-provenance";

describe("buildShareablePracticeConditions", () => {
  it("keeps useful runtime and operation conditions while excluding paths and raw inputs", () => {
    const conditions = buildShareablePracticeConditions([
      { toolId: "practice_run_code", result: {
        runtime: "node", runtimeVersion: "Node.js v24.9.0", status: "completed", exitCode: 0,
        stdout: "secret output", cwd: "C:\\Users\\Alice\\private", code: "private source"
      } },
      { toolId: "practice_capture_webpage", result: {
        operationSummary: "执行站内搜索", url: "https://example.com/search?q=private", observation: "private page text"
      } },
      { toolId: "practice_capture_demo", result: { url: "local-demo:C:/Users/Alice/private/index.html" } }
    ]);

    expect(conditions).toBe("Windows 本机 · Node.js · Node.js v24.9.0 · 运行成功 · 退出码 0；公开 HTTPS 页面 · 站内搜索；本地 HTML Demo · 文渡任务临时工作区");
    expect(conditions).not.toContain("C:\\Users");
    expect(conditions).not.toContain("secret");
    expect(conditions).not.toContain("private");
  });

  it("omits unrecognized tools, versions, and webpage operations", () => {
    expect(buildShareablePracticeConditions([
      { toolId: "practice_run_code", result: { runtime: "python", runtimeVersion: "D:\\private\\python.exe", status: "interrupted", exitCode: 0 } },
      { toolId: "practice_capture_webpage", result: { operationSummary: "提交账户资料" } },
      { toolId: "unknown", result: { value: "private" } }
    ])).toBe("Windows 本机 · Python · 运行中断");
  });

  it("does not publish an exit code for interrupted or unrecognized run states", () => {
    expect(buildShareablePracticeConditions([
      { toolId: "practice_run_code", result: { runtime: "node", status: "unknown", exitCode: 7 } }
    ])).toBe("Windows 本机 · Node.js");
  });

  it("provides a safe fallback when there are no supported structured results", () => {
    expect(buildShareablePracticeConditions(null)).toBe("运行条件未单独记录。");
    expect(buildShareablePracticeConditions([])).toBe("运行条件未单独记录。");
  });
});

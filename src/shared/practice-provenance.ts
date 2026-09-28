/** Builds portable condition notes from an Awen task's structured tool results. */
export function buildShareablePracticeConditions(value: unknown): string {
  if (!Array.isArray(value)) return "运行条件未单独记录。";
  const conditions: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.result)) continue;
    if (item.toolId === "practice_run_code") {
      const runtime = item.result.runtime === "python" ? "Python" : item.result.runtime === "node" ? "Node.js" : undefined;
      if (!runtime) continue;
      const version = safeVersion(item.result.runtimeVersion);
      const resultStatus = item.result.status;
      const status = resultStatus === "completed" ? "运行成功"
        : resultStatus === "failed" ? "运行失败"
          : resultStatus === "cancelled" ? "已取消"
            : resultStatus === "interrupted" ? "运行中断"
              : undefined;
      const exitCode = (resultStatus === "completed" || resultStatus === "failed") && Number.isInteger(item.result.exitCode)
        ? `退出码 ${item.result.exitCode as number}`
        : undefined;
      conditions.push(["Windows 本机", runtime, version, status, exitCode].filter(Boolean).join(" · "));
    } else if (item.toolId === "practice_capture_webpage") {
      const operation = shareableWebOperation(item.result.operationSummary);
      if (operation) conditions.push(`公开 HTTPS 页面 · ${operation}`);
    } else if (item.toolId === "practice_capture_demo") {
      conditions.push("本地 HTML Demo · 文渡任务临时工作区");
    }
  }
  return [...new Set(conditions)].join("；").slice(0, 500) || "运行条件未单独记录。";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ");
  return /^[\p{L}\p{N}][\p{L}\p{N}._+() -]{0,79}$/u.test(normalized) ? normalized : undefined;
}

function shareableWebOperation(value: unknown): string | undefined {
  if (value === "只读打开页面") return value;
  if (value === "执行站内搜索" || value === "执行站内搜索（不随文章记录搜索词）") return "站内搜索";
  if (value === "使用页面公开的筛选项" || value === "使用页面公开的筛选项（不随文章记录筛选值）") return "使用公开筛选项";
  if (value === "打开下一页") return value;
  return undefined;
}

import { runtimeLogLevel } from "../utils";
import type { RuntimeLogEntry, RuntimeLogResponse } from "../types";

export interface LogsViewProps {
  runtimeLogs: RuntimeLogEntry[];
  filteredRuntimeLogs: RuntimeLogEntry[];
  runtimeLogMeta: Pick<RuntimeLogResponse, "totalMatched" | "hasMore" | "sourceTruncated" | "readWindowBytes">;
  runtimeLogsLoading: boolean;
  logDate: string;
  setLogDate: (value: string) => void;
  runtimeLogFilter: "all" | "errors" | "wechat" | "callbacks";
  setRuntimeLogFilter: (value: "all" | "errors" | "wechat" | "callbacks") => void;
  runtimeLogSearch: string;
  setRuntimeLogSearch: (value: string) => void;
  runtimeLogPath: string;
  loadRuntimeLogs: () => Promise<void>;
}

export function LogsView(props: LogsViewProps) {
  const {
    runtimeLogs, filteredRuntimeLogs, runtimeLogMeta, runtimeLogsLoading, logDate, setLogDate,
    runtimeLogFilter, setRuntimeLogFilter, runtimeLogSearch, setRuntimeLogSearch, runtimeLogPath, loadRuntimeLogs,
  } = props;

  return <section className="card runtime-log-card">
    <div className="runtime-log-toolbar">
      <label>日期<input type="date" value={logDate} onChange={(event) => setLogDate(event.target.value)} /></label>
      <label>范围<select value={runtimeLogFilter} onChange={(event) => setRuntimeLogFilter(event.target.value as typeof runtimeLogFilter)}><option value="all">全部</option><option value="errors">错误与失败</option><option value="wechat">微信接口</option><option value="callbacks">微信回调</option></select></label>
      <label className="runtime-log-search">查找<input value={runtimeLogSearch} onChange={(event) => setRuntimeLogSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void loadRuntimeLogs(); }} placeholder="请求路径、错误内容或 requestId" /></label>
      <span><button className="secondary-button compact-action" onClick={() => void loadRuntimeLogs()} disabled={runtimeLogsLoading}>{runtimeLogsLoading ? "正在查询…" : "查询"}</button><button className="text-button compact-action" onClick={() => void window.contentFerry?.showLogFile(logDate)}>打开当天日志文件</button></span>
    </div>
    {runtimeLogPath && <p className="runtime-log-path">{runtimeLogPath}</p>}
    <p className="runtime-log-summary">显示 {runtimeLogs.length} / {runtimeLogMeta.totalMatched} 条匹配记录（按时间倒序）。{runtimeLogMeta.hasMore && " 当前仅展示最近 300 条匹配记录。"}{runtimeLogMeta.sourceTruncated && ` 当前日期日志超过 ${Math.round(runtimeLogMeta.readWindowBytes / 1024 / 1024)} MB，较早记录请通过“打开当天日志文件”查看。`}</p>
    {filteredRuntimeLogs.length === 0 ? <div className="empty-guidance"><strong>当前范围没有日志</strong><p>执行一次接口操作或切换到“全部”后再刷新。</p></div> : <ol className="runtime-log-list">{filteredRuntimeLogs.map((entry, index) => <li className={entry.level >= 50 || (entry.statusCode ?? 0) >= 400 ? "error-log" : ""} key={`${entry.time}-${entry.requestId}-${index}`}><time>{entry.time ? new Date(entry.time).toLocaleString() : "时间未知"}</time><span className="runtime-log-level">{runtimeLogLevel(entry.level)}</span><div><strong>{entry.method && entry.url ? `${entry.method} ${entry.url}` : entry.message || "运行记录"}</strong><small>{entry.statusCode != null ? `HTTP ${entry.statusCode}` : ""}{entry.responseTime != null ? ` · ${entry.responseTime.toFixed(1)} ms` : ""}{entry.message && entry.method ? ` · ${entry.message}` : ""}</small>{entry.error && <em>{entry.error}</em>}</div></li>)}</ol>}
  </section>;
}

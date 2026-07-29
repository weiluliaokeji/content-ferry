export type WorkspaceId = string;
export type MediaAccountId = string;
export type ContentProjectId = string;

export type PublishMode = "freepublish" | "mass_sendall";
export type PublishJobStatus =
  | "draft_pending"
  | "draft_created"
  | "waiting_final_review"
  | "scheduled"
  | "submit_pending"
  | "waiting_wechat_result"
  | "published"
  | "mass_sent"
  | "publish_failed"
  | "missed_schedule"
  | "cancelled";

export interface HealthResponse {
  status: "ok";
  database: "ready";
  startedAt: string;
}

export interface WorkspaceResponse {
  id: WorkspaceId;
  displayName: string;
  timezone: string;
}

export type CodexAiInitStatus =
  | "not_initialized"
  | "ready"
  | "login_required"
  | "binary_missing";

export interface AppSettings {
  schemaVersion: 1;
  dataDir: string;
  firstRunCompleted: boolean;
  aiInitStatus: CodexAiInitStatus;
  codexBinaryPath: string | null;
  /** 是否开启 AI 调用审计。开启后会在数据目录下的 logs/ai-audit 写入每次模型调用的完整请求与响应，默认关闭。 */
  auditAiCalls: boolean;
  /**
   * 联网检索（Tavily / Bing / DuckDuckGo / 可见浏览器）统一使用的全局代理地址。
   * 与“模型连接级代理”相互独立：模型连接的代理只影响该模型的请求，而本地址
   * 作用于所有联网补研流量，解决“需要代理才能访问检索源（如防火墙之后）”的场景。
   * 留空表示直连。格式 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080。
   */
  researchProxyUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface CodexStatus {
  ok: boolean;
  binaryPath: string | null;
  authenticated: boolean;
  authMethod?: string;
  reason?: string;
}

export interface CodexLoginResult {
  ok: boolean;
  message?: string;
}

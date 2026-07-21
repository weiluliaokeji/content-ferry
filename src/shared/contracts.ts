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

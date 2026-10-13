/** Cross-process vocabulary for resumable article drafting. Payloads must be summaries, never raw article or tool output. */
export type DraftDepthPreference = "concise" | "standard" | "detailed" | null;

export type DraftRunStage =
  | "planning_depth" | "assessing_practice" | "research_needed" | "awaiting_permission"
  | "practicing" | "drafting" | "curating_images" | "reviewing" | "revising"
  | "awaiting_scope_decision" | "passed" | "needs_author" | "failed" | "cancelled";

export type DraftRunStatus = "running" | "waiting_author" | "passed" | "needs_author" | "failed" | "cancelled";

export type DraftRunEventKind =
  | "progress" | "stage_started" | "stage_completed" | "stage_skipped"
  | "finding_routed" | "authorization_waiting" | "evidence_attached"
  | "image_curation" | "review_completed" | "checkpoint_updated"
  | "scope_decision_required" | "completed" | "stopped" | "failed";

export interface DraftRunCheckpoint {
  outlineRevisionSha256?: string;
  sourceArticleRevisionSha256?: string;
  recoveredArticleRevisionSha256?: string;
  recoveredOutlineRevisionSha256?: string;
  recoveredResearchCardIds?: string[];
  recoveredPracticeTaskId?: string;
  recoveredPracticeTaskStatus?: string;
  recoveredPracticeWorkflowStatus?: string;
  recoveredAuthorizationState?: "not_pending" | "requires_reconfirmation" | "workflow_unavailable";
  draftRevisionSha256?: string;
  practiceTaskId?: string;
  researchCardIds?: string[];
  authorizationRequestId?: string;
  proseRevisionRounds?: number;
  evidenceWorkRounds?: number;
  noProgressCount?: number;
  stoppingReason?: string;
}

export interface DraftRunEvent {
  runId: string;
  sequence: number;
  kind: DraftRunEventKind;
  stage: DraftRunStage;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

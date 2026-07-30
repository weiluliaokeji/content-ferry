/**
 * Shared contract for browser/API-backed platform publishers. A connector may
 * only submit after a frozen channel draft has passed preflight and the user
 * has explicitly confirmed the external write.
 */
export interface PublishCapabilities {
  canCreateRemoteDraft: boolean;
  canSubmitAfterConfirmation: boolean;
  canReadRemoteReceipt: boolean;
  supportsExternalLink: "allowed" | "restricted" | "unknown";
  supportsScheduledPublish: boolean;
}

export interface PreflightResult {
  state: "ready" | "needs_login" | "unsupported";
  accountDisplayName?: string;
  capabilityEvidence: string[];
  reason?: string;
}

export interface FillResult {
  state: "ready_for_final_confirmation" | "needs_user" | "failed_before_submit";
  verifiedFields: Array<"account" | "title" | "summary" | "tags" | "cover" | "asset_count">;
  failedAssets: Array<{ localPath: string; reason: string }>;
  editorUrl?: string;
  reason?: string;
}

export interface PublishReceipt {
  remoteUrl: string | null;
  remoteContentId: string | null;
  title: string | null;
  accountDisplayName: string | null;
  publishedAt: string | null;
}

export interface ManualReconciliationRequired {
  reason: string;
}

export interface PlatformPublisherConnector<Snapshot> {
  readonly platform: string;
  capabilities(accountId: string): PublishCapabilities;
  preflight(snapshot: Snapshot): Promise<PreflightResult>;
  fill(snapshot: Snapshot): Promise<FillResult>;
  requestFinalConfirmation(jobId: string): Promise<void>;
  submit(jobId: string): Promise<void>;
  reconcile(jobId: string): Promise<PublishReceipt | ManualReconciliationRequired>;
}

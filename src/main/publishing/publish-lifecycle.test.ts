import { describe, expect, it } from "vitest";
import {
  buildPublishIdempotencyKey,
  computePublishSnapshotHash,
  isRetryablePublishStatus,
  isTerminalPublishStatus,
  lifecycleStatusForOutcome,
  toPublishLifecycleStatus
} from "./publish-lifecycle";

describe("publish lifecycle", () => {
  it("maps platform states without confusing user action with uncertain remote results", () => {
    expect(toPublishLifecycleStatus("draft_created")).toBe("ready");
    expect(toPublishLifecycleStatus("needs_user")).toBe("waiting_user");
    expect(toPublishLifecycleStatus("needs_manual_reconciliation")).toBe("needs_manual_reconciliation");
    expect(toPublishLifecycleStatus("needs_login")).toBe("needs_credentials");
  });

  it("keeps snapshot hashes stable when option key order changes", () => {
    const base = {
      platform: "csdn", accountId: "a1", channelDraftId: "d1", title: "标题", markdown: "正文",
      options: { cover: "cover.png", tags: ["AI", "工程"] }, resourceRefs: ["./assets/a.png", "./assets/b.png"]
    };
    const reordered = { ...base, options: { tags: ["AI", "工程"], cover: "cover.png" }, resourceRefs: ["./assets/b.png", "./assets/a.png"] };
    expect(computePublishSnapshotHash(base)).toBe(computePublishSnapshotHash(reordered));
    expect(buildPublishIdempotencyKey("csdn", "a1", "d1", computePublishSnapshotHash(base))).toContain(":publish");
  });

  it("only treats published, reconciled and cancelled jobs as terminal", () => {
    expect(isTerminalPublishStatus("published")).toBe(true);
    expect(isTerminalPublishStatus("needs_manual_reconciliation")).toBe(true);
    expect(isTerminalPublishStatus("failed")).toBe(false);
    expect(isRetryablePublishStatus("ready")).toBe(true);
    expect(isRetryablePublishStatus("needs_credentials")).toBe(true);
    expect(lifecycleStatusForOutcome("uncertain", "submit")).toBe("needs_manual_reconciliation");
    expect(lifecycleStatusForOutcome("blocked", "prepare")).toBe("needs_credentials");
  });
});

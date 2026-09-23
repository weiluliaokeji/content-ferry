import type Database from "better-sqlite3";
import {
  isTerminalPublishStatus,
  lifecycleStatusForOutcome,
  toPublishLifecycleStatus,
  type PublishAdapterOutcome,
  type PublishLifecycleStatus
} from "./publish-lifecycle";
import {
  PublishLifecycleService,
  type PublishLifecycleJob,
  type PublishLifecycleEvent,
  type PublishLifecycleSource
} from "./publish-lifecycle-service";

export interface PublishTaskAdapterResult {
  outcome: PublishAdapterOutcome;
  completedPhase?: "prepare" | "submit";
  nextStatus?: PublishLifecycleStatus;
  statusNote?: string | null;
  errorMessage?: string | null;
  remoteUrl?: string | null;
  remoteContentId?: string | null;
}

export interface PublishTaskStatusMapping {
  outcome: PublishAdapterOutcome;
  completedPhase?: "prepare" | "submit";
  nextStatus?: PublishLifecycleStatus;
  statusNote?: string | null;
}

/** Map platform detail states into the shared adapter result shape. */
export function mapPlatformStatusToAdapterResult(
  platformStatus: string,
  mappings: Readonly<Record<string, PublishTaskStatusMapping>>,
  fallback: PublishTaskStatusMapping,
  details: Pick<PublishTaskAdapterResult, "statusNote" | "errorMessage" | "remoteUrl" | "remoteContentId"> = {}
): PublishTaskAdapterResult {
  const mapping = mappings[platformStatus] ?? fallback;
  return {
    ...mapping,
    ...(details.statusNote !== undefined ? { statusNote: details.statusNote } : {}),
    ...(details.errorMessage !== undefined ? { errorMessage: details.errorMessage } : {}),
    ...(details.remoteUrl !== undefined ? { remoteUrl: details.remoteUrl } : {}),
    ...(details.remoteContentId !== undefined ? { remoteContentId: details.remoteContentId } : {})
  };
}

/**
 * Platform-specific publishing work behind the publish-task seam.
 * The adapter owns external calls and platform details; this module owns the
 * canonical lifecycle projection and scheduling rules.
 */
export interface PublishTaskAdapter {
  readonly platform: string;
  readonly autoPrepare: boolean;
  prepare(task: PublishLifecycleJob): Promise<PublishTaskAdapterResult>;
  reconcile(task: PublishLifecycleJob): Promise<PublishTaskAdapterResult>;
}

export interface PublishTaskTransitionPatch {
  statusNote?: string | null;
  errorMessage?: string | null;
  remoteUrl?: string | null;
  remoteContentId?: string | null;
  statusSource?: PublishLifecycleSource;
}

/**
 * Deep module for the cross-platform publish-task lifecycle.
 *
 * Platform modules keep their channel-draft and external-platform details,
 * while callers use this module for canonical status, recovery and scheduling.
 */
export class PublishTaskModule {
  private readonly adapters = new Map<string, PublishTaskAdapter>();
  private readonly inFlight = new Map<string, Promise<PublishLifecycleJob>>();
  private readonly submitLocks = new Map<string, Promise<unknown>>();
  private stopped = false;

  constructor(
    db: Database.Database,
    private readonly lifecycle = new PublishLifecycleService(db)
  ) {}

  registerAdapter(adapter: PublishTaskAdapter): void {
    const existing = this.adapters.get(adapter.platform);
    if (existing && existing !== adapter) {
      throw new Error(`发布任务平台 adapter 已注册：${adapter.platform}`);
    }
    this.adapters.set(adapter.platform, adapter);
  }

  create(input: Parameters<PublishLifecycleService["create"]>[0]): PublishLifecycleJob {
    return this.lifecycle.create(input);
  }

  ensure(input: Parameters<PublishLifecycleService["ensure"]>[0]): PublishLifecycleJob {
    return this.lifecycle.ensure(input);
  }

  findActiveBySnapshot(input: Parameters<PublishLifecycleService["findActiveBySnapshot"]>[0]): PublishLifecycleJob | null {
    return this.lifecycle.findActiveBySnapshot(input);
  }

  /**
   * Project a platform-specific status change into the canonical lifecycle.
   * Platform services persist their own detail row; this module owns the
   * shared status, nullable fields and lifecycle event.
   */
  recordPlatformTransition(
    id: string,
    platformStatus: string,
    patch: PublishTaskTransitionPatch,
    reason: string
  ): PublishLifecycleJob {
    return this.transition(id, toPublishLifecycleStatus(platformStatus), patch, reason);
  }

  /** Record a transition that is already expressed in canonical lifecycle terms. */
  recordLifecycleTransition(
    id: string,
    status: PublishLifecycleStatus,
    patch: PublishTaskTransitionPatch,
    reason: string
  ): PublishLifecycleJob {
    return this.transition(id, status, patch, reason);
  }

  private transition(
    id: string,
    status: PublishLifecycleStatus,
    patch: PublishTaskTransitionPatch,
    reason: string
  ): PublishLifecycleJob {
    return this.lifecycle.transition(id, status, patch, reason);
  }

  get(id: string): PublishLifecycleJob | null {
    return this.lifecycle.get(id);
  }

  list(workspaceId: string): PublishLifecycleJob[] {
    return this.lifecycle.list(workspaceId);
  }

  listEvents(id: string, limit?: number): PublishLifecycleEvent[] {
    return this.lifecycle.listEvents(id, limit);
  }

  /** Schedule only adapters that explicitly opt into automatic preparation. */
  scheduleAutoPreparation(id: string): void {
    if (this.stopped) return;
    const task = this.require(id);
    const adapter = this.adapters.get(task.platform);
    if (!adapter?.autoPrepare) return;
    queueMicrotask(() => {
      void this.prepare(id).catch(() => {
        // The adapter result is converted into a failed lifecycle state by
        // prepare(). This catch prevents a detached runner from becoming an
        // unhandled rejection if persistence itself fails.
      });
    });
  }

  async prepare(id: string): Promise<PublishLifecycleJob> {
    if (this.stopped) return this.require(id);
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const operation = this.runPrepare(id);
    this.inFlight.set(id, operation);
    operation.finally(() => this.inFlight.delete(id)).catch(() => {});
    return operation;
  }

  /** Share one in-flight final submission per frozen publish task. */
  async runSubmitExclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.submitLocks.get(id);
    if (existing) return existing.then((value) => value as T);
    const submitted = Promise.resolve().then(operation);
    this.submitLocks.set(id, submitted);
    submitted.finally(() => this.submitLocks.delete(id)).catch(() => {});
    return submitted;
  }

  /**
   * Recover safe queued work and reconcile work that may have crossed an
   * external seam before the process stopped. No uncertain call is replayed.
   */
  async recover(): Promise<{ scheduled: number; reconciled: number }> {
    if (this.stopped) return { scheduled: 0, reconciled: 0 };
    let scheduled = 0;
    let reconciled = 0;
    for (const task of this.lifecycle.listByStatuses(["queued"])) {
      const adapter = this.adapters.get(task.platform);
      if (!adapter?.autoPrepare) continue;
      this.scheduleAutoPreparation(task.id);
      scheduled += 1;
    }
    for (const task of this.lifecycle.listByStatuses(["preparing", "submitting"])) {
      if (!this.adapters.has(task.platform)) continue;
      await this.reconcile(task.id);
      reconciled += 1;
    }
    return { scheduled, reconciled };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.inFlight.values(), ...this.submitLocks.values()]);
  }

  private async runPrepare(id: string): Promise<PublishLifecycleJob> {
    let task = this.require(id);
    if (isTerminalPublishStatus(task.status) || task.status === "ready") return task;
    const adapter = this.requireAdapter(task.platform);
    if (task.status !== "preparing") {
      task = this.transition(id, "preparing", {
        statusNote: "正在准备平台发布任务。",
        errorMessage: null
      }, "开始准备平台发布任务");
    }
    let result: PublishTaskAdapterResult;
    try {
      result = await adapter.prepare(task);
    } catch (error) {
      result = {
        outcome: "retryable",
        statusNote: "平台发布准备失败。",
        errorMessage: error instanceof Error ? error.message : String(error)
      };
    }
    return this.applyResult(id, result, "prepare");
  }

  private async reconcile(id: string): Promise<PublishLifecycleJob> {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const operation = this.runReconcile(id);
    this.inFlight.set(id, operation);
    operation.finally(() => this.inFlight.delete(id)).catch(() => {});
    return operation;
  }

  private async runReconcile(id: string): Promise<PublishLifecycleJob> {
    const task = this.require(id);
    const adapter = this.requireAdapter(task.platform);
    let result: PublishTaskAdapterResult;
    try {
      result = await adapter.reconcile(task);
    } catch (error) {
      result = {
        outcome: "uncertain",
        statusNote: "无法自动核对平台发布结果。",
        errorMessage: error instanceof Error ? error.message : String(error)
      };
    }
    return this.applyResult(id, result, task.status === "submitting" ? "submit" : "prepare");
  }

  private applyResult(
    id: string,
    result: PublishTaskAdapterResult,
    defaultPhase: "prepare" | "submit"
  ): PublishLifecycleJob {
    const current = this.require(id);
    const phase = result.completedPhase ?? defaultPhase;
    const status = result.nextStatus ?? lifecycleStatusForOutcome(result.outcome, phase);
    const note = result.statusNote ?? defaultStatusNote(status);
    if (
      current.status === status
      && result.remoteUrl === undefined
      && result.remoteContentId === undefined
      && result.errorMessage === undefined
    ) {
      return current;
    }
    return this.transition(id, status, {
      statusNote: note,
      errorMessage: result.errorMessage,
      remoteUrl: result.remoteUrl,
      remoteContentId: result.remoteContentId,
      statusSource: "system"
    }, note);
  }

  private require(id: string): PublishLifecycleJob {
    const task = this.lifecycle.get(id);
    if (!task) throw new Error(`发布任务不存在：${id}`);
    return task;
  }

  private requireAdapter(platform: string): PublishTaskAdapter {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`未注册发布任务 adapter：${platform}`);
    return adapter;
  }
}

function defaultStatusNote(status: PublishLifecycleStatus): string {
  switch (status) {
    case "ready": return "平台发布任务已准备完成。";
    case "published": return "平台已确认发布成功。";
    case "needs_credentials": return "平台发布需要补充或修复凭据。";
    case "needs_manual_reconciliation": return "无法自动确认平台结果，请人工核对。";
    case "failed": return "平台发布任务失败，可在确认安全后重试。";
    case "waiting_user": return "等待用户完成平台操作。";
    default: return `发布任务状态已更新为 ${status}。`;
  }
}

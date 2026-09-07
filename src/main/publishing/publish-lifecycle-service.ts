import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { toPublishLifecycleStatus, type PublishLifecycleStatus } from "./publish-lifecycle";

export type PublishLifecycleSource = "system" | "manual" | "legacy_sync";

export interface PublishLifecycleJob {
  id: string;
  platform: string;
  platformJobId: string;
  workspaceId: string;
  accountId: string;
  channelDraftId: string;
  renderedPackageHash: string;
  idempotencyKey: string;
  status: PublishLifecycleStatus;
  remoteUrl: string | null;
  remoteContentId: string | null;
  statusNote: string | null;
  errorMessage: string | null;
  statusSource: PublishLifecycleSource;
  createdAt: string;
  updatedAt: string;
}

export interface PublishLifecycleJobInput {
  id: string;
  platform: string;
  workspaceId: string;
  accountId: string;
  channelDraftId: string;
  renderedPackageHash: string;
  idempotencyKey: string;
  status: PublishLifecycleStatus;
  statusNote?: string | null;
  errorMessage?: string | null;
  remoteUrl?: string | null;
  remoteContentId?: string | null;
  statusSource?: PublishLifecycleSource;
}

export class PublishLifecycleService {
  constructor(private readonly db: Database.Database) {}

  create(input: PublishLifecycleJobInput): PublishLifecycleJob {
    const existing = this.get(input.id) ?? this.getByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;
    const now = new Date().toISOString();
    const source = input.statusSource ?? "system";
    this.db.transaction(() => {
      const result = this.db.prepare(`INSERT OR IGNORE INTO publish_lifecycle_jobs
        (id, platform, platform_job_id, workspace_id, account_id, channel_draft_id,
         rendered_package_hash, idempotency_key, status, remote_url, remote_content_id,
         status_note, error_message, status_source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.id, input.platform, input.id, input.workspaceId, input.accountId, input.channelDraftId,
          input.renderedPackageHash, input.idempotencyKey, input.status, input.remoteUrl ?? null,
          input.remoteContentId ?? null, input.statusNote ?? null, input.errorMessage ?? null,
          source, now, now
        );
      if (result.changes > 0) {
        this.db.prepare(`INSERT INTO publish_lifecycle_events
          (id, job_id, previous_status, new_status, source, reason, created_at)
          VALUES (?, ?, '', ?, ?, ?, ?)`)
          .run(randomUUID(), input.id, input.status, source,
            source === "legacy_sync" ? "从平台任务表补齐统一生命周期记录" : "创建统一发布生命周期任务", now);
      }
    })();
    return this.require(input.id);
  }

  /** Backfill old platform jobs without overwriting the canonical lifecycle state. */
  ensure(input: PublishLifecycleJobInput): PublishLifecycleJob {
    const existing = this.get(input.id);
    if (existing) return existing;
    return this.create({ ...input, statusSource: "legacy_sync" });
  }

  transition(
    id: string,
    status: PublishLifecycleStatus,
    patch: { statusNote?: string | null; errorMessage?: string | null; remoteUrl?: string | null; remoteContentId?: string | null; statusSource?: PublishLifecycleSource },
    reason: string
  ): PublishLifecycleJob {
    const current = this.require(id);
    const now = new Date().toISOString();
    const nextSource = patch.statusSource ?? "system";
    this.db.transaction(() => {
      this.db.prepare(`UPDATE publish_lifecycle_jobs SET
        status = ?, status_note = COALESCE(?, status_note), error_message = COALESCE(?, error_message),
        remote_url = COALESCE(?, remote_url), remote_content_id = COALESCE(?, remote_content_id),
        status_source = ?, updated_at = ? WHERE id = ?`)
        .run(status, patch.statusNote ?? null, patch.errorMessage ?? null, patch.remoteUrl ?? null,
          patch.remoteContentId ?? null, nextSource, now, id);
      this.db.prepare(`INSERT INTO publish_lifecycle_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), id, current.status, status, nextSource, reason, now);
    })();
    return this.require(id);
  }

  get(id: string): PublishLifecycleJob | null {
    const row = this.db.prepare("SELECT * FROM publish_lifecycle_jobs WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    return row ? mapLifecycleJob(row) : null;
  }

  list(workspaceId: string): PublishLifecycleJob[] {
    return (this.db.prepare("SELECT * FROM publish_lifecycle_jobs WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 100")
      .all(workspaceId) as Array<Record<string, string | null>>).map(mapLifecycleJob);
  }

  private getByIdempotencyKey(idempotencyKey: string): PublishLifecycleJob | null {
    const row = this.db.prepare("SELECT * FROM publish_lifecycle_jobs WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, string | null> | undefined;
    return row ? mapLifecycleJob(row) : null;
  }

  private require(id: string): PublishLifecycleJob {
    const job = this.get(id);
    if (!job) throw new Error(`统一发布生命周期任务不存在：${id}`);
    return job;
  }
}

function mapLifecycleJob(row: Record<string, string | null>): PublishLifecycleJob {
  return {
    id: row.id ?? "",
    platform: row.platform ?? "",
    platformJobId: row.platform_job_id ?? row.id ?? "",
    workspaceId: row.workspace_id ?? "",
    accountId: row.account_id ?? "",
    channelDraftId: row.channel_draft_id ?? "",
    renderedPackageHash: row.rendered_package_hash ?? "",
    idempotencyKey: row.idempotency_key ?? "",
    status: toPublishLifecycleStatus(row.status ?? "failed"),
    remoteUrl: row.remote_url ?? null,
    remoteContentId: row.remote_content_id ?? null,
    statusNote: row.status_note ?? null,
    errorMessage: row.error_message ?? null,
    statusSource: row.status_source === "manual" || row.status_source === "legacy_sync" ? row.status_source : "system",
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? ""
  };
}

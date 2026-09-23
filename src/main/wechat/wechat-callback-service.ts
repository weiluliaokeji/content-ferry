import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { AccountRepository } from "../accounts/account-repository";
import type { CredentialVault } from "../security/credential-vault";
import { WechatApiError } from "./wechat-publishing-service";

export class WechatCallbackService {
  constructor(
    private readonly db: Database.Database,
    private readonly accounts: AccountRepository,
    private readonly vault: CredentialVault
  ) {}

  verify(accountId: string, signature: string, timestamp: string, nonce: string): boolean {
    const token = this.accounts.getCredential(accountId, "callback_token", this.vault);
    const expected = createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
    const left = Buffer.from(expected);
    const right = Buffer.from(signature);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  accept(accountId: string, signature: string, timestamp: string, nonce: string, xml: string): void {
    const account = this.accounts.requireAccount(accountId);
    if (!this.verify(accountId, signature, timestamp, nonce)) throw new WechatApiError("微信回调签名验证失败。");
    const fingerprint = createHash("sha256").update(xml).digest("hex");
    const now = new Date().toISOString();
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO callback_events
      (id, workspace_id, account_id, event_fingerprint, signature_status, payload_digest, received_at)
      VALUES (?, ?, ?, ?, 'valid', ?, ?)`)
      .run(randomUUID(), account.workspaceId, accountId, fingerprint, fingerprint, now);
    if (inserted.changes === 0) return;

    const event = xmlValue(xml, "Event").toUpperCase();
    if (event === "PUBLISHJOBFINISH") {
      const publishId = xmlValue(xml, "publish_id") || xmlValue(xml, "PublishId");
      const publishStatus = xmlValue(xml, "publish_status") || xmlValue(xml, "PublishStatus");
      if (publishId) {
        const succeeded = publishStatus === "0";
        const job = this.db.prepare("SELECT id FROM wechat_publish_jobs WHERE account_id = ? AND publish_id = ? LIMIT 1")
          .get(accountId, publishId) as { id: string } | undefined;
        if (job) {
          const reason = succeeded ? "微信公众号回调确认发布成功" : `微信公众号回调确认发布失败，状态码：${publishStatus || "未知"}`;
          this.recordPublishStatus(job.id, succeeded ? "published" : "failed", succeeded ? null : reason, reason, now);
        }
      }
    } else if (event === "MASSSENDJOBFINISH") {
      const messageId = xmlValue(xml, "MsgID");
      const status = xmlValue(xml, "Status");
      if (messageId) {
        const succeeded = /^(?:send success|success)$/i.test(status);
        const job = this.db.prepare("SELECT id FROM wechat_publish_jobs WHERE account_id = ? AND message_id = ? LIMIT 1")
          .get(accountId, messageId) as { id: string } | undefined;
        // Some WeChat responses encode the 64-bit msg_id as a JSON number, which
        // can lose precision in JavaScript. A subscription account has only one
        // active all-followers mass send in this flow, so fall back to its latest
        // submitted mass job when an exact correlation is impossible.
        const fallback = job ?? this.db.prepare(`SELECT id FROM wechat_publish_jobs
          WHERE account_id = ? AND mode = 'mass' AND status = 'submitted'
          ORDER BY updated_at DESC LIMIT 1`).get(accountId) as { id: string } | undefined;
        if (fallback) {
          const reason = succeeded ? "微信公众号群发回调确认发送成功" : `微信公众号群发回调确认失败：${status || "未知原因"}`;
          this.recordPublishStatus(fallback.id, succeeded ? "published" : "failed", succeeded ? null : reason, reason, now);
        }
      }
    }
    this.db.prepare("UPDATE callback_events SET processed_at = ? WHERE workspace_id = ? AND event_fingerprint = ?")
      .run(now, account.workspaceId, fingerprint);
  }

  private recordPublishStatus(jobId: string, status: "published" | "failed", errorMessage: string | null, reason: string, now: string): void {
    this.db.transaction(() => {
      const current = this.db.prepare("SELECT status FROM wechat_publish_jobs WHERE id = ?").get(jobId) as { status: string } | undefined;
      if (!current) return;
      this.db.prepare("UPDATE wechat_publish_jobs SET status = ?, error_message = ?, status_source = 'wechat', status_note = NULL, updated_at = ? WHERE id = ?")
        .run(status, errorMessage, now, jobId);
      this.db.prepare(`INSERT INTO wechat_publish_job_events
        (id, job_id, previous_status, new_status, source, reason, created_at)
        VALUES (?, ?, ?, ?, 'wechat', ?, ?)`)
        .run(randomUUID(), jobId, current.status, status, reason, now);
    })();
  }
}

function xmlValue(xml: string, tag: string): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<${escapedTag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${escapedTag}>|<${escapedTag}>([\\s\\S]*?)</${escapedTag}>`, "i").exec(xml);
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

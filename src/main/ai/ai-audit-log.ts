import fs from "node:fs";
import path from "node:path";

/**
 * Opt-in, full-content audit log for model calls.
 *
 * This is intentionally separate from the daily runtime log in
 * `logging/daily-log-stream.ts`. That log only records HTTP metadata and must
 * never contain article bodies (per AGENTS.md: "日志不得记录完整正文").
 * The audit log is the opposite: once the user explicitly enables it, every
 * call records the COMPLETE prompt and response so a failure can be reproduced.
 * Nothing is truncated, because truncation would defeat the purpose.
 *
 * The file lives under the user's data directory (`<dataDir>/logs/ai-audit`),
 * so it follows the data directory the user chose and is covered by whatever
 * backup/encryption they apply there. API keys and auth headers are not part
 * of the prompt/response, so they are never written here.
 */

const RETENTION_DAYS = 30;
const FILE_NAME_PREFIX = "ai-audit-";

export interface AiAuditCall {
  task: string;
  skillId: string | undefined;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
  durationMs: number;
  ok: boolean;
  prompt: string;
  response: string | null;
  error: string | null;
  /** Summary of app-owned web retrieval, when the call was a 联网补研. */
  retrieval?: { rounds: number; sources: number; provider: string | null } | null;
}

export interface AiAuditEntry extends AiAuditCall {
  ts: string;
}

export function auditLogDirectory(dataDir: string): string {
  return path.join(dataDir, "logs", "ai-audit");
}

export class AiAuditLog {
  constructor(
    private readonly dataDir: string,
    private readonly isEnabled: () => boolean = () => true
  ) {}

  record(call: AiAuditCall): void {
    if (!this.isEnabled()) return;
    const directory = auditLogDirectory(this.dataDir);
    fs.mkdirSync(directory, { recursive: true });
    this.pruneStaleFiles(directory);
    const entry: AiAuditEntry = { ts: new Date().toISOString(), ...call };
    const line = `${JSON.stringify(entry)}\n`;
    const file = path.join(directory, `${FILE_NAME_PREFIX}${today()}.log`);
    fs.appendFileSync(file, line, "utf8");
  }

  clear(): void {
    const directory = auditLogDirectory(this.dataDir);
    if (!fs.existsSync(directory)) return;
    fs.rmSync(directory, { recursive: true, force: true });
  }

  private pruneStaleFiles(directory: string): void {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(directory)) {
      const match = /^ai-audit-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name);
      if (!match) continue;
      const file = path.join(directory, name);
      if (fs.statSync(file).mtimeMs < cutoff) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // Best-effort cleanup; a locked file will be retried next call.
        }
      }
    }
  }
}

function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

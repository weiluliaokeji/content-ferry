import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ExecutionArtifact, ExecutionPreflight, ExecutionRequest, ExecutionResult, ExecutionStatus } from "./execution-service";

export interface ExecutionRunRecord {
  id: string;
  projectId: string | null;
  request: Omit<ExecutionRequest, "confirmed">;
  preflight: ExecutionPreflight;
  status: ExecutionStatus | "running" | "interrupted";
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  errorMessage: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  artifacts: ExecutionArtifact[];
  authorization: ExecutionAuthorizationRecord | null;
}

export interface ExecutionAuthorizationRecord {
  confirmed: boolean;
  checks: Array<{
    action: string;
    decision: "allow" | "ask";
    reason: string;
    matchedScope: string | null;
  }>;
}

export class ExecutionRepository {
  constructor(private readonly db: Database.Database) {}

  create(request: ExecutionRequest, preflight: ExecutionPreflight, authorization: ExecutionAuthorizationRecord | null = null): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    const { confirmed: _confirmed, ...persistedRequest } = request;
    this.db.prepare(`INSERT INTO execution_runs
      (id, project_id, request_json, preflight_json, status, created_at)
      VALUES (?, ?, ?, ?, 'running', ?)`)
      .run(id, request.projectId ?? null, JSON.stringify({ ...persistedRequest, authorization }), JSON.stringify(preflight), now);
    return id;
  }

  recoverInterrupted(): number {
    const result = this.db.prepare("UPDATE execution_runs SET status = 'interrupted', error_message = '应用在运行期间退出；需用户重新确认后重试。', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'")
      .run(new Date().toISOString());
    return result.changes;
  }

  finish(id: string, result: ExecutionResult): ExecutionRunRecord {
    const now = new Date().toISOString();
    const storedStdout = result.stdout.slice(0, 1_048_576);
    const storedStderr = result.stderr.slice(0, 1_048_576);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE execution_runs SET status = ?, exit_code = ?, signal = ?, stdout = ?, stderr = ?,
        truncated = ?, finished_at = ?, error_message = '' WHERE id = ?`)
        .run(result.status, result.exitCode, result.signal, storedStdout, storedStderr, result.truncated ? 1 : 0, now, id);
      const insert = this.db.prepare(`INSERT INTO execution_artifacts
        (id, run_id, relative_path, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const artifact of result.artifacts) insert.run(randomUUID(), id, artifact.path, artifact.size, artifact.sha256, now);
    })();
    return this.require(id);
  }

  fail(id: string, error: unknown): ExecutionRunRecord {
    const now = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    this.db.prepare("UPDATE execution_runs SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?")
      .run(message.slice(0, 4000), now, id);
    return this.require(id);
  }

  require(id: string): ExecutionRunRecord {
    const row = this.db.prepare(`SELECT id, project_id AS projectId, request_json AS request,
      preflight_json AS preflight, status, exit_code AS exitCode, signal, stdout, stderr,
      truncated, error_message AS errorMessage, created_at AS createdAt, started_at AS startedAt,
      finished_at AS finishedAt FROM execution_runs WHERE id = ?`).get(id) as ExecutionRunRow | undefined;
    if (!row) throw new Error("找不到执行记录。");
    const artifacts = this.db.prepare(`SELECT relative_path AS path, size_bytes AS size, sha256
      FROM execution_artifacts WHERE run_id = ? ORDER BY relative_path`).all(id) as ExecutionArtifact[];
    const persisted = parseJson(row.request, {} as Omit<ExecutionRequest, "confirmed"> & { authorization?: ExecutionAuthorizationRecord | null });
    const { authorization = null, ...request } = persisted;
    return {
      ...row,
      projectId: row.projectId ?? null,
      request,
      preflight: parseJson(row.preflight, { available: false, targetType: "host_trusted", executable: "", resolvedCwd: "", warnings: [] }),
      exitCode: row.exitCode ?? null,
      signal: row.signal ?? null,
      truncated: Boolean(row.truncated),
      startedAt: row.startedAt ?? null,
      finishedAt: row.finishedAt ?? null,
      artifacts,
      authorization
    };
  }

  list(projectId?: string): ExecutionRunRecord[] {
    const rows = projectId
      ? this.db.prepare("SELECT id FROM execution_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 100").all(projectId) as Array<{ id: string }>
      : this.db.prepare("SELECT id FROM execution_runs ORDER BY created_at DESC LIMIT 100").all() as Array<{ id: string }>;
    return rows.map((row) => this.require(row.id));
  }
}

interface ExecutionRunRow {
  id: string;
  projectId: string | null;
  request: string;
  preflight: string;
  status: ExecutionRunRecord["status"];
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: number;
  errorMessage: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

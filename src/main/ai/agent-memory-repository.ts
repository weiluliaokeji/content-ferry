import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

// A desktop instance normally has one SQLite connection, but several route and
// service objects can share it. Keep maintenance single-flight per connection
// so startup and chat-triggered passes cannot race each other.
const activeMaintenanceDatabases = new WeakSet<object>();

export type AgentMemoryKind = "article_fact" | "writing_preference" | "series_rule" | "platform_rule" | "tool_experience" | "session";
export type AgentMemoryStatus = "candidate" | "active" | "superseded" | "expired" | "rejected" | "deleted";

export interface MemoryEventInput {
  scopeKey: string;
  eventType: string;
  payload: unknown;
  expiresAt?: string | null;
}

export interface MemoryCandidateInput {
  scopeKey: string;
  kind: AgentMemoryKind;
  content: string;
  sourceEventIds: string[];
  confidence?: number;
  importance?: number;
  expiresAt?: string | null;
}

export interface MemoryHit {
  id: string;
  scopeKey: string;
  kind: AgentMemoryKind;
  content: string;
  sourceEventIds: string[];
  confidence: number;
  importance: number;
  recallCount: number;
}

export interface MemoryContext {
  text: string;
  ids: string[];
}

export interface MemoryRecord extends MemoryHit {
  status: AgentMemoryStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface MemoryCandidateRecord {
  id: string;
  scopeKey: string;
  kind: AgentMemoryKind;
  content: string;
  sourceEventIds: string[];
  status: AgentMemoryStatus;
  supportCount: number;
  confidence: number;
  importance: number;
  promotedMemoryId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

export interface AgentMemorySnapshot {
  version: 1;
  exportedAt: string;
  scopes: string[];
  events: Array<{ id: string; scopeKey: string; eventType: string; payload: unknown; createdAt: string; expiresAt: string | null }>;
  candidates: Array<MemoryCandidateRecord>;
  memories: Array<MemoryRecord>;
}

export interface AgentMemoryImportResult {
  events: number;
  candidates: number;
  memories: number;
  mode: "merge" | "replace";
}

/**
 * Formal memory persistence seam. It deliberately does not call a model:
 * extraction and semantic conflict decisions belong to a later maintenance
 * worker, while this module keeps event, candidate and derived-memory state
 * deterministic and recoverable.
 */
export class AgentMemoryRepository {
  constructor(private readonly db: Database.Database) {}

  appendEvent(input: MemoryEventInput): string {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO agent_events (id, scope_key, event_type, payload_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, input.scopeKey, input.eventType, JSON.stringify(input.payload), new Date().toISOString(), input.expiresAt ?? null);
    return id;
  }

  addCandidate(input: MemoryCandidateInput): string {
    const content = normalize(input.content);
    if (!content) throw new Error("记忆候选不能为空。");
    const now = new Date().toISOString();
    const hash = fingerprint(input.scopeKey, input.kind, content);
    const existing = this.db.prepare(`SELECT id, source_event_ids_json AS sourceEventIdsJson, support_count AS supportCount
      FROM memory_candidates WHERE scope_key = ? AND content_hash = ?`)
      .get(input.scopeKey, hash) as { id: string; sourceEventIdsJson: string; supportCount: number } | undefined;
    if (existing) {
      const sourceEventIds = mergeIds(parseIds(existing.sourceEventIdsJson), input.sourceEventIds);
      this.db.prepare(`UPDATE memory_candidates
        SET source_event_ids_json = ?, support_count = ?, updated_at = ?, confidence = MAX(confidence, ?), importance = MAX(importance, ?), status = CASE WHEN status = 'rejected' THEN 'candidate' ELSE status END
        WHERE id = ?`)
        .run(JSON.stringify(sourceEventIds), Math.max(existing.supportCount, sourceEventIds.length), now, input.confidence ?? 0, input.importance ?? 0, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO memory_candidates
      (id, scope_key, kind, content, content_hash, source_event_ids_json, status, support_count, confidence, importance, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?)`)
      .run(id, input.scopeKey, input.kind, content, hash, JSON.stringify(input.sourceEventIds), Math.max(1, input.sourceEventIds.length), input.confidence ?? 0, input.importance ?? 0, now, now, input.expiresAt ?? null);
    return id;
  }

  promoteCandidate(candidateId: string): string {
    const candidate = this.db.prepare(`SELECT id, scope_key AS scopeKey, kind, content, content_hash AS contentHash,
      source_event_ids_json AS sourceEventIdsJson, confidence, importance, expires_at AS expiresAt
      FROM memory_candidates WHERE id = ?`).get(candidateId) as CandidateRow | undefined;
    if (!candidate) throw new Error("找不到记忆候选。");
    const now = new Date().toISOString();
    const existing = this.db.prepare("SELECT id FROM agent_memories WHERE scope_key = ? AND content_hash = ?")
      .get(candidate.scopeKey, candidate.contentHash) as { id: string } | undefined;
    const memoryId = existing?.id ?? randomUUID();
    this.db.transaction(() => {
      if (existing) {
        this.db.prepare(`UPDATE agent_memories SET status = 'active', updated_at = ?, confidence = MAX(confidence, ?), importance = MAX(importance, ?), expires_at = ?, source_event_ids_json = ? WHERE id = ?`)
          .run(now, candidate.confidence, candidate.importance, candidate.expiresAt, candidate.sourceEventIdsJson, memoryId);
      } else {
        this.db.prepare(`INSERT INTO agent_memories
          (id, scope_key, kind, content, content_hash, source_event_ids_json, status, confidence, importance, created_at, updated_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
          .run(memoryId, candidate.scopeKey, candidate.kind, candidate.content, candidate.contentHash, candidate.sourceEventIdsJson, candidate.confidence, candidate.importance, now, now, candidate.expiresAt);
      }
      this.db.prepare("UPDATE memory_candidates SET status = 'active', promoted_memory_id = ?, updated_at = ? WHERE id = ?")
        .run(memoryId, now, candidateId);
    })();
    return memoryId;
  }

  retrieve(scopeKeys: string[], query = "", limit = 8): MemoryHit[] {
    if (scopeKeys.length === 0 || limit <= 0) return [];
    const placeholders = scopeKeys.map(() => "?").join(", ");
    const normalizedQuery = normalize(query);
    const rows = this.db.prepare(`SELECT id, scope_key AS scopeKey, kind, content, source_event_ids_json AS sourceEventIdsJson,
      confidence, importance, recall_count AS recallCount
      FROM agent_memories
      WHERE status = 'active' AND scope_key IN (${placeholders})
        AND (expires_at IS NULL OR expires_at > ?)
        AND (? = '' OR content LIKE ?)
      ORDER BY importance DESC, confidence DESC, updated_at DESC
      LIMIT ?`).all(...scopeKeys, new Date().toISOString(), normalizedQuery, `%${normalizedQuery}%`, limit) as MemoryRow[];
    return rows.map((row) => ({
      id: row.id,
      scopeKey: row.scopeKey,
      kind: row.kind as AgentMemoryKind,
      content: row.content,
      sourceEventIds: parseIds(row.sourceEventIdsJson),
      confidence: row.confidence,
      importance: row.importance,
      recallCount: row.recallCount
    }));
  }

  retrieveContext(scopeKeys: string[], query = "", limit = 8): MemoryContext {
    const hits = this.retrieve(scopeKeys, query, limit);
    return {
      ids: hits.map((hit) => hit.id),
      text: hits.map((hit) => `- [${hit.id}]（${hit.scopeKey}/${hit.kind}）${hit.content}`).join("\n")
    };
  }

  listMemories(scopeKeys: string[], status: AgentMemoryStatus | "all" = "active"): MemoryRecord[] {
    if (scopeKeys.length === 0) return [];
    const placeholders = scopeKeys.map(() => "?").join(", ");
    const statusClause = status === "all" ? "" : " AND status = ?";
    const params = status === "all" ? [...scopeKeys] : [...scopeKeys, status];
    const rows = this.db.prepare(`SELECT id, scope_key AS scopeKey, kind, content,
      source_event_ids_json AS sourceEventIdsJson, status, confidence, importance,
      recall_count AS recallCount, created_at AS createdAt, updated_at AS updatedAt, expires_at AS expiresAt
      FROM agent_memories WHERE scope_key IN (${placeholders})${statusClause}
      ORDER BY updated_at DESC`).all(...params) as MemoryRecordRow[];
    return rows.map(toMemoryRecord);
  }

  listCandidates(scopeKeys: string[], status: AgentMemoryStatus | "all" = "candidate"): MemoryCandidateRecord[] {
    if (scopeKeys.length === 0) return [];
    const placeholders = scopeKeys.map(() => "?").join(", ");
    const statusClause = status === "all" ? "" : " AND status = ?";
    const params = status === "all" ? [...scopeKeys] : [...scopeKeys, status];
    const rows = this.db.prepare(`SELECT id, scope_key AS scopeKey, kind, content,
      source_event_ids_json AS sourceEventIdsJson, status, support_count AS supportCount,
      confidence, importance, promoted_memory_id AS promotedMemoryId,
      created_at AS createdAt, updated_at AS updatedAt, expires_at AS expiresAt
      FROM memory_candidates WHERE scope_key IN (${placeholders})${statusClause}
      ORDER BY updated_at DESC`).all(...params) as CandidateRecord[];
    return rows.map((row) => ({
      id: row.id, scopeKey: row.scopeKey, kind: row.kind, content: row.content,
      sourceEventIds: parseIds(row.sourceEventIdsJson), status: row.status,
      supportCount: row.supportCount, confidence: row.confidence, importance: row.importance,
      promotedMemoryId: row.promotedMemoryId, createdAt: row.createdAt,
      updatedAt: row.updatedAt, expiresAt: row.expiresAt
    }));
  }

  setMemoryStatus(memoryId: string, status: Extract<AgentMemoryStatus, "active" | "expired" | "deleted">): boolean {
    const result = this.db.prepare("UPDATE agent_memories SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), memoryId);
    return result.changes > 0;
  }

  recordUse(memoryIds: string[], taskKey: string): void {
    if (memoryIds.length === 0) return;
    const now = new Date().toISOString();
    const insert = this.db.prepare("INSERT INTO memory_uses (id, memory_id, task_key, created_at) VALUES (?, ?, ?, ?)");
    const update = this.db.prepare("UPDATE agent_memories SET recall_count = recall_count + 1, last_used_at = ? WHERE id = ? AND status = 'active'");
    this.db.transaction(() => {
      for (const id of memoryIds) {
        insert.run(randomUUID(), id, taskKey, now);
        update.run(now, id);
      }
    })();
  }

  /** Promote only repeated low-risk writing/tool candidates. */
  consolidate(scopeKey?: string): number {
    const rows = this.db.prepare(`SELECT id, kind, support_count AS supportCount, status
      FROM memory_candidates WHERE status = 'candidate' ${scopeKey ? "AND scope_key = ?" : ""}`)
      .all(...(scopeKey ? [scopeKey] : [])) as Array<{ id: string; kind: AgentMemoryKind; supportCount: number; status: string }>;
    let promoted = 0;
    for (const row of rows) {
      if ((row.kind === "writing_preference" || row.kind === "tool_experience") && row.supportCount >= 3) {
        this.promoteCandidate(row.id);
        promoted++;
      }
    }
    return promoted;
  }

  forget(scopeKey: string, mode: "derived" | "all"): void {
    this.db.transaction(() => {
      const now = new Date().toISOString();
      if (mode === "all") {
        this.db.prepare("DELETE FROM memory_uses WHERE memory_id IN (SELECT id FROM agent_memories WHERE scope_key = ?)").run(scopeKey);
        this.db.prepare("DELETE FROM agent_memories WHERE scope_key = ?").run(scopeKey);
        this.db.prepare("DELETE FROM memory_candidates WHERE scope_key = ?").run(scopeKey);
        this.db.prepare("DELETE FROM agent_events WHERE scope_key = ?").run(scopeKey);
        this.db.prepare("DELETE FROM memory_maintenance_state WHERE scope_key = ?").run(scopeKey);
        // Chat rows are the compatibility store that Awen still reads for
        // conversation history. A full forget must remove them too, otherwise
        // the supposedly forgotten text is sent back to the model on the next
        // conversation turn.
        this.db.prepare("DELETE FROM article_chat_threads WHERE context_key = ?").run(scopeKey);
      } else {
        this.db.prepare("UPDATE agent_memories SET status = 'deleted', updated_at = ? WHERE scope_key = ?").run(now, scopeKey);
        this.db.prepare("UPDATE memory_candidates SET status = 'deleted', updated_at = ? WHERE scope_key = ?").run(now, scopeKey);
      }
      this.db.prepare("DELETE FROM writing_memories WHERE scope_key = ?").run(scopeKey);
      this.db.prepare("UPDATE article_chat_threads SET memory = '', updated_at = ? WHERE context_key = ?").run(now, scopeKey);
    })();
  }

  exportSnapshot(scopeKeys: string[], includeEvents = true): AgentMemorySnapshot {
    const scopes = [...new Set(scopeKeys.map((value) => value.trim()).filter(Boolean))];
    if (scopes.length === 0) throw new Error("至少指定一个记忆作用域。");
    const placeholders = scopes.map(() => "?").join(", ");
    const memories = this.listMemories(scopes, "all").filter((memory) => memory.status !== "deleted");
    const candidates = this.listCandidates(scopes, "all").filter((candidate) => candidate.status !== "deleted");
    const events = includeEvents
      ? (this.db.prepare(`SELECT id, scope_key AS scopeKey, event_type AS eventType, payload_json AS payloadJson,
          created_at AS createdAt, expires_at AS expiresAt FROM agent_events WHERE scope_key IN (${placeholders}) ORDER BY created_at ASC`).all(...scopes) as AgentEventRow[])
        .map((row) => ({ id: row.id, scopeKey: row.scopeKey, eventType: row.eventType, payload: parseJson(row.payloadJson), createdAt: row.createdAt, expiresAt: row.expiresAt }))
      : [];
    return { version: 1, exportedAt: new Date().toISOString(), scopes, events, candidates, memories };
  }

  importSnapshot(snapshot: unknown, mode: "merge" | "replace" = "merge"): AgentMemoryImportResult {
    const value = parseSnapshot(snapshot);
    const scopes = value.scopes;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      if (mode === "replace") {
        const placeholders = scopes.map(() => "?").join(", ");
        this.db.prepare(`DELETE FROM agent_memories WHERE scope_key IN (${placeholders})`).run(...scopes);
        this.db.prepare(`DELETE FROM memory_candidates WHERE scope_key IN (${placeholders})`).run(...scopes);
        this.db.prepare(`DELETE FROM agent_events WHERE scope_key IN (${placeholders})`).run(...scopes);
      }
      const insertEvent = this.db.prepare(`INSERT OR IGNORE INTO agent_events
        (id, scope_key, event_type, payload_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const event of value.events) insertEvent.run(event.id, event.scopeKey, event.eventType, JSON.stringify(event.payload), event.createdAt, event.expiresAt);
      for (const candidate of value.candidates) this.importCandidate(candidate, now);
      for (const memory of value.memories) this.importMemory(memory, now);
    })();
    return { events: value.events.length, candidates: value.candidates.length, memories: value.memories.length, mode };
  }

  maintain(): { expired: number; consolidated: number } {
    if (activeMaintenanceDatabases.has(this.db)) return { expired: 0, consolidated: 0 };
    activeMaintenanceDatabases.add(this.db);
    try {
      return this.maintainOnce();
    } finally {
      activeMaintenanceDatabases.delete(this.db);
    }
  }

  private maintainOnce(): { expired: number; consolidated: number } {
    const now = new Date().toISOString();
    const scopes = this.db.prepare(`SELECT scope_key AS scopeKey FROM agent_events
      UNION SELECT scope_key AS scopeKey FROM memory_candidates`).all() as Array<{ scopeKey: string }>;
    for (const row of scopes) {
      this.db.prepare(`INSERT INTO memory_maintenance_state (scope_key, watermark, status, updated_at, last_error)
        VALUES (?, NULL, 'running', ?, '') ON CONFLICT(scope_key) DO UPDATE SET status = 'running', updated_at = ?, last_error = ''`)
        .run(row.scopeKey, now, now);
    }
    try {
      const expired = this.db.prepare(`UPDATE agent_memories SET status = 'expired', updated_at = ?
        WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`).run(now, now).changes;
      this.db.prepare(`UPDATE memory_candidates SET status = 'expired', updated_at = ?
        WHERE status = 'candidate' AND expires_at IS NOT NULL AND expires_at <= ?`).run(now, now);
      const candidates = this.db.prepare(`SELECT DISTINCT scope_key AS scopeKey FROM memory_candidates
        WHERE status = 'candidate' AND (
          updated_at > COALESCE((SELECT watermark FROM memory_maintenance_state s WHERE s.scope_key = memory_candidates.scope_key), '')
          OR support_count >= 3
        )`).all() as Array<{ scopeKey: string }>;
      const consolidated = candidates.reduce((count, row) => count + this.consolidate(row.scopeKey), 0);
      for (const row of scopes) {
        const state = this.db.prepare("SELECT watermark FROM memory_maintenance_state WHERE scope_key = ?").get(row.scopeKey) as { watermark: string | null } | undefined;
        const latestEvent = this.db.prepare("SELECT MAX(created_at) AS latest FROM agent_events WHERE scope_key = ?").get(row.scopeKey) as { latest: string | null };
        const nextWatermark = latestEvent.latest ?? state?.watermark ?? null;
        const completedAt = new Date().toISOString();
        this.db.prepare(`INSERT INTO memory_maintenance_state (scope_key, watermark, status, updated_at, last_error)
          VALUES (?, ?, 'idle', ?, '') ON CONFLICT(scope_key) DO UPDATE SET watermark = excluded.watermark, status = 'idle', updated_at = excluded.updated_at, last_error = ''`)
          .run(row.scopeKey, nextWatermark, completedAt);
      }
      return { expired, consolidated };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const row of scopes) {
        this.db.prepare("UPDATE memory_maintenance_state SET status = 'failed', updated_at = ?, last_error = ? WHERE scope_key = ?")
          .run(new Date().toISOString(), message.slice(0, 1000), row.scopeKey);
      }
      throw error;
    }
  }

  private importCandidate(candidate: MemoryCandidateRecord, now: string): void {
    const content = normalize(candidate.content);
    const hash = fingerprint(candidate.scopeKey, candidate.kind, content);
    const existing = this.db.prepare("SELECT id, source_event_ids_json AS sourceEventIdsJson, support_count AS supportCount FROM memory_candidates WHERE scope_key = ? AND content_hash = ?")
      .get(candidate.scopeKey, hash) as { id: string; sourceEventIdsJson: string; supportCount: number } | undefined;
    if (existing) {
      this.db.prepare(`UPDATE memory_candidates SET source_event_ids_json = ?, support_count = MAX(support_count, ?),
        confidence = MAX(confidence, ?), importance = MAX(importance, ?), updated_at = ? WHERE id = ?`)
        .run(JSON.stringify(mergeIds(parseIds(existing.sourceEventIdsJson), candidate.sourceEventIds)), candidate.supportCount, candidate.confidence, candidate.importance, now, existing.id);
      return;
    }
    this.db.prepare(`INSERT OR IGNORE INTO memory_candidates
      (id, scope_key, kind, content, content_hash, source_event_ids_json, status, support_count, confidence, importance, created_at, updated_at, expires_at, promoted_memory_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(candidate.id, candidate.scopeKey, candidate.kind, content, hash, JSON.stringify(candidate.sourceEventIds), candidate.status, candidate.supportCount, candidate.confidence, candidate.importance, candidate.createdAt, now, candidate.expiresAt, candidate.promotedMemoryId);
  }

  private importMemory(memory: MemoryRecord, now: string): void {
    const content = normalize(memory.content);
    const hash = fingerprint(memory.scopeKey, memory.kind, content);
    const existing = this.db.prepare("SELECT id, source_event_ids_json AS sourceEventIdsJson FROM agent_memories WHERE scope_key = ? AND content_hash = ?")
      .get(memory.scopeKey, hash) as { id: string; sourceEventIdsJson: string } | undefined;
    if (existing) {
      this.db.prepare(`UPDATE agent_memories SET status = CASE WHEN status = 'deleted' THEN status ELSE ? END,
        source_event_ids_json = ?, confidence = MAX(confidence, ?), importance = MAX(importance, ?),
        recall_count = MAX(recall_count, ?), updated_at = ?, expires_at = ? WHERE id = ?`)
        .run(memory.status, JSON.stringify(mergeIds(parseIds(existing.sourceEventIdsJson), memory.sourceEventIds)), memory.confidence, memory.importance, memory.recallCount, now, memory.expiresAt, existing.id);
      return;
    }
    this.db.prepare(`INSERT OR IGNORE INTO agent_memories
      (id, scope_key, kind, content, content_hash, source_event_ids_json, status, confidence, importance, created_at, updated_at, last_used_at, recall_count, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(memory.id, memory.scopeKey, memory.kind, content, hash, JSON.stringify(memory.sourceEventIds), memory.status, memory.confidence, memory.importance, memory.createdAt, now, null, memory.recallCount, memory.expiresAt);
  }
}

interface CandidateRow {
  id: string; scopeKey: string; kind: AgentMemoryKind; content: string; contentHash: string;
  sourceEventIdsJson: string; confidence: number; importance: number; expiresAt: string | null;
}

interface MemoryRow {
  id: string; scopeKey: string; kind: string; content: string; sourceEventIdsJson: string;
  confidence: number; importance: number; recallCount: number;
}

interface MemoryRecordRow extends MemoryRow {
  status: AgentMemoryStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

interface CandidateRecord {
  id: string; scopeKey: string; kind: AgentMemoryKind; content: string;
  sourceEventIdsJson: string; status: AgentMemoryStatus; supportCount: number;
  confidence: number; importance: number; promotedMemoryId: string | null;
  createdAt: string; updatedAt: string; expiresAt: string | null;
}

interface AgentEventRow { id: string; scopeKey: string; eventType: string; payloadJson: string; createdAt: string; expiresAt: string | null; }

function toMemoryRecord(row: MemoryRecordRow): MemoryRecord {
  return {
    id: row.id, scopeKey: row.scopeKey, kind: row.kind as AgentMemoryKind,
    content: row.content, sourceEventIds: parseIds(row.sourceEventIdsJson),
    status: row.status, confidence: row.confidence, importance: row.importance,
    recallCount: row.recallCount, createdAt: row.createdAt, updatedAt: row.updatedAt,
    expiresAt: row.expiresAt
  };
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function fingerprint(scopeKey: string, kind: AgentMemoryKind, content: string): string {
  return createHash("sha256").update(`${scopeKey}\n${kind}\n${content}`).digest("hex");
}

function parseIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item: unknown): item is string => typeof item === "string") : [];
  }
  catch { return []; }
}

function mergeIds(first: string[], second: string[]): string[] {
  return [...new Set([...first, ...second])];
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { return {}; }
}

function parseSnapshot(value: unknown): AgentMemorySnapshot {
  if (!value || typeof value !== "object") throw new Error("记忆备份格式不正确。");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.scopes) || !Array.isArray(record.events) || !Array.isArray(record.candidates) || !Array.isArray(record.memories)) {
    throw new Error("记忆备份版本或字段不受支持。");
  }
  const scopes = [...new Set(record.scopes.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))];
  if (scopes.length === 0 || scopes.length > 100) throw new Error("记忆备份必须包含 1 至 100 个作用域。");
  const eventValues = record.events as unknown[];
  const candidateValues = record.candidates as unknown[];
  const memoryValues = record.memories as unknown[];
  if (eventValues.length > 20_000 || candidateValues.length > 10_000 || memoryValues.length > 10_000) throw new Error("记忆备份条目过多，已拒绝导入。");
  const events = eventValues.map((item) => {
    if (!item || typeof item !== "object") throw new Error("记忆事件格式不正确。");
    const event = item as Record<string, unknown>;
    if (typeof event.id !== "string" || event.id.length > 100 || typeof event.scopeKey !== "string" || !scopes.includes(event.scopeKey) || typeof event.eventType !== "string" || event.eventType.length > 200 || typeof event.createdAt !== "string") throw new Error("记忆事件缺少必要字段。");
    return { id: event.id, scopeKey: event.scopeKey, eventType: event.eventType, payload: event.payload, createdAt: event.createdAt, expiresAt: typeof event.expiresAt === "string" ? event.expiresAt : null };
  });
  const candidates = candidateValues.map((item) => parseCandidateRecord(item, scopes));
  const memories = memoryValues.map((item) => parseMemoryRecord(item, scopes));
  return { version: 1, exportedAt: typeof record.exportedAt === "string" ? record.exportedAt : new Date().toISOString(), scopes, events, candidates, memories };
}

function parseCandidateRecord(value: unknown, scopes: string[]): MemoryCandidateRecord {
  if (!isRecord(value) || !isScopedMemoryRecord(value, scopes) || !isAgentMemoryKind(value.kind) || !isAgentMemoryStatus(value.status)
    || !isStringArray(value.sourceEventIds, 1000) || !isFiniteNumber(value.supportCount, 0, 100000)
    || !isFiniteNumber(value.confidence, 0, 1) || !isFiniteNumber(value.importance, 0, 1)
    || (value.promotedMemoryId !== null && typeof value.promotedMemoryId !== "string")
    || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string"
    || (value.expiresAt !== null && typeof value.expiresAt !== "string")) {
    throw new Error("记忆候选记录格式不正确或作用域不匹配。");
  }
  return value as unknown as MemoryCandidateRecord;
}

function parseMemoryRecord(value: unknown, scopes: string[]): MemoryRecord {
  if (!isRecord(value) || !isScopedMemoryRecord(value, scopes) || !isAgentMemoryKind(value.kind) || !isAgentMemoryStatus(value.status)
    || !isStringArray(value.sourceEventIds, 1000) || !isFiniteNumber(value.confidence, 0, 1)
    || !isFiniteNumber(value.importance, 0, 1) || !isFiniteNumber(value.recallCount, 0, 100000000)
    || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string"
    || (value.expiresAt !== null && typeof value.expiresAt !== "string")) {
    throw new Error("长期记忆记录格式不正确或作用域不匹配。");
  }
  return value as unknown as MemoryRecord;
}

function isScopedMemoryRecord(value: Record<string, unknown>, scopes: string[]): boolean {
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 100
    && typeof value.scopeKey === "string" && scopes.includes(value.scopeKey)
    && typeof value.content === "string" && value.content.trim().length > 0 && value.content.length <= 10000;
}

function isStringArray(value: unknown, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxLength && value.every((item) => typeof item === "string" && item.length <= 100);
}

function isFiniteNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isAgentMemoryKind(value: unknown): value is AgentMemoryKind {
  return value === "article_fact" || value === "writing_preference" || value === "series_rule" || value === "platform_rule" || value === "tool_experience" || value === "session";
}

function isAgentMemoryStatus(value: unknown): value is AgentMemoryStatus {
  return value === "candidate" || value === "active" || value === "superseded" || value === "expired" || value === "rejected" || value === "deleted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

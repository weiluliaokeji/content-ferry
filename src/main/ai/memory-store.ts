import type Database from "better-sqlite3";

/**
 * Small persistence seam for the current memory MVP.
 *
 * The storage is intentionally still backed by the existing tables. The
 * interface hides SQL and the legacy newline format from callers, so the later
 * candidate/long-term memory migration has one place to replace.
 */
export class SqliteMemoryStore {
  constructor(private readonly db: Database.Database) {}

  getArticle(contextKey: string): string {
    const row = this.db.prepare("SELECT memory FROM article_chat_threads WHERE context_key = ?")
      .get(contextKey) as { memory: string } | undefined;
    return row?.memory ?? "";
  }

  mergeArticle(contextKey: string, candidate: string): string {
    const normalized = normalize(candidate);
    const current = this.getArticle(contextKey);
    if (!normalized) return current;
    const memory = mergeLines(current, normalized, 20, 6000);
    this.db.prepare(`INSERT INTO article_chat_threads (context_key, memory, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(context_key) DO UPDATE SET memory = excluded.memory, updated_at = excluded.updated_at`)
      .run(contextKey, memory, new Date().toISOString());
    return memory;
  }

  getWriting(scopeKey: string): string {
    const row = this.db.prepare("SELECT memory FROM writing_memories WHERE scope_key = ?")
      .get(scopeKey) as { memory: string } | undefined;
    return row?.memory ?? "";
  }

  mergeWriting(scopeKey: string, candidate: string): string {
    const normalized = normalize(candidate);
    const current = this.getWriting(scopeKey);
    if (!normalized) return current;
    const memory = mergeLines(current, normalized, 30, 8000);
    this.db.prepare(`INSERT INTO writing_memories (scope_key, memory, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET memory = excluded.memory, updated_at = excluded.updated_at`)
      .run(scopeKey, memory, new Date().toISOString());
    return memory;
  }
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function mergeLines(current: string, candidate: string, maxEntries: number, maxLength: number): string {
  const entries = current.split("\n")
    .map((item) => item.replace(/^-\s*/, "").trim())
    .filter(Boolean);
  if (!entries.includes(candidate)) entries.push(candidate);
  return entries.slice(-maxEntries).map((item) => `- ${item}`).join("\n").slice(0, maxLength);
}

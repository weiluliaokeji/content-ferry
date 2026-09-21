import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ImageSearchResultItem } from "../ai/web-search";

export interface ImageSearchHistoryRecord {
  id: string;
  contextKey: string;
  query: string;
  provider: string | null;
  items: ImageSearchResultItem[];
  createdAt: string;
}

const MAX_HISTORY_PER_CONTEXT = 30;

export class ImageSearchHistoryRepository {
  constructor(private readonly db: Database.Database) {}

  list(contextKey: string, limit = MAX_HISTORY_PER_CONTEXT): ImageSearchHistoryRecord[] {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), MAX_HISTORY_PER_CONTEXT);
    const rows = this.db.prepare(`SELECT id, context_key, query, provider, items_json, created_at
      FROM image_search_history WHERE context_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(contextKey, safeLimit) as Array<{ id: string; context_key: string; query: string; provider: string | null; items_json: string; created_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      contextKey: row.context_key,
      query: row.query,
      provider: row.provider,
      items: parseItems(row.items_json),
      createdAt: row.created_at
    }));
  }

  add(contextKey: string, query: string, provider: string | null, items: ImageSearchResultItem[]): ImageSearchHistoryRecord {
    const record: ImageSearchHistoryRecord = {
      id: randomUUID(),
      contextKey,
      query,
      provider,
      items,
      createdAt: new Date().toISOString()
    };
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO image_search_history (id, context_key, query, provider, items_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(record.id, record.contextKey, record.query, record.provider, JSON.stringify(record.items), record.createdAt);
      this.db.prepare(`DELETE FROM image_search_history
        WHERE context_key = ? AND id NOT IN (
          SELECT id FROM image_search_history WHERE context_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
        )`).run(record.contextKey, record.contextKey, MAX_HISTORY_PER_CONTEXT);
    })();
    return record;
  }
}

function parseItems(value: string): ImageSearchResultItem[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isImageSearchResultItem);
  } catch {
    return [];
  }
}

function isImageSearchResultItem(value: unknown): value is ImageSearchResultItem {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.imageUrl !== "string" || typeof candidate.caption !== "string") return false;
  if (!isNullableString(candidate.thumbnailUrl) || !isNullableString(candidate.sourceUrl) || !isNullableString(candidate.sourceTitle)) return false;
  if (candidate.review === undefined) return true;
  if (!candidate.review || typeof candidate.review !== "object") return false;
  const review = candidate.review as Record<string, unknown>;
  return (review.status === "accepted" || review.status === "uncertain" || review.status === "rejected" || review.status === "unreviewed" || review.status === "failed")
    && (review.score === null || typeof review.score === "number")
    && typeof review.reason === "string";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

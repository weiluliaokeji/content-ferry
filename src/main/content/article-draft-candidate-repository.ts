import type Database from "better-sqlite3";
import { contentRevisionSha256 } from "./content-generation-review-repository";

export interface ArticleDraftCandidate {
  runId: string;
  markdown: string;
  revisionSha256: string;
  createdAt: string;
  updatedAt: string;
}

interface CandidateRow {
  run_id: string;
  markdown: string;
  revision_sha256: string;
  created_at: string;
  updated_at: string;
}

/** Keeps unapproved prose outside the formal article and content_drafts tables. */
export class ArticleDraftCandidateRepository {
  constructor(private readonly db: Database.Database) {}

  save(runId: string, markdown: string, now = new Date()): ArticleDraftCandidate {
    const candidate = markdown.trim();
    if (!candidate) throw new Error("不能保存空的正文候选稿。");
    if (!this.db.prepare("SELECT 1 FROM article_draft_runs WHERE id = ?").get(runId)) throw new Error("找不到正文起草运行记录。");
    const at = now.toISOString();
    const hash = contentRevisionSha256(candidate);
    this.db.prepare(`INSERT INTO article_draft_candidates (run_id, markdown, revision_sha256, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET markdown = excluded.markdown,
      revision_sha256 = excluded.revision_sha256, updated_at = excluded.updated_at`)
      .run(runId, candidate, hash, at, at);
    return this.require(runId);
  }

  get(runId: string): ArticleDraftCandidate | null {
    const row = this.db.prepare("SELECT * FROM article_draft_candidates WHERE run_id = ?").get(runId) as CandidateRow | undefined;
    return row ? toCandidate(row) : null;
  }

  require(runId: string): ArticleDraftCandidate {
    const candidate = this.get(runId);
    if (!candidate) throw new Error("找不到可恢复的正文候选稿。");
    return candidate;
  }
}

function toCandidate(row: CandidateRow): ArticleDraftCandidate {
  return { runId: row.run_id, markdown: row.markdown, revisionSha256: row.revision_sha256,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

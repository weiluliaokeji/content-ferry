import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ResearchEvidence } from "../../shared/research-evidence";
import { normalizeResearchUrl } from "./content-research-repository";

export interface ArticleResearchLink {
  id: string;
  projectId: string;
  sourceId: string;
  claimText: string;
  supportingExcerpt: string;
  sourceTitle: string;
  sourceUrl: string;
  retrievedAt: string;
  status: "pending_author" | "confirmed" | "rejected" | "needs_recheck";
}

export interface CandidateResearchAssociation {
  sourceId: string;
  claimText: string;
  supportingExcerpt: string;
}

type SourceRow = {
  id: string; title: string; url: string; retrieved_at: string; adoption_status: string; evidence_json: string;
};

/** Stores claim-to-source use without making article Markdown a second database body. */
export class ArticleResearchLinkRepository {
  constructor(private readonly db: Database.Database) {}

  saveCandidateLinks(projectId: string, markdown: string, associations: readonly CandidateResearchAssociation[]): { saved: number; rejected: number } {
    const now = new Date().toISOString();
    let saved = 0;
    let rejected = 0;
    this.db.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO article_research_links
        (id, project_id, source_id, claim_text, paragraph_sha256, supporting_excerpt, snapshot_sha256, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_author', ?, ?)`);
      for (const item of associations) {
        const source = this.source(projectId, item.sourceId);
        const claimText = item.claimText.trim();
        const supportingExcerpt = item.supportingExcerpt.trim();
        const paragraph = uniqueParagraph(markdown, claimText);
        const snapshot = snapshots(source?.evidence_json).find((entry) =>
          normalizeResearchUrl(entry.url) === normalizeResearchUrl(source?.url ?? "") && entry.excerpt.includes(supportingExcerpt));
        if (!source || source.adoption_status !== "recommended" || !/^https?:\/\//iu.test(source.url) || !paragraph || !snapshot ||
          claimText.length < 8 || claimText.length > 500 || supportingExcerpt.length < 8 || supportingExcerpt.length > 500) {
          rejected += 1;
          continue;
        }
        const paragraphSha256 = sha256(normalizeParagraph(paragraph));
        const exists = this.db.prepare(`SELECT 1 FROM article_research_links WHERE project_id = ? AND source_id = ?
          AND claim_text = ? AND paragraph_sha256 = ? AND snapshot_sha256 = ? AND status != 'rejected'`)
          .get(projectId, source.id, claimText, paragraphSha256, snapshot.sha256);
        if (exists) continue;
        insert.run(randomUUID(), projectId, source.id, claimText, paragraphSha256, supportingExcerpt, snapshot.sha256, now, now);
        saved += 1;
      }
    })();
    return { saved, rejected };
  }

  list(projectId: string, markdown: string): ArticleResearchLink[] {
    const rows = this.db.prepare(`SELECT l.id, l.project_id, l.source_id, l.claim_text, l.paragraph_sha256,
        l.supporting_excerpt, l.snapshot_sha256, l.status, s.title, s.url, s.retrieved_at, s.adoption_status, s.evidence_json
      FROM article_research_links l JOIN content_research_sources s ON s.id = l.source_id
      WHERE l.project_id = ? ORDER BY l.created_at, l.id`).all(projectId) as Array<Record<string, string>>;
    return rows.filter((row) => markdown.includes(row.claim_text)).map((row) => {
      const paragraph = uniqueParagraph(markdown, row.claim_text);
      const unchanged = paragraph && sha256(normalizeParagraph(paragraph)) === row.paragraph_sha256;
      const sourceUnchanged = snapshots(row.evidence_json).some((entry) =>
        normalizeResearchUrl(entry.url) === normalizeResearchUrl(row.url) &&
        entry.sha256 === row.snapshot_sha256 && entry.excerpt.includes(row.supporting_excerpt));
      const status = unchanged && sourceUnchanged && row.adoption_status !== "rejected"
        ? row.status as ArticleResearchLink["status"] : "needs_recheck";
      return {
        id: row.id, projectId: row.project_id, sourceId: row.source_id, claimText: row.claim_text,
        supportingExcerpt: row.supporting_excerpt, sourceTitle: row.title, sourceUrl: row.url,
        retrievedAt: row.retrieved_at, status
      };
    });
  }

  decide(projectId: string, linkId: string, markdown: string, decision: "confirmed" | "rejected"): ArticleResearchLink {
    const link = this.list(projectId, markdown).find((item) => item.id === linkId);
    if (!link) throw new Error("找不到这处文章来源关联。");
    if (decision === "confirmed") {
      const row = this.db.prepare(`SELECT l.snapshot_sha256, s.url, s.adoption_status, s.evidence_json
        FROM article_research_links l JOIN content_research_sources s ON s.id = l.source_id
        WHERE l.id = ? AND l.project_id = ?`).get(linkId, projectId) as
        { snapshot_sha256: string; url: string; adoption_status: string; evidence_json: string } | undefined;
      const sourceValid = row?.adoption_status !== "rejected" && snapshots(row?.evidence_json).some((entry) =>
        normalizeResearchUrl(entry.url) === normalizeResearchUrl(row?.url ?? "") &&
        entry.sha256 === row?.snapshot_sha256 && entry.excerpt.includes(link.supportingExcerpt));
      const paragraph = uniqueParagraph(markdown, link.claimText);
      if (!sourceValid || !paragraph) throw new Error("正文或来源已变化，无法直接确认；请重新核对事实与来源。");
      this.db.prepare(`UPDATE article_research_links SET status = 'confirmed', paragraph_sha256 = ?, updated_at = ?
        WHERE id = ? AND project_id = ?`).run(sha256(normalizeParagraph(paragraph)), new Date().toISOString(), linkId, projectId);
    } else {
      this.db.prepare("UPDATE article_research_links SET status = ?, updated_at = ? WHERE id = ? AND project_id = ?")
        .run(decision, new Date().toISOString(), linkId, projectId);
    }
    return { ...link, status: decision };
  }

  private source(projectId: string, sourceId: string): SourceRow | undefined {
    return this.db.prepare(`SELECT id, title, url, retrieved_at, adoption_status, evidence_json FROM content_research_sources
      WHERE project_id = ? AND id = ?`).get(projectId, sourceId) as SourceRow | undefined;
  }
}

function snapshots(value: string | undefined): NonNullable<ResearchEvidence["snapshots"]> {
  try {
    const parsed = JSON.parse(value ?? "{}") as Partial<ResearchEvidence>;
    if (parsed.kind === "manual") return [];
    return Array.isArray(parsed.snapshots) ? parsed.snapshots.filter((item) =>
      typeof item.url === "string" && typeof item.excerpt === "string" && item.excerpt.trim().length >= 8 &&
      typeof item.sha256 === "string" && /^[a-f0-9]{64}$/iu.test(item.sha256)) : [];
  } catch { return []; }
}

function uniqueParagraph(markdown: string, claimText: string): string | undefined {
  if (!claimText || markdown.indexOf(claimText) < 0 || markdown.indexOf(claimText) !== markdown.lastIndexOf(claimText)) return undefined;
  const paragraphs = markdown.split(/\n\s*\n/u).map((paragraph) => paragraph.trim());
  return paragraphs.find((paragraph) => paragraph.includes(claimText));
}

function normalizeParagraph(value: string): string { return value.replace(/\s+/gu, " ").trim(); }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

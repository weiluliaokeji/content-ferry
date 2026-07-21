import type Database from "better-sqlite3";

export type ReviewStatus = "pending" | "needs_revision" | "approved";
export interface ContentReview { projectId: string; status: ReviewStatus; factChecked: boolean; accountFitChecked: boolean; aiCheckResult: string; notes: string; }

export class ContentReviewRepository {
  constructor(private readonly db: Database.Database) {}

  get(projectId: string): ContentReview {
    const row = this.db.prepare(`SELECT p.id, r.status, r.fact_checked, r.account_fit_checked, r.ai_check_result, r.notes
      FROM content_projects p LEFT JOIN content_reviews r ON r.project_id = p.id WHERE p.id = ?`).get(projectId) as Record<string, string | number | null> | undefined;
    if (!row) throw new Error("Content project not found.");
    return { projectId, status: (row.status as ReviewStatus | null) ?? "pending", factChecked: Boolean(row.fact_checked), accountFitChecked: Boolean(row.account_fit_checked), aiCheckResult: (row.ai_check_result as string | null) ?? "", notes: (row.notes as string | null) ?? "" };
  }

  save(projectId: string, review: Omit<ContentReview, "projectId">): ContentReview {
    this.get(projectId);
    this.db.prepare(`INSERT INTO content_reviews (project_id, status, fact_checked, account_fit_checked, ai_check_result, notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET status = excluded.status,
      fact_checked = excluded.fact_checked, account_fit_checked = excluded.account_fit_checked,
      ai_check_result = excluded.ai_check_result, notes = excluded.notes, updated_at = excluded.updated_at`)
      .run(projectId, review.status, review.factChecked ? 1 : 0, review.accountFitChecked ? 1 : 0, review.aiCheckResult, review.notes, new Date().toISOString());
    return { projectId, ...review };
  }
}

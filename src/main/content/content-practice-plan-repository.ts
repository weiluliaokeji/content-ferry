import type Database from "better-sqlite3";

export type PracticePlanStatus = "draft" | "confirmed" | "skipped";

export interface ContentPracticePlan {
  projectId: string;
  markdown: string;
  status: PracticePlanStatus;
  updatedAt: string;
}

export class ContentPracticePlanRepository {
  constructor(private readonly db: Database.Database) {}

  get(projectId: string): ContentPracticePlan | null {
    const row = this.db.prepare("SELECT project_id, markdown, status, updated_at FROM content_practice_plans WHERE project_id = ?")
      .get(projectId) as { project_id: string; markdown: string; status: PracticePlanStatus; updated_at: string } | undefined;
    return row ? { projectId: row.project_id, markdown: row.markdown, status: row.status, updatedAt: row.updated_at } : null;
  }

  save(projectId: string, markdown: string, status: PracticePlanStatus): ContentPracticePlan {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO content_practice_plans (project_id, markdown, status, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET markdown = excluded.markdown, status = excluded.status, updated_at = excluded.updated_at`)
      .run(projectId, markdown, status, updatedAt);
    return { projectId, markdown, status, updatedAt };
  }
}

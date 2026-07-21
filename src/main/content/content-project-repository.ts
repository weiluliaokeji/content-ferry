import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface ContentProject {
  id: string;
  workspaceId: string;
  targetAccountId: string | null;
  sourceRelativePath: string | null;
  topic: string;
  status: "idea";
  createdAt: string;
  updatedAt: string;
  briefReady: boolean;
  outlineReady: boolean;
  draftReady: boolean;
  reviewStatus: "pending" | "needs_revision" | "approved" | null;
}

export class ContentProjectRepository {
  constructor(private readonly db: Database.Database) {}

  list(workspaceId: string): ContentProject[] {
    return (this.db.prepare(`SELECT p.id, p.workspace_id, p.target_account_id, p.source_relative_path, p.topic, p.status, p.created_at, p.updated_at,
      EXISTS(SELECT 1 FROM content_briefs b WHERE b.project_id = p.id) AS brief_ready,
      EXISTS(SELECT 1 FROM content_outlines o WHERE o.project_id = p.id) AS outline_ready,
      EXISTS(SELECT 1 FROM content_drafts d WHERE d.project_id = p.id) AS draft_ready,
      (SELECT r.status FROM content_reviews r WHERE r.project_id = p.id) AS review_status
      FROM content_projects p WHERE p.workspace_id = ? ORDER BY p.updated_at DESC`).all(workspaceId) as Array<Record<string, string | null>>)
      .map((row) => this.map(row));
  }

  create(input: { workspaceId: string; targetAccountId?: string; topic: string; sourceRelativePath: string }): ContentProject {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO content_projects
      (id, workspace_id, target_account_id, source_relative_path, topic, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'idea', ?, ?)`)
      .run(id, input.workspaceId, input.targetAccountId ?? null, input.sourceRelativePath, input.topic, now, now);
    return { id, workspaceId: input.workspaceId, targetAccountId: input.targetAccountId ?? null,
      sourceRelativePath: input.sourceRelativePath, topic: input.topic, status: "idea", createdAt: now,
      updatedAt: now, briefReady: false, outlineReady: false, draftReady: false, reviewStatus: null };
  }

  require(projectId: string): ContentProject {
    const row = this.db.prepare(`SELECT p.id, p.workspace_id, p.target_account_id, p.source_relative_path,
      p.topic, p.status, p.created_at, p.updated_at,
      EXISTS(SELECT 1 FROM content_briefs b WHERE b.project_id = p.id) AS brief_ready,
      EXISTS(SELECT 1 FROM content_outlines o WHERE o.project_id = p.id) AS outline_ready,
      EXISTS(SELECT 1 FROM content_drafts d WHERE d.project_id = p.id) AS draft_ready,
      (SELECT r.status FROM content_reviews r WHERE r.project_id = p.id) AS review_status
      FROM content_projects p WHERE p.id = ?`).get(projectId) as Record<string, string | null> | undefined;
    if (!row) throw new Error("找不到内容项目。");
    return this.map(row);
  }

  attachSource(projectId: string, relativePath: string): void {
    this.db.prepare("UPDATE content_projects SET source_relative_path = ?, updated_at = ? WHERE id = ?")
      .run(relativePath, new Date().toISOString(), projectId);
  }

  updateTopic(projectId: string, topic: string): void {
    this.db.prepare("UPDATE content_projects SET topic = ?, updated_at = ? WHERE id = ?")
      .run(topic, new Date().toISOString(), projectId);
  }

  private map(row: Record<string, string | null>): ContentProject {
    return { id: row.id as string, workspaceId: row.workspace_id as string, targetAccountId: row.target_account_id,
      sourceRelativePath: row.source_relative_path,
      topic: row.topic as string, status: "idea", createdAt: row.created_at as string, updatedAt: row.updated_at as string,
      briefReady: Boolean(row.brief_ready), outlineReady: Boolean(row.outline_ready), draftReady: Boolean(row.draft_ready), reviewStatus: row.review_status as ContentProject["reviewStatus"] };
  }
}

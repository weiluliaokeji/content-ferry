import type Database from "better-sqlite3";

export interface ContentBrief {
  projectId: string;
  objective: string;
  audience: string;
  angle: string;
  sourceNotes: string;
  generatedFromAccountProfile: boolean;
}

export class ContentBriefRepository {
  constructor(private readonly db: Database.Database) {}

  get(projectId: string): ContentBrief {
    const row = this.db.prepare(`SELECT p.id, p.topic, b.objective, b.audience, b.angle, b.source_notes,
      ap.positioning, ap.target_audience FROM content_projects p
      LEFT JOIN content_briefs b ON b.project_id = p.id
      LEFT JOIN account_profiles ap ON ap.account_id = p.target_account_id WHERE p.id = ?`).get(projectId) as Record<string, string | null> | undefined;
    if (!row) throw new Error("Content project not found.");
    const hasSavedBrief = row.objective !== null;
    return {
      projectId,
      objective: row.objective ?? (row.positioning ? `围绕“${row.topic}”，为账号定位提供一篇有实际价值的内容。` : "明确这篇文章希望帮助读者解决什么问题。"),
      audience: row.audience ?? row.target_audience ?? "",
      angle: row.angle ?? "",
      sourceNotes: row.source_notes ?? "",
      generatedFromAccountProfile: !hasSavedBrief && Boolean(row.positioning || row.target_audience)
    };
  }

  save(projectId: string, input: Omit<ContentBrief, "projectId" | "generatedFromAccountProfile">): ContentBrief {
    this.get(projectId);
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO content_briefs (project_id, objective, audience, angle, source_notes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET objective = excluded.objective,
      audience = excluded.audience, angle = excluded.angle, source_notes = excluded.source_notes, updated_at = excluded.updated_at`)
      .run(projectId, input.objective, input.audience, input.angle, input.sourceNotes, now);
    return { projectId, ...input, generatedFromAccountProfile: false };
  }
}

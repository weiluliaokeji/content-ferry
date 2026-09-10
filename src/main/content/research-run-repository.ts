import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ContentResearch } from "./content-research-repository";

export type ResearchRunKind = "generate" | "follow_up" | "refresh";

export interface ResearchRun {
  id: string;
  projectId: string;
  taskId: string;
  kind: ResearchRunKind;
  research: ContentResearch;
  createdAt: string;
}

export class ResearchRunRepository {
  constructor(private readonly db: Database.Database) {}

  record(projectId: string, taskId: string, kind: ResearchRunKind, research: ContentResearch): ResearchRun {
    const createdAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO research_runs
      (id, project_id, task_id, kind, plan_markdown, plan_json, sources_json, specified_sources_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO NOTHING`)
      .run(randomUUID(), projectId, taskId, kind, research.planMarkdown, JSON.stringify(research.plan ?? {}), JSON.stringify(research.sources), JSON.stringify(research.specifiedSources), createdAt);
    return this.requireByTask(taskId);
  }

  list(projectId: string): ResearchRun[] {
    return (this.db.prepare(`SELECT id, project_id, task_id, kind, plan_markdown, plan_json, sources_json, specified_sources_json, created_at
      FROM research_runs WHERE project_id = ? ORDER BY created_at DESC`).all(projectId) as ResearchRunRow[]).map(toRun);
  }

  private requireByTask(taskId: string): ResearchRun {
    const row = this.db.prepare(`SELECT id, project_id, task_id, kind, plan_markdown, plan_json, sources_json, specified_sources_json, created_at
      FROM research_runs WHERE task_id = ?`).get(taskId) as ResearchRunRow | undefined;
    if (!row) throw new Error("研究运行快照未保存。");
    return toRun(row);
  }
}

interface ResearchRunRow {
  id: string; project_id: string; task_id: string; kind: ResearchRunKind; plan_markdown: string;
  plan_json: string; sources_json: string; specified_sources_json: string; created_at: string;
}

function toRun(row: ResearchRunRow): ResearchRun {
  return {
    id: row.id, projectId: row.project_id, taskId: row.task_id, kind: row.kind, createdAt: row.created_at,
    research: {
      projectId: row.project_id, planMarkdown: row.plan_markdown,
      plan: parseJson(row.plan_json, null), sources: parseJson(row.sources_json, []), specifiedSources: parseJson(row.specified_sources_json, []), updatedAt: row.created_at
    }
  };
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

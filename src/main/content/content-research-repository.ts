import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface ResearchSource {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  keyClaims: string[];
  sourceType: "official" | "public";
  retrievedAt: string;
  selected: boolean;
}

export interface ContentResearch {
  projectId: string;
  planMarkdown: string;
  sources: ResearchSource[];
  updatedAt: string | null;
}

export class ContentResearchRepository {
  constructor(private readonly db: Database.Database) {}

  get(projectId: string): ContentResearch {
    const plan = this.db.prepare("SELECT plan_markdown, updated_at FROM content_research_plans WHERE project_id = ?")
      .get(projectId) as { plan_markdown: string; updated_at: string } | undefined;
    const sources = this.db.prepare(`SELECT id, title, url, excerpt, claims_json, source_type, retrieved_at, selected
      FROM content_research_sources WHERE project_id = ? ORDER BY retrieved_at DESC, id DESC`).all(projectId) as Array<Record<string, string | number>>;
    return {
      projectId,
      planMarkdown: plan?.plan_markdown ?? "",
      sources: sources.map((source) => ({
        id: source.id as string,
        title: source.title as string,
        url: source.url as string,
        excerpt: source.excerpt as string,
        keyClaims: parseClaims(source.claims_json),
        sourceType: source.source_type === "official" ? "official" : "public",
        retrievedAt: source.retrieved_at as string,
        selected: Boolean(source.selected)
      })),
      updatedAt: plan?.updated_at ?? null
    };
  }

  save(projectId: string, input: { planMarkdown: string; sources: Omit<ResearchSource, "id" | "retrievedAt" | "selected">[] }): ContentResearch {
    const now = new Date().toISOString();
    const save = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO content_research_plans (project_id, plan_markdown, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET plan_markdown = excluded.plan_markdown, updated_at = excluded.updated_at`)
        .run(projectId, input.planMarkdown, now);
      this.db.prepare("DELETE FROM content_research_sources WHERE project_id = ?").run(projectId);
      const insert = this.db.prepare(`INSERT INTO content_research_sources
        (id, project_id, title, url, excerpt, claims_json, source_type, retrieved_at, selected)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);
      for (const source of input.sources) {
        insert.run(randomUUID(), projectId, source.title, source.url, source.excerpt, JSON.stringify(source.keyClaims), source.sourceType, now);
      }
    });
    save();
    return this.get(projectId);
  }

  append(projectId: string, input: { planMarkdown: string; sources: Omit<ResearchSource, "id" | "retrievedAt" | "selected">[] }): ContentResearch {
    const now = new Date().toISOString();
    const append = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT plan_markdown FROM content_research_plans WHERE project_id = ?")
        .get(projectId) as { plan_markdown: string } | undefined;
      const planMarkdown = existing?.plan_markdown.trim()
        ? `${existing.plan_markdown.trim()}\n\n---\n\n${input.planMarkdown.trim()}`
        : input.planMarkdown.trim();
      this.db.prepare(`INSERT INTO content_research_plans (project_id, plan_markdown, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET plan_markdown = excluded.plan_markdown, updated_at = excluded.updated_at`)
        .run(projectId, planMarkdown, now);
      const existingByUrl = this.db.prepare("SELECT id FROM content_research_sources WHERE project_id = ? AND url = ?");
      const insert = this.db.prepare(`INSERT INTO content_research_sources
        (id, project_id, title, url, excerpt, claims_json, source_type, retrieved_at, selected)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);
      for (const source of input.sources) {
        if (existingByUrl.get(projectId, source.url)) continue;
        insert.run(randomUUID(), projectId, source.title, source.url, source.excerpt, JSON.stringify(source.keyClaims), source.sourceType, now);
      }
    });
    append();
    return this.get(projectId);
  }

  updateSelection(projectId: string, sourceId: string, selected: boolean): ContentResearch {
    const exists = this.db.prepare("SELECT 1 FROM content_research_sources WHERE id = ? AND project_id = ?").get(sourceId, projectId);
    if (!exists) throw new Error("找不到这张资料卡。");
    this.db.prepare("UPDATE content_research_sources SET selected = ? WHERE id = ? AND project_id = ?")
      .run(selected ? 1 : 0, sourceId, projectId);
    return this.get(projectId);
  }
}

function parseClaims(value: string | number): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((claim): claim is string => typeof claim === "string") : [];
  } catch {
    return [];
  }
}

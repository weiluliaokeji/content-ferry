import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface ResearchSource {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  keyClaims: string[];
  sourceType: "official" | "public";
  provenance?: ResearchProvenance;
  retrievedAt: string;
  selected: boolean;
}

export interface ResearchProvenance {
  kind: "execution_observation";
  executionRunId: string;
  observationId: string;
  status: "pending" | "accepted" | "rejected";
  targetType: string;
  runtime: string;
  command: string[];
  networkPolicy: string;
  artifacts: Array<{ path: string; sha256: string }>;
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
    const sources = this.db.prepare(`SELECT id, title, url, excerpt, claims_json, provenance_json, source_type, retrieved_at, selected
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
        provenance: parseProvenance(source.provenance_json),
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
        (id, project_id, title, url, excerpt, claims_json, provenance_json, source_type, retrieved_at, selected)
        VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, 1)`);
      const seen = new Set<string>();
      for (const source of input.sources) {
        const url = normalizeResearchUrl(source.url);
        if (seen.has(url)) continue;
        seen.add(url);
        insert.run(randomUUID(), projectId, source.title, url, source.excerpt, JSON.stringify(source.keyClaims), source.sourceType, now);
      }
    });
    save();
    return this.get(projectId);
  }

  append(projectId: string, input: { planMarkdown: string; sources: Omit<ResearchSource, "id" | "retrievedAt" | "selected">[] }): ContentResearch {
    const now = new Date().toISOString();
    const append = this.db.transaction(() => {
      const existingPlan = this.db.prepare("SELECT plan_markdown FROM content_research_plans WHERE project_id = ?")
        .get(projectId) as { plan_markdown: string } | undefined;
      const planMarkdown = existingPlan?.plan_markdown.trim()
        ? `${existingPlan.plan_markdown.trim()}\n\n---\n\n${input.planMarkdown.trim()}`
        : input.planMarkdown.trim();
      this.db.prepare(`INSERT INTO content_research_plans (project_id, plan_markdown, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET plan_markdown = excluded.plan_markdown, updated_at = excluded.updated_at`)
        .run(projectId, planMarkdown, now);
      const existingSources = this.db.prepare("SELECT url FROM content_research_sources WHERE project_id = ?").all(projectId) as Array<{ url: string }>;
      const existingUrls = new Set(existingSources.map((row) => normalizeResearchUrl(row.url)));
      const insert = this.db.prepare(`INSERT INTO content_research_sources
        (id, project_id, title, url, excerpt, claims_json, provenance_json, source_type, retrieved_at, selected)
        VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, 1)`);
      for (const source of input.sources) {
        const url = normalizeResearchUrl(source.url);
        if (existingUrls.has(url)) continue;
        existingUrls.add(url);
        insert.run(randomUUID(), projectId, source.title, url, source.excerpt, JSON.stringify(source.keyClaims), source.sourceType, now);
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

  addManual(projectId: string, input: { title: string; url?: string; excerpt: string; keyClaims: string[] }): ContentResearch {
    const now = new Date().toISOString();
    const url = input.url?.trim() ? normalizeManualResearchUrl(input.url) : `manual://${randomUUID()}`;
    if (!url.startsWith("manual://")) {
      const existing = this.db.prepare("SELECT 1 FROM content_research_sources WHERE project_id = ? AND url = ?")
        .get(projectId, url);
      if (existing) return this.get(projectId);
    }
    this.db.prepare(`INSERT INTO content_research_sources
      (id, project_id, title, url, excerpt, claims_json, provenance_json, source_type, retrieved_at, selected)
      VALUES (?, ?, ?, ?, ?, ?, '{}', 'public', ?, 1)`)
      .run(randomUUID(), projectId, input.title.trim(), url, input.excerpt.trim(), JSON.stringify(input.keyClaims.map((claim) => claim.trim()).filter(Boolean)), now);
    this.db.prepare(`INSERT INTO content_research_plans (project_id, plan_markdown, updated_at) VALUES (?, '', ?)
      ON CONFLICT(project_id) DO UPDATE SET updated_at = excluded.updated_at`).run(projectId, now);
    return this.get(projectId);
  }

  addExecutionObservation(projectId: string, input: {
    observationId: string;
    executionRunId: string;
    title: string;
    claim: string;
    provenance: ResearchProvenance;
    artifacts: Array<{ path: string; sha256: string }>;
  }): ContentResearch {
    const now = new Date().toISOString();
    const url = `execution://${input.executionRunId}`;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO experimental_observations
        (id, project_id, execution_run_id, title, claim, status, provenance_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(execution_run_id) DO UPDATE SET title = excluded.title, claim = excluded.claim,
          provenance_json = excluded.provenance_json, updated_at = excluded.updated_at`)
        .run(input.observationId, projectId, input.executionRunId, input.title.trim(), input.claim.trim(), JSON.stringify(input.provenance), now, now);
      this.db.prepare(`INSERT INTO content_research_sources
        (id, project_id, title, url, excerpt, claims_json, provenance_json, source_type, retrieved_at, selected)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?, 1)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, excerpt = excluded.excerpt,
          claims_json = excluded.claims_json, provenance_json = excluded.provenance_json, retrieved_at = excluded.retrieved_at`)
        .run(input.observationId, projectId, `实验观察 · ${input.title.trim()}`, url,
          `${input.claim.trim()}\n执行记录：${input.executionRunId}；结果仅适用于记录的目标、版本和输入。`,
          JSON.stringify([input.claim.trim(), `复现条件见执行记录 ${input.executionRunId}`]), JSON.stringify(input.provenance), now);
    })();
    return this.get(projectId);
  }
}

export function normalizeResearchUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("manual://")) return trimmed;
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return trimmed;
  }
}

function normalizeManualResearchUrl(value: string): string {
  const normalized = normalizeResearchUrl(value);
  let parsed: URL;
  try { parsed = new URL(normalized); }
  catch { throw new Error("资料来源链接必须是有效的 HTTP(S) 地址。"); }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    throw new Error("资料来源链接只支持不带凭据的 HTTP(S) 地址。");
  }
  return normalized;
}

function parseClaims(value: string | number): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((claim): claim is string => typeof claim === "string") : [];
  } catch {
    return [];
  }
}

function parseProvenance(value: string | number | undefined): ResearchProvenance | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(String(value)) as ResearchProvenance;
    return parsed?.kind === "execution_observation" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

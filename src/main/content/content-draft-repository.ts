import type Database from "better-sqlite3";

export interface ContentDraft {
  projectId: string;
  markdown: string;
  generatedFromOutline: boolean;
}

export class ContentDraftRepository {
  constructor(private readonly db: Database.Database) {}

  get(projectId: string): ContentDraft {
    const row = this.db.prepare(`SELECT p.topic, d.markdown, o.markdown AS outline_markdown
      FROM content_projects p LEFT JOIN content_drafts d ON d.project_id = p.id
      LEFT JOIN content_outlines o ON o.project_id = p.id WHERE p.id = ?`).get(projectId) as Record<string, string | null> | undefined;
    if (!row) throw new Error("Content project not found.");
    if (row.markdown !== null) return { projectId, markdown: row.markdown, generatedFromOutline: false };
    if (!row.outline_markdown) throw new Error("请先保存文章提纲，再起草正文。");
    return { projectId, markdown: buildDraft(row.topic ?? "未命名文章", row.outline_markdown), generatedFromOutline: true };
  }

  save(projectId: string, markdown: string): ContentDraft {
    this.get(projectId);
    this.db.prepare(`INSERT INTO content_drafts (project_id, markdown, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`)
      .run(projectId, markdown, new Date().toISOString());
    return { projectId, markdown, generatedFromOutline: false };
  }
}

function buildDraft(topic: string, outline: string): string {
  const headings = outline.split(/\r?\n/).filter((line) => /^##\s+/.test(line));
  const sections = headings.map((heading) => `${heading}\n\n[在这里结合资料、案例和个人判断展开。]\n`).join("\n");
  return `# ${topic}\n\n> 这是一份基于已确认提纲生成的结构化初稿。请补充事实、案例和你的真实判断后再进入审核。\n\n${sections}`;
}

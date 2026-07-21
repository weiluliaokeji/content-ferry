import type Database from "better-sqlite3";

export interface ContentOutline {
  projectId: string;
  markdown: string;
  generatedFromBrief: boolean;
}

export class ContentOutlineRepository {
  constructor(private readonly db: Database.Database) {}

  get(projectId: string): ContentOutline {
    const row = this.db.prepare(`SELECT p.topic, o.markdown, b.objective, b.audience, b.angle, b.source_notes
      FROM content_projects p LEFT JOIN content_outlines o ON o.project_id = p.id
      LEFT JOIN content_briefs b ON b.project_id = p.id WHERE p.id = ?`).get(projectId) as Record<string, string | null> | undefined;
    if (!row) throw new Error("Content project not found.");
    if (row.markdown !== null) return { projectId, markdown: row.markdown, generatedFromBrief: false };
    if (row.objective === null) throw new Error("请先保存创作简报，再生成提纲。");
    return { projectId, markdown: buildOutline(row), generatedFromBrief: true };
  }

  save(projectId: string, markdown: string): ContentOutline {
    this.get(projectId);
    this.db.prepare(`INSERT INTO content_outlines (project_id, markdown, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`)
      .run(projectId, markdown, new Date().toISOString());
    return { projectId, markdown, generatedFromBrief: false };
  }
}

function buildOutline(row: Record<string, string | null>): string {
  const audience = row.audience || "目标读者";
  const angle = row.angle || "从实际问题出发";
  const sources = row.source_notes ? "\n> 写作时纳入：已有资料与个人笔记。" : "";
  return `# ${row.topic}\n\n## 一、读者正在遇到的具体问题\n- ${audience} 为什么现在需要关注这个问题\n- 常见误区或低效做法\n\n## 二、核心观点：${angle}\n- 文章的中心结论\n- 结论成立的关键依据\n\n## 三、拆解方法与案例\n- 第一步：理解边界与前提\n- 第二步：给出可执行的方法\n- 第三步：用案例或对比验证\n\n## 四、行动建议\n- 读者今天可以先做什么\n- 哪些情况不适合直接照做\n\n## 五、结语\n- 回扣核心观点\n- 给出一个自然的延伸思考${sources}`;
}

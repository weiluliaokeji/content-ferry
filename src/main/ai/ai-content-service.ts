import { z } from "zod";
import type Database from "better-sqlite3";
import type { GenerateStructuredResult, ModelProvider } from "./model-provider";

const markdownOutput = z.object({ markdown: z.string().trim().min(1) });
const markdownOutputSchema = {
  type: "object",
  properties: {
    markdown: { type: "string" }
  },
  required: ["markdown"],
  additionalProperties: false
} as const;

interface CreationContext {
  topic: string;
  objective: string;
  audience: string;
  angle: string;
  sourceNotes: string;
  positioning: string;
  prohibitedTopics: string;
  writingStyle: string;
  regularColumns: string;
  outlineMarkdown: string | null;
}

export class AiContentService {
  constructor(
    private readonly db: Database.Database,
    private readonly provider: ModelProvider
  ) {}

  async generateOutline(projectId: string) {
    const context = this.getContext(projectId);
    if (!context.objective) throw new Error("请先保存创作简报，再让 AI 生成提纲。");

    return this.provider.generateStructured({
      task: "outline",
      prompt: buildOutlinePrompt(context),
      outputSchema: markdownOutputSchema,
      parse: (value) => markdownOutput.parse(value)
    });
  }

  async generateDraft(projectId: string) {
    const context = this.getContext(projectId);
    if (!context.outlineMarkdown) throw new Error("请先确认并保存文章提纲，再让 AI 起草正文。");

    return this.provider.generateStructured({
      task: "draft",
      prompt: buildDraftPrompt(context),
      outputSchema: markdownOutputSchema,
      timeoutMs: 240_000,
      parse: (value) => markdownOutput.parse(value)
    });
  }

  async generateOutlineStream(projectId: string, onDelta: (markdown: string) => void, signal?: AbortSignal): Promise<GenerateStructuredResult<{ markdown: string }>> {
    const context = this.getContext(projectId);
    if (!context.objective) throw new Error("请先保存创作简报，再让 AI 生成提纲。");
    if (!this.provider.generateMarkdownStream) {
      const generated = await this.generateOutline(projectId);
      onDelta(generated.value.markdown);
      return generated;
    }
    return this.provider.generateMarkdownStream({ task: "outline", prompt: buildOutlinePrompt(context), onDelta, signal });
  }

  async generateDraftStream(projectId: string, onDelta: (markdown: string) => void, signal?: AbortSignal): Promise<GenerateStructuredResult<{ markdown: string }>> {
    const context = this.getContext(projectId);
    if (!context.outlineMarkdown) throw new Error("请先确认并保存文章提纲，再让 AI 起草正文。");
    if (!this.provider.generateMarkdownStream) {
      const generated = await this.generateDraft(projectId);
      onDelta(generated.value.markdown);
      return generated;
    }
    return this.provider.generateMarkdownStream({ task: "draft", prompt: buildDraftPrompt(context), timeoutMs: 240_000, onDelta, signal });
  }

  async reviseDraft(projectId: string, aiCheckResult: string, guidance: string) {
    const context = this.getContext(projectId);
    const row = this.db.prepare("SELECT markdown FROM content_drafts WHERE project_id = ?").get(projectId) as { markdown: string } | undefined;
    if (!row?.markdown) throw new Error("请先保存正文，再让 AI 根据检测结果优化。");

    return this.provider.generateStructured({
      task: "revision",
      prompt: buildRevisionPrompt(context, row.markdown, aiCheckResult, guidance),
      outputSchema: markdownOutputSchema,
      timeoutMs: 240_000,
      parse: (value) => markdownOutput.parse(value)
    });
  }

  private getContext(projectId: string): CreationContext {
    const row = this.db.prepare(`
      SELECT p.topic, b.objective, b.audience, b.angle, b.source_notes,
        ap.positioning, ap.prohibited_topics, ap.writing_style, ap.regular_columns,
        o.markdown AS outline_markdown
      FROM content_projects p
      LEFT JOIN content_briefs b ON b.project_id = p.id
      LEFT JOIN account_profiles ap ON ap.account_id = p.target_account_id
      LEFT JOIN content_outlines o ON o.project_id = p.id
      WHERE p.id = ?
    `).get(projectId) as Record<string, string | null> | undefined;

    if (!row) throw new Error("Content project not found.");
    return {
      topic: row.topic ?? "",
      objective: row.objective ?? "",
      audience: row.audience ?? "",
      angle: row.angle ?? "",
      sourceNotes: row.source_notes ?? "",
      positioning: row.positioning ?? "",
      prohibitedTopics: row.prohibited_topics ?? "",
      writingStyle: row.writing_style ?? "",
      regularColumns: row.regular_columns ?? "",
      outlineMarkdown: row.outline_markdown
    };
  }
}

function buildOutlinePrompt(context: CreationContext): string {
  return `你是微信公众号内容策划编辑。请根据以下已确认信息生成一份可直接交给作者审核的中文文章提纲。

要求：
- 只规划文章，不写完整正文。
- 围绕目标读者的真实问题形成清晰论证，不套用固定模板。
- 标出需要事实、数据、案例或来源支持的位置，写成“【待核查：……】”。
- 不得虚构资料、数据、案例或引用。用户未提供的信息不要假装已经查证。
- 遵守账号禁区，体现账号定位和写作风格。
- 输出标准 Markdown，从一级标题开始；不要解释生成过程。

文章主题：${context.topic}
写作目标：${context.objective}
目标读者：${context.audience || "未单独填写，请结合账号定位判断"}
核心角度：${context.angle || "由你根据主题和账号定位提出合适角度"}
账号定位：${context.positioning || "未设置"}
写作风格：${context.writingStyle || "清晰、自然、具体"}
常用栏目：${context.regularColumns || "未设置"}
禁用话题或表达：${context.prohibitedTopics || "未设置"}
用户提供的想法与资料：
${context.sourceNotes || "暂无；因此不得编造事实性材料"}`;
}

function buildDraftPrompt(context: CreationContext): string {
  return `你是微信公众号资深作者。请严格依据已确认提纲和用户资料起草一篇中文文章。

要求：
- 文章首先服务读者，不写成机械的提纲扩写，不使用空泛套话。
- 保留作者可继续加入个人经验和判断的空间。
- 不得虚构事实、数字、案例、采访或引用。
- 缺少证据的事实性内容以“【待核查：……】”标记，不要自行补造。
- 符合账号定位、目标读者、禁用话题和写作风格。
- 输出标准 Markdown 正文，从一级标题开始，不要输出创作说明或代码围栏。

文章主题：${context.topic}
写作目标：${context.objective}
目标读者：${context.audience || "未单独填写，请结合账号定位判断"}
核心角度：${context.angle || "未单独填写"}
账号定位：${context.positioning || "未设置"}
写作风格：${context.writingStyle || "清晰、自然、具体"}
禁用话题或表达：${context.prohibitedTopics || "未设置"}

已确认提纲：
${context.outlineMarkdown}

用户提供的想法与资料：
${context.sourceNotes || "暂无；不得因此虚构事实性材料"}`;
}

function buildRevisionPrompt(context: CreationContext, currentDraft: string, aiCheckResult: string, guidance: string): string {
  return `你是微信公众号资深编辑。请根据腾讯朱雀检测结果和作者的修改方向，优化下面的现有正文。

目标：
- 降低套路化、模板化和机械分点的表达，让文章更像有真实判断与经验的作者所写；
- 保留文章核心观点、结构中有效的部分、已有事实和 Markdown 格式；
- 不为了“降 AI 特征”故意制造错别字、语病、虚假经历或刻意口语化；
- 不新增未经提供或核实的事实、数字、案例、采访和引用；
- 原文中的【待核查：……】必须保留，除非作者明确提供了可替换内容；
- 符合账号定位、目标读者、写作风格和禁用话题；
- 输出优化后的完整 Markdown 正文，不要输出修改说明或代码围栏。

文章主题：${context.topic}
账号定位：${context.positioning || "未设置"}
目标读者：${context.audience || "未单独填写"}
写作风格：${context.writingStyle || "清晰、自然、具体"}
禁用话题或表达：${context.prohibitedTopics || "未设置"}
朱雀检测结果：${aiCheckResult || "未填写具体结果，请按一般的自然表达原则优化"}
作者希望重点修改：${guidance || "减少套路化表达，增强自然衔接与具体判断"}

当前正文：
${currentDraft}`;
}

import { z } from "zod";
import type Database from "better-sqlite3";
import type { GenerateStructuredResult, ModelProvider } from "./model-provider";

const markdownOutput = z.object({ markdown: z.string().trim().min(1) });
const titleSuggestionsOutput = z.object({ titles: z.array(z.string().trim().min(4).max(80)).min(1).max(3) });
const researchOutput = z.object({
  planMarkdown: z.string().trim().min(1).max(12000),
  sources: z.array(z.object({
    title: z.string().trim().min(1).max(300),
    url: z.string().url().max(2000),
    excerpt: z.string().trim().min(1).max(2000),
    keyClaims: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
    sourceType: z.enum(["official", "public"])
  })).min(1).max(10)
});
const researchFollowUpOutput = researchOutput.extend({
  sources: researchOutput.shape.sources.min(0)
});
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
  researchSources: Array<{ title: string; url: string; excerpt: string; keyClaims: string[]; sourceType: "official" | "public" }>;
}

export class AiContentService {
  constructor(
    private readonly db: Database.Database,
    private readonly provider: ModelProvider
  ) {}

  async generateOutline(projectId: string) {
    const context = this.getContext(projectId);

    const generated = await this.provider.generateStructured({
      task: "outline",
      prompt: `${buildOutlinePrompt(context)}\n\n正式标题由用户确认：第一行必须严格输出 \"# ${context.topic}\"，不得改写或另起标题。`,
      outputSchema: markdownOutputSchema,
      parse: (value) => markdownOutput.parse(value)
    });
    return normalizeOutlineTitle(generated, context.topic);
  }

  async generateResearch(projectId: string) {
    const context = this.getContext(projectId);
    return this.provider.generateStructured({
      task: "research",
      skillId: "web-research",
      prompt: buildResearchPrompt(context),
      outputSchema: {
        type: "object",
        properties: {
          planMarkdown: { type: "string" },
          sources: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "object",
              properties: {
                title: { type: "string" }, url: { type: "string" }, excerpt: { type: "string" },
                keyClaims: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
                sourceType: { type: "string", enum: ["official", "public"] }
              },
              required: ["title", "url", "excerpt", "keyClaims", "sourceType"],
              additionalProperties: false
            }
          }
        },
        required: ["planMarkdown", "sources"],
        additionalProperties: false
      },
      timeoutMs: 240_000,
      parse: (value) => researchOutput.parse(value)
    });
  }

  async generateResearchFollowUp(projectId: string, instruction: string) {
    const context = this.getContext(projectId);
    return this.provider.generateStructured({
      task: "research",
      skillId: "web-research",
      prompt: buildResearchFollowUpPrompt(context, instruction),
      outputSchema: {
        type: "object",
        properties: {
          planMarkdown: { type: "string" },
          sources: {
            type: "array",
            maxItems: 10,
            items: {
              type: "object",
              properties: {
                title: { type: "string" }, url: { type: "string" }, excerpt: { type: "string" },
                keyClaims: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
                sourceType: { type: "string", enum: ["official", "public"] }
              },
              required: ["title", "url", "excerpt", "keyClaims", "sourceType"],
              additionalProperties: false
            }
          }
        },
        required: ["planMarkdown", "sources"],
        additionalProperties: false
      },
      timeoutMs: 240_000,
      parse: (value) => researchFollowUpOutput.parse(value)
    });
  }

  async suggestTitles(
    projectId: string,
    historicalSeries: Array<{ name: string; count: number; examples: string[] }> = [],
    briefOverride?: Pick<CreationContext, "objective" | "audience" | "angle" | "sourceNotes">
  ) {
    const context = { ...this.getContext(projectId), ...briefOverride };
    return this.provider.generateStructured({
      task: "outline",
      skillId: "wechat-writing",
      prompt: `请为下面这份已确认的创作简报推荐 3 个中文文章标题。标题应具体、自然、有信息量，符合账号定位和目标读者；不要使用夸张承诺、编号或引号。只返回 JSON。\n\n若历史系列中存在与本次主题明显相关的系列：至少给出 1 个以“系列名——”开头的延续标题；若不相关，不要勉强套用系列。\n\n初始主题：${context.topic}\n写作目标：${context.objective}\n目标读者：${context.audience || "未单独填写"}\n核心角度：${context.angle || "未单独填写"}\n账号定位：${context.positioning || "未设置"}\n写作风格：${context.writingStyle || "自然、具体"}\n已有资料：${context.sourceNotes || "暂无"}\n\n历史文章系列：\n${historicalSeries.length ? historicalSeries.map((series) => `- ${series.name}（${series.count} 篇）：${series.examples.join("；")}`).join("\n") : "未识别到系列；请提供独立标题。"}`,
      outputSchema: { type: "object", properties: { titles: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } } }, required: ["titles"], additionalProperties: false },
      parse: (value) => titleSuggestionsOutput.parse(value)
    });
  }

  async generateDraft(projectId: string) {
    const context = this.getContext(projectId);
    if (!context.outlineMarkdown) throw new Error("请先确认并保存文章提纲，再让 AI 起草正文。");

    const generated = await this.provider.generateStructured({
      task: "draft",
      prompt: `${buildDraftPrompt(context)}\n\n正式标题由用户确认：第一行必须严格输出 \"# ${context.topic}\"，不得改写或另起标题。`,
      outputSchema: markdownOutputSchema,
      timeoutMs: 240_000,
      parse: (value) => markdownOutput.parse(value)
    });
    return normalizeDraftTitle(generated, context.topic);
  }

  async generateOutlineStream(projectId: string, onDelta: (markdown: string) => void, onStatus?: (message: string) => void, signal?: AbortSignal): Promise<GenerateStructuredResult<{ markdown: string }>> {
    const context = this.getContext(projectId);
    if (!this.provider.generateMarkdownStream) {
      const generated = await this.generateOutline(projectId);
      onDelta(generated.value.markdown);
      return generated;
    }
    const generated = await this.provider.generateMarkdownStream({
      task: "outline",
      prompt: `${buildOutlinePrompt(context)}\n\n正式标题由用户确认：第一行必须严格输出 \"# ${context.topic}\"，不得改写或另起标题。`,
      onDelta: (markdown) => onDelta(replaceLeadingDraftTitle(markdown, context.topic)),
      onStatus,
      signal
    });
    return normalizeOutlineTitle(generated, context.topic);
  }

  async generateDraftStream(projectId: string, onDelta: (markdown: string) => void, onStatus?: (message: string) => void, signal?: AbortSignal): Promise<GenerateStructuredResult<{ markdown: string }>> {
    const context = this.getContext(projectId);
    if (!context.outlineMarkdown) throw new Error("请先确认并保存文章提纲，再让 AI 起草正文。");
    if (!this.provider.generateMarkdownStream) {
      const generated = await this.generateDraft(projectId);
      onDelta(generated.value.markdown);
      return generated;
    }
    const generated = await this.provider.generateMarkdownStream({
      task: "draft",
      prompt: `${buildDraftPrompt(context)}\n\n正式标题由用户确认：第一行必须严格输出 \"# ${context.topic}\"，不得改写或另起标题。`,
      timeoutMs: 240_000,
      onDelta: (markdown) => onDelta(replaceLeadingDraftTitle(markdown, context.topic)),
      onStatus,
      signal
    });
    return normalizeDraftTitle(generated, context.topic);
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
    const sources = this.db.prepare(`SELECT title, url, excerpt, claims_json, source_type
      FROM content_research_sources WHERE project_id = ? AND selected = 1 ORDER BY retrieved_at DESC`).all(projectId) as Array<Record<string, string>>;
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
      outlineMarkdown: row.outline_markdown,
      researchSources: sources.map((source) => ({
        title: source.title,
        url: source.url,
        excerpt: source.excerpt,
        keyClaims: parseResearchClaims(source.claims_json),
        sourceType: source.source_type === "official" ? "official" : "public"
      }))
    };
  }
}

function buildOutlinePrompt(context: CreationContext): string {
  return `你是微信公众号内容策划编辑。请根据以下已确认信息生成一份可直接交给作者审核的中文文章提纲。

要求：
- 这是给读者看的文章结构，不是研究计划、写作任务书、待办清单或作者工作说明；只规划文章，不写完整正文。
- 围绕目标读者的真实问题形成清晰论证，不套用固定模板。
- 使用 4 至 7 个二级标题；每节用 2 至 4 条简短要点写清本节要回答的问题、核心判断和将展开的内容。结尾应落到读者可带走的判断或行动。
- 不得出现“【待核查】”“作者”“写作重点”“建议作者”“此处应”“研究计划”“TODO”等面向创作过程的措辞，也不要输出研究问题、检索关键词或来源核查清单。
- 不得虚构资料、数据、案例或引用。用户未提供且尚未核实的信息，不要写成确定事实；应改为不依赖该事实的结构性表达，或省略该细节。
- 遵守账号禁区，体现账号定位和写作风格。
- 输出标准 Markdown，从一级标题开始；不要解释生成过程。

文章主题：${context.topic}
写作目标：${context.objective || "未单独填写，请围绕文章主题明确读者收获"}
目标读者：${context.audience || "未单独填写，请结合账号定位判断"}
核心角度：${context.angle || "由你根据主题和账号定位提出合适角度"}
账号定位：${context.positioning || "未设置"}
写作风格：${context.writingStyle || "清晰、自然、具体"}
常用栏目：${context.regularColumns || "未设置"}
禁用话题或表达：${context.prohibitedTopics || "未设置"}
用户提供的想法与资料：
${context.sourceNotes || "暂无；因此不得编造事实性材料"}

已确认研究资料卡：
${formatResearchSources(context.researchSources)}`;
}

function buildResearchPrompt(context: CreationContext): string {
  return `你是阿文，负责为一篇即将发布的中文自媒体文章进行联网补研。现在已默认允许联网检索；请主动使用网页搜索，优先官方原始资料，再用高质量公开资料补充。

目标：找出能够支持文章判断的最新事实、限制、使用方式和反例，并形成可追溯资料卡。不要写正文、提纲或写作任务书。

要求：
- 先检索再作答；每一张资料卡的 URL 必须是你实际查到的直接页面，不能编造、不能给搜索页、不能使用无法核对的链接。
- 优先 2 至 6 个官方来源；仅在官方资料不足时补充公开来源。资料卡最多 10 张。
- excerpt 是不超过 200 字的中文事实摘要，不要整页复制。keyClaims 是该来源能支持的 1 至 5 条具体主张，标明适用条件与时间敏感性。
- planMarkdown 仅包含“本次补研结论”“仍需人工确认的边界”“建议如何在文章中使用资料”三小节，简洁、可审核；不要混入文章章节或给作者的逐步指令。
- 不确定、互相矛盾或需要登录才能确认的内容必须明确说明，不能根据模型记忆补全。

文章主题：${context.topic}
写作目标：${context.objective || "未单独填写，请围绕文章主题补研"}
目标读者：${context.audience || "未单独填写"}
核心角度：${context.angle || "未单独填写"}
账号定位：${context.positioning || "未设置"}
用户已有资料：${context.sourceNotes || "暂无"}`;
}

function buildResearchFollowUpPrompt(context: CreationContext, instruction: string): string {
  return `你是阿文，正在为一篇中文自媒体文章做第二轮增量联网补研。请先阅读已有资料，再只针对用户新提出的缺口进行网页检索。优先官方原始资料；网页检索已获默认授权。

用户的补研要求：
${instruction}

文章主题：${context.topic}
写作目标：${context.objective || "未单独填写"}
目标读者：${context.audience || "未单独填写"}
核心角度：${context.angle || "未单独填写"}

已有、已选资料卡：
${formatResearchSources(context.researchSources)}

输出要求：
- 只补充本轮要求涉及的事实、限制、反例或使用路径；不要重新写文章、提纲或写作任务书。
- 每张新资料卡必须是实际检索到的直接页面 URL，不能编造、不能给搜索结果页；不要重复已有 URL。
- 找不到可靠新增资料时，sources 可以为空，并在 planMarkdown 中明确说明未能确认的原因与建议的人工核查路径。
- planMarkdown 仅包含“本轮补研结论”“仍需人工确认的边界”“建议如何在文章中使用资料”三个简短小节。
- excerpt 是不超过 200 字的中文事实摘要；keyClaims 是该来源支持的 1 至 5 条具体主张，必须说明适用条件或时效性。
- 不确定、互相矛盾或需要登录才能确认的内容必须明确标记，不能凭模型记忆补全。`;
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
写作目标：${context.objective || "未单独填写，请围绕文章主题完成写作"}
目标读者：${context.audience || "未单独填写，请结合账号定位判断"}
核心角度：${context.angle || "未单独填写"}
账号定位：${context.positioning || "未设置"}
写作风格：${context.writingStyle || "清晰、自然、具体"}
禁用话题或表达：${context.prohibitedTopics || "未设置"}

已确认提纲：
${context.outlineMarkdown}

用户提供的想法与资料：
${context.sourceNotes || "暂无；不得因此虚构事实性材料"}

已确认研究资料卡：
${formatResearchSources(context.researchSources)}`;
}

function formatResearchSources(sources: CreationContext["researchSources"]): string {
  if (sources.length === 0) return "暂无已确认资料卡；不得虚构外部事实。";
  return sources.map((source, index) => `${index + 1}. [${source.sourceType === "official" ? "官方" : "公开"}] ${source.title}\nURL: ${source.url}\n摘要: ${source.excerpt}\n主张: ${source.keyClaims.join("；")}`).join("\n\n");
}

function parseResearchClaims(value: string): string[] {
  try {
    const claims = JSON.parse(value);
    return Array.isArray(claims) ? claims.filter((claim): claim is string => typeof claim === "string") : [];
  } catch {
    return [];
  }
}

function normalizeDraftTitle(
  generated: GenerateStructuredResult<{ markdown: string }>,
  confirmedTitle: string
): GenerateStructuredResult<{ markdown: string }> {
  return { ...generated, value: { markdown: replaceLeadingDraftTitle(generated.value.markdown, confirmedTitle, true) } };
}

function normalizeOutlineTitle(
  generated: GenerateStructuredResult<{ markdown: string }>,
  confirmedTitle: string
): GenerateStructuredResult<{ markdown: string }> {
  return { ...generated, value: { markdown: replaceLeadingDraftTitle(generated.value.markdown, confirmedTitle, true) } };
}

function replaceLeadingDraftTitle(markdown: string, confirmedTitle: string, insertIfMissing = false): string {
  const leadingTitle = /^\s*#\s+[^\r\n]+/;
  if (leadingTitle.test(markdown)) return markdown.replace(leadingTitle, `# ${confirmedTitle}`);
  return insertIfMissing && markdown.trim() ? `# ${confirmedTitle}\n\n${markdown.trimStart()}` : markdown;
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

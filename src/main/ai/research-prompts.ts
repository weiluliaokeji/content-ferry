/**
 * Prompt builders + shared types for 联网资料补研 (web research).
 *
 * Kept separate from ai-content-service so both the content service and the
 * model-provider orchestrator can build research prompts without a circular
 * import. Retrieval is performed by the app (WebSearchClient); these prompts
 * tell the model how to *plan* searches and how to *synthesize* the gathered
 * sources into traceable research cards.
 */
import { z } from "zod";

export const researchOutput = z.object({
  planMarkdown: z.string().trim().min(1).max(12000),
  sources: z.array(z.object({
    title: z.string().trim().min(1).max(300),
    url: z.string().url().max(2000),
    excerpt: z.string().trim().min(1).max(2000),
    keyClaims: z.array(z.string().trim().min(1).max(500)).min(1).max(5),
    sourceType: z.enum(["official", "public"])
  })).min(0).max(10)
});
export type ResearchOutput = z.infer<typeof researchOutput>;

export const researchFollowUpOutput = researchOutput.extend({
  sources: researchOutput.shape.sources.min(0)
});

export const RESEARCH_SCHEMA = {
  type: "object",
  properties: {
    planMarkdown: { type: "string" },
    sources: {
      type: "array",
      minItems: 0,
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
} as const;

export interface WebResearchSourceRef {
  title: string;
  url: string;
  excerpt: string;
  keyClaims: string[];
  sourceType: "official" | "public";
}

export interface WebResearchContext {
  topic: string;
  objective: string;
  audience: string;
  angle: string;
  positioning: string;
  sourceNotes: string;
  /** Already-selected sources, supplied on incremental (follow-up) research. */
  existingSources?: WebResearchSourceRef[];
}

export interface ResearchCard {
  planMarkdown: string;
  sources: WebResearchSourceRef[];
}

const MAX_PROMPT_SEARCH_SOURCES = 10;
const MAX_PROMPT_SOURCE_SNIPPET_CHARS = 900;

/**
 * A search result may contain a very long excerpt. Keep the stored research
 * result intact, but bound the material copied into a single model request.
 * This prevents multi-round research from growing the prompt without limit.
 */
function limitSearchSourcesForPrompt(sources: SearchSourceForPrompt[]): SearchSourceForPrompt[] {
  return sources.slice(0, MAX_PROMPT_SEARCH_SOURCES).map((source) => ({
    ...source,
    snippet: source.snippet.length > MAX_PROMPT_SOURCE_SNIPPET_CHARS
      ? `${source.snippet.slice(0, MAX_PROMPT_SOURCE_SNIPPET_CHARS)}…`
      : source.snippet
  }));
}

/** Appends `label：value` only when the field is actually filled. */
export function pushField(lines: string[], label: string, value: string | undefined | null): void {
  if (value && value.trim()) lines.push(`${label}：${value.trim()}`);
}

export function formatResearchSources(sources: WebResearchSourceRef[]): string {
  if (sources.length === 0) return "（暂无已确认资料卡）";
  return sources
    .map((source, index) => `${index + 1}. [${source.sourceType === "official" ? "官方" : "公开"}] ${source.title}\nURL: ${source.url}\n摘要: ${source.excerpt}\n主张: ${source.keyClaims.join("；")}`)
    .join("\n\n");
}

function contextBlock(context: WebResearchContext): string {
  const lines: string[] = [];
  pushField(lines, "文章主题", context.topic);
  pushField(lines, "写作目标", context.objective);
  pushField(lines, "目标读者", context.audience);
  pushField(lines, "核心角度", context.angle);
  pushField(lines, "账号定位", context.positioning);
  pushField(lines, "用户已有资料", context.sourceNotes);
  return lines.join("\n");
}

/**
 * Scheme B planner prompt: given the topic and what we have retrieved so far,
 * decide the next search direction (or stop). The model returns JSON
 * {action:'search'|'done', query}. A done plan uses an empty query; this keeps
 * the schema compatible with strict OpenAI structured outputs.
 * on models that do not support tool calling.
 */
export function buildPlannerPrompt(context: WebResearchContext, rawSourcesSoFar: SearchSourceForPrompt[], round: number, maxRounds: number): string {
  const sourcesSoFar = limitSearchSourcesForPrompt(rawSourcesSoFar);
  return `你是阿文的研究规划器，负责为一篇中文自媒体文章做联网补研的检索规划。联网检索由系统执行，你只决定“下一步该搜什么”。

要求：
- 围绕文章主题与写作目标，找出还缺的事实、限制、反例或使用路径。
- 优先规划官方原始资料的检索；官方资料不足时再规划高质量公开资料。
- 不要重复已有资料已覆盖的方向；每次给出具体、可检索的查询词（中文或英文关键词皆可）。
- 若已有资料已足够支撑补研结论，返回 action:"done"，且 query 必须是空字符串。
- 严格只返回 JSON，不要解释：{"action":"search","query":"下一步检索词"} 或 {"action":"done","query":""}。

文章信息：
${contextBlock(context)}

已检索到第 ${round} 轮，共计划最多 ${maxRounds} 轮。已得资料（${sourcesSoFar.length} 条）：
${sourcesSoFar.length === 0 ? "（暂无）" : sourcesSoFar.map((s, i) => `${i + 1}. ${s.title}\nURL: ${s.url}\n摘要: ${s.snippet}`).join("\n\n")}`;
}

/**
 * Final synthesis prompt: turn the gathered sources into traceable research
 * cards. The model must NOT search on its own — all retrieval is already done.
 */
export function buildResearchSynthesisPrompt(context: WebResearchContext, rawSources: SearchSourceForPrompt[], instructions: string): string {
  const sources = limitSearchSourcesForPrompt(rawSources);
  const contextLines: string[] = [];
  pushField(contextLines, "文章主题", context.topic);
  pushField(contextLines, "写作目标", context.objective);
  pushField(contextLines, "目标读者", context.audience);
  pushField(contextLines, "核心角度", context.angle);
  pushField(contextLines, "账号定位", context.positioning);
  pushField(contextLines, "用户已有资料", context.sourceNotes);
  const contextBlockText = contextLines.join("\n");
  return `你是阿文，负责为一篇即将发布的中文自媒体文章整理可追溯资料卡。下面的资料已由系统实际检索得到，请基于这些资料整理，不要自行联网、不要编造未提供的链接。

目标：找出能够支持文章判断的最新事实、限制、使用方式和反例，并形成可追溯资料卡。不要写正文、提纲或写作任务书。

要求：
- 每一张资料卡的 URL 必须是下方给出的直接页面，不能编造、不能给搜索页、不能使用无法核对的链接。
  - 优先 2 至 4 个官方来源；仅在官方资料不足时补充公开来源。资料卡最多 4 张。
- 为每个来源判断 sourceType：official 为官方原始资料（政府/机构/品牌官网等），public 为公开资料。
  - excerpt 是不超过 120 字的中文事实摘要，不要整页复制。keyClaims 是该来源能支持的 1 至 2 条具体主张，标明适用条件与时间敏感性。
  - planMarkdown 仅包含“本次补研结论”“仍需人工确认的边界”“建议如何在文章中使用资料”三小节，总长度不超过 800 字，简洁、可审核；不要混入文章章节或给作者的逐步指令。
- 不确定、互相矛盾或需要登录才能确认的内容必须明确说明，不能根据模型记忆补全。
- 请遵循以下 ContentFerry 技能说明：\n\n${instructions}

${contextBlockText}

已检索到的资料（${sources.length} 条）：
${sources.map((s, i) => `${i + 1}. ${s.title}\nURL: ${s.url}\n摘要: ${s.snippet}`).join("\n\n")}`;
}

export interface SearchSourceForPrompt {
  title: string;
  url: string;
  snippet: string;
  sourceType: "official" | "public";
}

/**
 * Prompt for the Codex built-in search path: ask Codex to use its own web
 * search to research the topic and return the same structured ResearchCard as
 * the app-owned synthesis path. Traceability is weaker here (URLs are written
 * by the model rather than fetched by the app), so we stress "only URLs you
 * actually visited" and "don't invent". This is an explicit, on-by-default
 * trade-off for Codex connections; users who need app-fetched traceable URLs
 * can turn the connection's built-in search toggle off.
 */
export function buildCodexBuiltInResearchPrompt(
  context: WebResearchContext,
  instructions: string,
  options?: { instruction?: string }
): string {
  const contextLines: string[] = [];
  pushField(contextLines, "文章主题", context.topic);
  pushField(contextLines, "写作目标", context.objective);
  pushField(contextLines, "目标读者", context.audience);
  pushField(contextLines, "核心角度", context.angle);
  pushField(contextLines, "账号定位", context.positioning);
  pushField(contextLines, "用户已有资料", context.sourceNotes);
  const contextBlockText = contextLines.join("\n");
  const followUp = options?.instruction
    ? `\n\n本轮是增量补研。用户的补研要求：\n${options.instruction}\n只针对该缺口补充事实、限制、反例或使用路径；不要重复已有资料。`
    : "";
  return `你是阿文，负责为一篇即将发布的中文自媒体文章做联网补研并整理可追溯资料卡。请直接使用你内置的联网检索能力主动搜索官方与公开资料，再综合成结构化资料卡。不要编造未访问过的链接。

目标：找出能支持文章判断的最新事实、限制、使用方式和反例，并形成可追溯资料卡。不要写正文、提纲或写作任务书。

要求：
- 每张资料卡的 URL 必须是你实际访问过的直接页面，不能编造、不能给搜索结果聚合页；无法核对或需要登录才能确认的链接不要写。
- 优先 2 至 4 个官方来源；仅在官方资料不足时补充公开来源。资料卡最多 4 张。
- 为每个来源判断 sourceType：official 为官方原始资料（政府/机构/品牌官网等），public 为公开资料。
- excerpt 是不超过 120 字的中文事实摘要，不要整页复制。keyClaims 是该来源能支持的 1 至 2 条具体主张，标明适用条件与时间敏感性。
- planMarkdown 仅包含“本次补研结论”“仍需人工确认的边界”“建议如何在文章中使用资料”三小节，总长度不超过 800 字，简洁、可审核；不要混入文章章节或给作者的逐步指令。
- 不确定、互相矛盾或需要登录才能确认的内容必须明确说明，不能根据模型记忆补全。
- 请遵循以下 ContentFerry 技能说明：\n\n${instructions}

${contextBlockText}${followUp}

直接返回符合 JSON Schema 的结果：{"planMarkdown":"...","sources":[{"title":"...","url":"...","excerpt":"...","keyClaims":["..."],"sourceType":"official"|"public"}]}`;
}

/** Incremental (follow-up) synthesis prompt: only fill the stated gap. */
export function buildResearchFollowUpSynthesisPrompt(
  context: WebResearchContext,
  rawNewSources: SearchSourceForPrompt[],
  instruction: string,
  instructions: string
): string {
  const newSources = limitSearchSourcesForPrompt(rawNewSources);
  const contextLines: string[] = [];
  pushField(contextLines, "文章主题", context.topic);
  pushField(contextLines, "写作目标", context.objective);
  pushField(contextLines, "目标读者", context.audience);
  pushField(contextLines, "核心角度", context.angle);
  const contextBlockText = contextLines.join("\n");
  return `你是阿文，正在为一篇中文自媒体文章做第二轮增量联网补研。请先阅读已有资料，再只针对用户新提出的缺口进行整理。优先官方原始资料；联网检索已由系统执行。

用户的补研要求：
${instruction}

${contextBlockText}

已有、已选资料卡：
${formatResearchSources(context.existingSources ?? [])}

本轮系统新检索到的资料（${newSources.length} 条）：
${newSources.map((s, i) => `${i + 1}. ${s.title}\nURL: ${s.url}\n摘要: ${s.snippet}`).join("\n\n")}

输出要求：
- 只补充本轮要求涉及的事实、限制、反例或使用路径；不要重新写文章、提纲或写作任务书。
- 每张新资料卡必须是实际检索到的直接页面 URL，不能编造、不能给搜索结果页；不要重复已有 URL。
- 为每个来源判断 sourceType：official 为官方原始资料（政府/机构/品牌官网等），public 为公开资料。
- 找不到可靠新增资料时，sources 可以为空，并在 planMarkdown 中明确说明未能确认的原因与建议的人工核查路径。
- planMarkdown 仅包含“本轮补研结论”“仍需人工确认的边界”“建议如何在文章中使用资料”三个简短小节。
- excerpt 是不超过 200 字的中文事实摘要；keyClaims 是该来源支持的 1 至 5 条具体主张，必须说明适用条件或时效性。
- 不确定、互相矛盾或需要登录才能确认的内容必须明确标记，不能凭模型记忆补全。
- 请遵循以下 ContentFerry 技能说明：\n\n${instructions}`;
}

import { z } from "zod";
import type { ContentSourceService } from "../content/content-source-service";
import type { RemoteImageImportService } from "../content/remote-image-import-service";
import type { ImageCandidateReviewService } from "./image-candidate-review-service";
import type { ModelProvider } from "./model-provider";
import type { WebSearchClient, ImageSearchResultItem } from "./web-search";

const planSchema = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["none", "search"] },
    query: { type: "string", maxLength: 180 },
    count: { type: "integer", minimum: 1, maximum: 2 },
    reason: { type: "string", maxLength: 160 }
  },
  required: ["action", "query", "count", "reason"],
  additionalProperties: false
} as const;

const selectionSchema = {
  type: "object",
  properties: {
    images: {
      type: "array", maxItems: 2,
      items: {
        type: "object", additionalProperties: false,
        properties: { candidateIndex: { type: "integer", minimum: 0 }, anchor: { type: "string", minLength: 8, maxLength: 2000 }, alt: { type: "string", maxLength: 160 } },
        required: ["candidateIndex", "anchor", "alt"]
      }
    }
  },
  required: ["images"], additionalProperties: false
} as const;

const planOutput = z.object({ action: z.enum(["none", "search"]), query: z.string().trim().max(180), count: z.number().int().min(1).max(2), reason: z.string().trim().max(160) }).strict();
const selectionOutput = z.object({ images: z.array(z.object({ candidateIndex: z.number().int().nonnegative(), anchor: z.string().trim().min(8).max(2000), alt: z.string().trim().max(160) }).strict()).max(2) }).strict();

export interface DraftImageCurationContext {
  topic: string;
  writingStyle: string;
  visualTraits: string;
  practiceEvidence: string;
}

export interface DraftImageCurationResult {
  markdown: string;
  inserted: number;
  outcome: "added" | "not_added" | "unavailable";
  reason: string;
}

/** Adds a small number of relevant, attributed web images to a draft when the model says they help. */
export class DraftImageCurationService {
  constructor(
    private readonly provider: ModelProvider,
    private readonly webSearch: WebSearchClient,
    private readonly imageReview: ImageCandidateReviewService,
    private readonly remoteImages: RemoteImageImportService,
    private readonly contentSources: ContentSourceService
  ) {}

  async curate(input: {
    workspaceId: string;
    relativePath: string;
    context: DraftImageCurationContext;
    markdown: string;
    onStatus?: (message: string) => void;
  }): Promise<DraftImageCurationResult> {
    if (!this.webSearch.searchImages) return { markdown: input.markdown, inserted: 0, outcome: "unavailable", reason: "联网图片检索服务未配置。" };
    const existingImages = [...input.markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)].map((match) => match[1]);
    input.onStatus?.("正在判断正文是否需要联网配图…");
    let plan: z.infer<typeof planOutput>;
    try {
      plan = (await this.provider.generateStructured({
        task: "selection",
        prompt: `你是文章配图编辑。判断这篇已经起草的文章是否需要额外的联网配图。结合主题、账号已确认的配图偏好和手动写作风格。配图偏好只是选择依据，不是每篇文章必须满足的要求；没有实践截图不代表文章有缺陷，也不自动意味着通用配图无用。先判断图片能否具体帮助读者理解正文；相关性弱或无法可靠定位时选择 none。已有图片（包括本次实践截图）足够时选择 none。最多搜索两张。不得把图片当作事实证据，不要为了配图而搜索无关图片。\n\n主题：${input.context.topic}\n手动风格：${input.context.writingStyle || "未填写"}\n已确认配图偏好：${input.context.visualTraits || "未提供"}\n本轮实践记录摘要：${input.context.practiceEvidence || "无"}\n现有图片：${existingImages.length ? existingImages.join("\n") : "无"}\n\n文章：\n${input.markdown.slice(0, 24_000)}\n\n只有图片能明确帮助读者理解时返回 action=search，并提供具体、简洁的图片检索词；否则 action=none。reason 用不超过 160 字说明配图处理决定，不评价文章质量，不把未取得实践结果说成文章缺陷，不输出思考过程。`,
        outputSchema: planSchema,
        timeoutMs: 60_000,
        parse: (value) => planOutput.parse(value)
      })).value;
    } catch (error) {
      return { markdown: input.markdown, inserted: 0, outcome: "unavailable", reason: `配图判断未完成：${errorMessage(error)}` };
    }
    if (plan.action !== "search" || !plan.query) return { markdown: input.markdown, inserted: 0, outcome: "not_added", reason: plan.reason || "本篇无需额外联网配图。" };

    input.onStatus?.("正在搜索与正文相关的配图…");
    let candidates: ImageSearchResultItem[];
    try {
      candidates = await this.webSearch.searchImages(plan.query, Math.min(plan.count * 4, 8));
    } catch (error) {
      return { markdown: input.markdown, inserted: 0, outcome: "unavailable", reason: `联网配图搜索未完成：${errorMessage(error)}` };
    }
    input.onStatus?.("正在筛选图片并确定正文位置…");
    const reviewed = await this.imageReview.review(plan.query, candidates);
    const accepted = reviewed.items.filter((item) => (item.review.status === "accepted" || item.review.status === "unreviewed") && item.sourceUrl && isHttpUrl(item.sourceUrl));
    if (accepted.length === 0) return { markdown: input.markdown, inserted: 0, outcome: "not_added", reason: "没有找到相关性和来源都合适的图片。" };

    let selected: z.infer<typeof selectionOutput>;
    try {
      selected = (await this.provider.generateStructured({
        task: "selection",
        prompt: `从候选图片中选择最多 ${plan.count} 张，并为每张图片指定文章中一个完全逐字匹配且唯一出现的普通段落作为插入位置。候选只提供内容线索，不是事实来源。应避免重复文章已有图片。找不到可靠位置就不选。若候选标记为“未做视觉初审”，只能依据标题和说明作保守判断，不得声称看过图片；alt 用简洁中文描述可见内容，不要加入未核实结论。\n文章：\n${input.markdown.slice(0, 24_000)}\n候选图片：\n${accepted.map((item, index) => `${index}. 初审=${item.review.status}（${item.review.reason}）；标题=${item.sourceTitle ?? "未知"}；说明=${item.caption || "无"}；来源=${item.sourceUrl}`).join("\n")}`,
        outputSchema: selectionSchema,
        timeoutMs: 60_000,
        parse: (value) => selectionOutput.parse(value)
      })).value;
    } catch (error) {
      return { markdown: input.markdown, inserted: 0, outcome: "unavailable", reason: `图片位置判断未完成：${errorMessage(error)}` };
    }

    let markdown = input.markdown;
    let inserted = 0;
    for (const choice of selected.images) {
      const candidate = accepted[choice.candidateIndex];
      if (!candidate || !candidate.sourceUrl || !isHttpUrl(candidate.sourceUrl)) continue;
      const occurrences = markdown.split(choice.anchor).length - 1;
      if (occurrences !== 1 || !isStandaloneTextParagraph(markdown, choice.anchor)) continue;
      try {
        const imported = await this.remoteImages.importForArticle(input.workspaceId, input.relativePath, candidate.imageUrl);
        const title = safeMarkdownText(candidate.sourceTitle || "图片来源");
        const sourceUrl = safeMarkdownUrl(candidate.sourceUrl);
        const alt = safeMarkdownText(choice.alt || candidate.caption || "文章配图");
        const block = `\n\n![${alt}](${imported.assetUrl})\n\n[图片来源：${title}](${sourceUrl})`;
        markdown = markdown.replace(choice.anchor, `${choice.anchor}${block}`);
        inserted += 1;
      } catch { /* A failed candidate is skipped; the rest of the draft remains usable. */ }
    }
    const visualReviewDisabled = accepted.some((item) => item.review.status === "unreviewed");
    return {
      markdown,
      inserted,
      outcome: inserted > 0 ? "added" : "not_added",
      reason: inserted > 0
        ? `来源链接已保留；${visualReviewDisabled ? "图片内容" : "图片使用条件"}仍需发布前核对。`
        : "候选图片没有可确认的唯一插入位置。"
    };
  }
}

function isStandaloneTextParagraph(markdown: string, paragraph: string): boolean {
  const escaped = paragraph.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\n\\s*\\n)${escaped}(?=\\n\\s*\\n|$)`, "u").test(markdown);
}

function isHttpUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:"; } catch { return false; }
}

function safeMarkdownText(value: string): string {
  return value.replace(/[\[\]<>\\\r\n]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 160) || "文章配图";
}

function safeMarkdownUrl(value: string): string {
  const url = new URL(value);
  return url.toString().replaceAll("(", "%28").replaceAll(")", "%29");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "服务暂不可用。";
}

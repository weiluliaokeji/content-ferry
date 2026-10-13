import type { DraftDepthPreference } from "../../shared/draft-workflow";

export interface DraftDepthSectionPlan {
  heading: string;
  purpose: string;
  outlinePoints: string[];
}

export interface DraftDepthPlan {
  level: Exclude<DraftDepthPreference, null> | "adaptive";
  reason: string;
  sections: DraftDepthSectionPlan[];
  noPaddingRule: string;
}

export interface DraftCommitment {
  sectionHeading: string;
  commitment: string;
}

export interface DraftSection {
  heading: string;
  outlineMarkdown: string;
}

/** Splits only at level-two headings: level-three headings belong to their parent section. */
export function splitDraftSections(outline: string): DraftSection[] {
  const sections: DraftSection[] = [];
  let current: DraftSection | undefined;
  let fence: { character: string; length: number } | undefined;
  for (const line of outline.split(/\r?\n/u)) {
    fence = nextFence(line, fence);
    const heading = fence ? null : line.match(/^##\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      current = { heading: heading[1].trim(), outlineMarkdown: line };
      sections.push(current);
    } else if (current) {
      current.outlineMarkdown += `\n${line}`;
    }
  }
  return sections.map((section) => ({ ...section, outlineMarkdown: section.outlineMarkdown.trimEnd() }));
}

/**
 * Gives the next section writer a compact map of what the earlier sections
 * already covered, plus the immediate transition context. This avoids sending
 * the entire growing draft on every call while preventing the writer from
 * seeing only an arbitrary tail of the previous section.
 */
export function summarizeDraftForContinuity(markdown: string, maxChars = 6_000): string {
  const sections = splitDraftSections(markdown);
  if (sections.length === 0) return markdown.trim().slice(-maxChars);

  const budget = Math.max(120, Math.floor((maxChars - 900) / sections.length));
  const summaries = sections.map(({ heading, outlineMarkdown }) => {
    const body = outlineMarkdown.slice(outlineMarkdown.indexOf("\n") + 1).trim();
    const sentences = body.match(/[^。！？!?\n]+[。！？!?]?/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
    const opening = sentences[0] ?? "";
    const ending = sentences.at(-1) ?? "";
    const summary = opening && ending && opening !== ending ? `${opening} …… ${ending}` : opening || ending;
    const contentBudget = Math.max(0, budget - heading.length - 8);
    return `## ${heading}\n${summary.slice(0, contentBudget)}`;
  }).join("\n\n");

  const last = sections.at(-1)!;
  const lastBody = last.outlineMarkdown.slice(last.outlineMarkdown.indexOf("\n") + 1).trim();
  const transition = lastBody.slice(-Math.min(900, Math.floor(maxChars / 5)));
  const result = `${summaries}\n\n最近一节的结尾（用于衔接，不作为外部事实依据）：\n${transition}`;
  return result.length <= maxChars ? result : result.slice(-maxChars);
}

/** Rejects a section response that silently drops its heading or writes a sibling section. */
export function extractDraftSection(markdown: string, heading: string, first: boolean): string {
  const normalized = markdown.trim().replace(/\r\n/gu, "\n");
  const headings: Array<{ title: string; start: number }> = [];
  let fence: { character: string; length: number } | undefined;
  let offset = 0;
  for (const line of normalized.split("\n")) {
    fence = nextFence(line, fence);
    const match = fence ? null : line.match(/^##\s+(.+?)\s*#*\s*$/u);
    if (match) headings.push({ title: match[1].trim(), start: offset });
    offset += line.length + 1;
  }
  if (headings.length !== 1 || headings[0].title !== heading) {
    throw new Error(`章节“${heading}”未按确认提纲单独生成；已保留此前章节。`);
  }
  const sectionStart = headings[0].start;
  if (first) {
    if (!/^#\s+[^\n]+/u.test(normalized)) throw new Error(`首节“${heading}”缺少正式标题。`);
    return normalized;
  }
  return normalized.slice(sectionStart).trim();
}

function nextFence(line: string, open: { character: string; length: number } | undefined): { character: string; length: number } | undefined {
  const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
  if (!marker) return open;
  if (!open) return { character: marker[0], length: marker.length };
  return marker[0] === open.character && marker.length >= open.length ? undefined : open;
}

/** Carries the author's depth choice and the confirmed outline's promises into drafting. */
export function planDraftDepth(input: {
  outline: string;
  preference?: DraftDepthPreference;
}): DraftDepthPlan {
  const sections = parseSections(input.outline);
  return {
    level: input.preference ?? "adaptive",
    reason: input.preference
      ? "按作者在创作简报中选择的详略程度。"
      : "作者未指定篇幅；由写作目标、目标读者和提纲承诺决定详略。指南与实践文章按需展开前提、操作、结果判断和边界；观点文章围绕论证与依据展开。",
    sections: sections.map(({ heading, outlinePoints }) => ({
      heading,
      purpose: outlinePoints.length
        ? `完成已确认提纲在“${heading}”下列出的内容；根据读者任务展开必要的依据、步骤、示例和限制。`
        : `回答“${heading}”对读者提出的问题；根据该节实际内容决定解释深度。`,
      outlinePoints
    })),
    noPaddingRule: "详略选择用于安排解释深度；逐节检查读者承诺是否兑现，不以字数或章节数凑篇幅。"
  };
}

/** Turns the author's preference into task-specific drafting guidance without imposing a word quota. */
export function describeDraftDepth(level: DraftDepthPlan["level"]): string {
  switch (level) {
    case "concise":
      return "优先简洁表达，但必须兑现每项读者承诺；可以合并紧密相关的说明，不得省略完成核心任务所必需的前提、关键步骤、判断方法或事实边界。";
    case "standard":
      return "在易读和充分说明之间平衡；根据每项读者承诺补足必要的解释、依据、步骤、例子与限制，不扩写无关背景。";
    case "detailed":
      return "优先把读者需要的过程讲清楚。按主题需要补充前提和选择依据、可执行步骤、预期结果与判断方法、常见变体或故障及适用限制；概念或观点文章则充分展开机制、论据和边界，不硬塞教程内容。不得重复凑长。";
    case "adaptive":
      return "作者未指定篇幅。逐节根据读者承诺决定详略，不按标题关键词推断体裁或分配固定字数。若一项承诺包含多个判断、操作步骤或适用条件，应分别讲清；操作类内容要具体到读者能按步骤行动并判断结果，概念和观点内容要讲清机制、论据及适用边界，不套用操作模板。每节写到读者真正获得该节承诺的理解或行动；不能因一句话提到要点就判定完成，也不得把正文缩成提纲摘要或重复凑长。简单说明保持精炼，复杂任务充分展开。";
  }
}

/** Expands each outline point into an explicit, auditable reader commitment. */
export function listDraftCommitments(plan: DraftDepthPlan): DraftCommitment[] {
  return plan.sections.flatMap((section) => {
    const promises = section.outlinePoints.length ? section.outlinePoints : [section.purpose];
    return promises.map((commitment) => ({ sectionHeading: section.heading, commitment }));
  });
}

function parseSections(outline: string): Array<{ heading: string; outlinePoints: string[] }> {
  // Keep the plan's section boundaries identical to drafting and review. In
  // particular, a Markdown example inside a fenced block is content, not an
  // executable H2 heading or a reader promise.
  const sections = splitDraftSections(outline).map(({ heading, outlineMarkdown }) => {
    const outlineLines = outlineMarkdown.split(/\r?\n/u).slice(1);
    const outlinePoints: string[] = [];
    let fence: { character: string; length: number } | undefined;
    for (const line of outlineLines) {
      const wasInsideFence = Boolean(fence);
      const isFenceMarker = /^ {0,3}(?:`{3,}|~{3,})/u.test(line);
      fence = nextFence(line, fence);
      if (wasInsideFence || fence || isFenceMarker) continue;
      const trimmed = line.trim();
      if (!trimmed || /^#/u.test(trimmed)) continue;
      const point = trimmed.replace(/^(?:[-+*]|\d+[.)])\s+/u, "").trim();
      if (point) outlinePoints.push(point);
    }
    return { heading, outlinePoints };
  });
  return sections.length ? sections : [{ heading: "正文主体", outlinePoints: [] }];
}

import { splitDraftSections } from "./draft-depth-planner";

export interface DraftTextEdit {
  original: string;
  replacement: string;
}

/** Applies model-proposed local edits only when every anchor is unique and unchanged. */
export function applyDraftTextEdits(markdown: string, edits: readonly DraftTextEdit[]): string {
  if (edits.length === 0) return markdown;
  if (edits.length > 12) throw new Error("局部修订超过单轮上限，已保留原候选。");
  const ranges = edits.map((edit) => {
    if (!edit.original || !edit.replacement || edit.original === markdown) {
      throw new Error("局部修订必须提供小于整篇正文的非空原文和替换内容。");
    }
    const start = markdown.indexOf(edit.original);
    if (start < 0 || markdown.indexOf(edit.original, start + 1) >= 0) {
      throw new Error("局部修订的原文无法在当前候选中唯一定位；已保留原候选。");
    }
    const oldHeadings = splitDraftSections(edit.original).map((section) => section.heading);
    const newHeadings = splitDraftSections(edit.replacement).map((section) => section.heading);
    if (oldHeadings.length > 1) {
      throw new Error("局部修订跨越多个二级章节；已保留原候选。");
    }
    if (JSON.stringify(oldHeadings) !== JSON.stringify(newHeadings)) {
      throw new Error("局部修订改变了二级章节结构；已保留原候选。");
    }
    const oldTitle = edit.original.match(/^#\s+[^\r\n]+/mu)?.[0];
    const newTitle = edit.replacement.match(/^#\s+[^\r\n]+/mu)?.[0];
    if (oldTitle !== newTitle) throw new Error("局部修订改变了文章标题；已保留原候选。");
    return { start, end: start + edit.original.length, replacement: edit.replacement };
  }).sort((a, b) => b.start - a.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].end > ranges[index - 1].start) {
      throw new Error("局部修订的原文范围重叠；已保留原候选。");
    }
  }
  return ranges.reduce((current, range) =>
    `${current.slice(0, range.start)}${range.replacement}${current.slice(range.end)}`, markdown);
}

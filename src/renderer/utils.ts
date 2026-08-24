import type { AccountProfile, ManagedSkill, ModelProviderId, SelectedImage, ZhuqueReport } from "./types";

// 纯工具函数（自 main.tsx 拆分）
export const emptyProfile: AccountProfile = { positioning: "", targetAudience: "", prohibitedTopics: "", writingStyle: "", regularColumns: "", articleSignature: "" };

export const providerName = (provider: ModelProviderId | null) => provider === null ? "无需模型" : ({
  openai_codex: "OpenAI Codex",
  modelscope: "ModelScope",
  agnes: "Agnes AI"
} as Record<ModelProviderId, string>)[provider];

/** Returns the model status label shown on a skill card. Detection skills genuinely
 *  need no model; every other category requires one, so null means "not selected". */

export const skillModelStatus = (skill: ManagedSkill) => {
  if (skill.category === "检测") return providerName(null);
  if (skill.provider === null) return "未选择模型";
  return providerName(skill.provider);
};

export function markdownTitle(markdown: string): string | undefined {
  return markdown.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim() || undefined;
}

export type DiffSegment = { value: string; changed: boolean };

export function compareText(before: string, after: string): { before: DiffSegment[]; after: DiffSegment[] } {
  const beforeTokens = tokenizeForDiff(before);
  const afterTokens = tokenizeForDiff(after);
  if (beforeTokens.length > 1_200 || afterTokens.length > 1_200) return compareTextByCommonEdges(before, after);
  const rows = Array.from({ length: beforeTokens.length + 1 }, () => new Uint16Array(afterTokens.length + 1));
  for (let left = beforeTokens.length - 1; left >= 0; left -= 1) {
    for (let right = afterTokens.length - 1; right >= 0; right -= 1) {
      rows[left][right] = beforeTokens[left] === afterTokens[right]
        ? rows[left + 1][right + 1] + 1
        : Math.max(rows[left + 1][right], rows[left][right + 1]);
    }
  }
  const leftSegments: DiffSegment[] = [];
  const rightSegments: DiffSegment[] = [];
  let left = 0;
  let right = 0;
  while (left < beforeTokens.length || right < afterTokens.length) {
    if (left < beforeTokens.length && right < afterTokens.length && beforeTokens[left] === afterTokens[right]) {
      appendDiffSegment(leftSegments, beforeTokens[left], false);
      appendDiffSegment(rightSegments, afterTokens[right], false);
      left += 1;
      right += 1;
    } else if (right < afterTokens.length && (left >= beforeTokens.length || rows[left][right + 1] >= rows[left + 1][right])) {
      appendDiffSegment(rightSegments, afterTokens[right], true);
      right += 1;
    } else {
      appendDiffSegment(leftSegments, beforeTokens[left], true);
      left += 1;
    }
  }
  return { before: leftSegments, after: rightSegments };
}

export function tokenizeForDiff(value: string): string[] {
  return value.match(/\s+|[\p{Script=Han}]|[\p{L}\p{N}_]+|[^\s]/gu) ?? [];
}

export function appendDiffSegment(segments: DiffSegment[], value: string, changed: boolean): void {
  const previous = segments.at(-1);
  if (previous?.changed === changed) previous.value += value;
  else segments.push({ value, changed });
}

export function compareTextByCommonEdges(before: string, after: string): { before: DiffSegment[]; after: DiffSegment[] } {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const beforeSegments = [{ value: before.slice(0, prefix), changed: false }, { value: before.slice(prefix, before.length - suffix), changed: true }, { value: before.slice(before.length - suffix), changed: false }].filter((item) => item.value);
  const afterSegments = [{ value: after.slice(0, prefix), changed: false }, { value: after.slice(prefix, after.length - suffix), changed: true }, { value: after.slice(after.length - suffix), changed: false }].filter((item) => item.value);
  return { before: beforeSegments, after: afterSegments };
}

export type SelectableDiffHunk = { before: string; after: string; changed: boolean };

export function buildSelectableDiff(before: string, after: string): SelectableDiffHunk[] {
  const beforeTokens = tokenizeForDiff(before);
  const afterTokens = tokenizeForDiff(after);
  if (beforeTokens.length > 1200 || afterTokens.length > 1200) {
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
    return [{ before: before.slice(0, prefix), after: after.slice(0, prefix), changed: false }, { before: before.slice(prefix, before.length - suffix), after: after.slice(prefix, after.length - suffix), changed: true }, { before: before.slice(before.length - suffix), after: after.slice(after.length - suffix), changed: false }].filter((item) => item.before || item.after);
  }
  const rows = Array.from({ length: beforeTokens.length + 1 }, () => new Uint16Array(afterTokens.length + 1));
  for (let left = beforeTokens.length - 1; left >= 0; left -= 1) for (let right = afterTokens.length - 1; right >= 0; right -= 1) rows[left][right] = beforeTokens[left] === afterTokens[right] ? rows[left + 1][right + 1] + 1 : Math.max(rows[left + 1][right], rows[left][right + 1]);
  const result: SelectableDiffHunk[] = [];
  const append = (left: string, right: string, changed: boolean) => { const previous = result.at(-1); if (changed && previous?.changed) { previous.before += left; previous.after += right; } else result.push({ before: left, after: right, changed }); };
  let left = 0; let right = 0;
  while (left < beforeTokens.length || right < afterTokens.length) {
    if (left < beforeTokens.length && right < afterTokens.length && beforeTokens[left] === afterTokens[right]) { append(beforeTokens[left], afterTokens[right], false); left += 1; right += 1; }
    else if (right < afterTokens.length && (left >= beforeTokens.length || rows[left][right + 1] >= rows[left + 1][right])) { append("", afterTokens[right], true); right += 1; }
    else { append(beforeTokens[left], "", true); left += 1; }
  }
  return result;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export async function readImageUrl(url: string, fileName: string): Promise<SelectedImage> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("无法读取所选图片。");
  const blob = await response.blob();
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(new Error("无法读取所选图片。"));
    reader.readAsDataURL(blob);
  });
  return { fileName, mimeType: blob.type || "image/png", base64 };
}

export function scrollTextareaToMarkdownOffset(textarea: HTMLTextAreaElement | null, markdown: string, offset: number): void {
  if (!textarea) return;
  const safeOffset = Math.max(0, Math.min(markdown.length, offset));
  const { mirror, lines } = createTextareaLineMirror(textarea, markdown);
  const lineIndex = markdown.slice(0, safeOffset).split(/\r?\n/).length - 1;
  const paddingTop = Number.parseFloat(getComputedStyle(textarea).paddingTop) || 0;
  textarea.scrollTop = Math.max(0, (lines[Math.min(lineIndex, lines.length - 1)]?.offsetTop ?? 0) - paddingTop);
  mirror.remove();
}

export function markdownOffsetAtTextareaTop(textarea: HTMLTextAreaElement, markdown: string): number {
  const { mirror, lines, offsets } = createTextareaLineMirror(textarea, markdown);
  const paddingTop = Number.parseFloat(getComputedStyle(textarea).paddingTop) || 0;
  const visibleTop = textarea.scrollTop + paddingTop + 1;
  let index = lines.findIndex((line) => line.offsetTop + line.offsetHeight > visibleTop);
  if (index < 0) index = Math.max(0, lines.length - 1);
  const offset = offsets[index] ?? 0;
  mirror.remove();
  return offset;
}

export function createTextareaLineMirror(textarea: HTMLTextAreaElement, markdown: string): {
  mirror: HTMLDivElement;
  lines: HTMLDivElement[];
  offsets: number[];
} {
  const mirror = createTextareaMirror(textarea);
  const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 24;
  const lines: HTMLDivElement[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const sourceLine of markdown.split(/\r?\n/)) {
    const line = document.createElement("div");
    line.style.minHeight = `${lineHeight}px`;
    line.style.margin = "0";
    line.style.padding = "0";
    line.style.whiteSpace = "pre-wrap";
    line.style.overflowWrap = "break-word";
    line.textContent = sourceLine || "\u200b";
    offsets.push(offset);
    lines.push(line);
    mirror.appendChild(line);
    offset += sourceLine.length + 1;
  }
  return { mirror, lines, offsets };
}

export function createTextareaMirror(textarea: HTMLTextAreaElement): HTMLDivElement {
  const computed = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  Object.assign(mirror.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    visibility: "hidden",
    boxSizing: computed.boxSizing,
    width: `${textarea.getBoundingClientRect().width}px`,
    padding: computed.padding,
    border: computed.border,
    font: computed.font,
    lineHeight: computed.lineHeight,
    letterSpacing: computed.letterSpacing,
    tabSize: computed.tabSize,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    wordBreak: computed.wordBreak
  });
  document.body.appendChild(mirror);
  return mirror;
}

export function scrollEditorToHeading(title: string, occurrence: number, markdown: string, mode: "visual" | "markdown"): void {
  if (mode === "markdown") {
    const textarea = document.querySelector<HTMLTextAreaElement>(".markdown-source-editor");
    const match = new RegExp(`^#{1,6}\\s+${escapeRegExp(title)}\\s*$`, "m").exec(markdown);
    if (textarea && match) {
      textarea.focus();
      textarea.setSelectionRange(match.index, match.index + match[0].length);
      const line = markdown.slice(0, match.index).split(/\r?\n/).length - 1;
      textarea.scrollTop = Math.max(0, line * 24 - textarea.clientHeight / 3);
    }
    return;
  }
  const headings = [...document.querySelectorAll<HTMLElement>(".visual-markdown-editor h1, .visual-markdown-editor h2, .visual-markdown-editor h3, .visual-markdown-editor h4, .visual-markdown-editor h5, .visual-markdown-editor h6")]
    .filter((heading) => heading.textContent?.trim() === title.trim());
  const target = headings[Math.min(occurrence, headings.length - 1)] ?? headings[0];
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
  target?.focus({ preventScroll: true });
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseZhuqueReport(value: string): ZhuqueReport | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as ZhuqueReport;
    return parsed && Array.isArray(parsed.segments) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function isHighAiDetectionResult(result: string, report?: ZhuqueReport): boolean {
  if (report?.aiPercent != null) return report.aiPercent >= 50;
  if (!result.trim()) return false;
  if (/AI.{0,12}(?:偏高|较高|高风险|疑似)|疑似.{0,8}AI/i.test(result)) return true;
  return [...result.matchAll(/(?:AI[^\n%]{0,30}(\d{1,3}(?:\.\d+)?)\s*%|(\d{1,3}(?:\.\d+)?)\s*%[^\n]{0,30}AI)/gi)]
    .some((match) => Number(match[1] ?? match[2]) >= 50);
}

export function sourceAssetContextId(relativePath: string): string {
  let hash = 2166136261;
  for (const character of relativePath) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `source-${(hash >>> 0).toString(16)}`;
}

export function runtimeLogLevel(level: number): string {
  if (level >= 60) return "严重";
  if (level >= 50) return "错误";
  if (level >= 40) return "警告";
  if (level >= 30) return "信息";
  return "调试";
}


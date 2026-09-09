/**
 * Obsidian 风格高亮（`==文本==`）在文渡各处的统一识别与转换。
 *
 * 为什么需要单独一个模块：
 * - 文渡把 Markdown 当作 canonical 内容源，但每个发布渠道的渲染器都不同：
 *   51CTO/微信/CSDN 收 HTML，掘金/博客园收 Markdown 原文。
 * - 微信公众号的清洗器会剥掉 `<mark>` 等语义标签，只保留内联 `style`，
 *   因此高亮必须降级为带 `background-color` 的 `<span>`。
 * - 掘金不支持 `==` 语法（对照 typora/CSDN/掘金 的兼容表），但支持 `<mark>`，
 *   所以 Markdown 原生平台要转成 `<mark>` 而不是保留 `==`。
 *
 * 本模块只做「文本 → 文本」，不依赖 DOM 或 Node API，主进程与渲染层共用。
 */

/** 高亮内容的取值：不含 `=` 与换行，避免误吃 `===`（setext 标题下划线）。 */
const HIGHLIGHT_BODY = "[^=\\n]+";

/** 单行内的高亮匹配（全局）。 */
const HIGHLIGHT_GLOBAL = new RegExp(`==(${HIGHLIGHT_BODY})==`, "g");

/** 整段 token 的高亮匹配，用于判断一个片段是否正好是一段高亮。 */
const HIGHLIGHT_TOKEN = new RegExp(`^==(${HIGHLIGHT_BODY})==$`);

/**
 * `==` 两侧不允许紧跟空白，否则 `a == b == c` 这类比较运算文本会被误判。
 * 内容与 Obsidian 行为保持一致：只有真正贴着内容的高亮标记才生效。
 */
function isHighlightBody(body: string): boolean {
  if (!body.trim()) return false;
  return body === body.trim();
}

/**
 * 判断一个片段是否完整等于一段高亮标记，返回其中的正文；否则返回 `null`。
 * 供渲染层按 token 切分时使用。
 */
export function matchHighlightToken(value: string): string | null {
  const matched = HIGHLIGHT_TOKEN.exec(value);
  if (!matched) return null;
  const body = matched[1];
  return isHighlightBody(body) ? body : null;
}

export type HighlightStyle = "mark" | "wechat";

const OPEN_TAG: Record<HighlightStyle, string> = {
  mark: "<mark>",
  // 微信清洗器会剥掉语义标签，只保留内联样式；黄底与 Obsidian 默认一致。
  wechat: '<span style="background-color:#ffe58f;padding:0 2px;">'
};

const CLOSE_TAG: Record<HighlightStyle, string> = {
  mark: "</mark>",
  wechat: "</span>"
};

/** 占位符边界，使用 NUL 以避开正常文本。 */
const PLACEHOLDER_PREFIX = "\u0000CODE";
const PLACEHOLDER_SUFFIX = "\u0000";

/**
 * 转换一段**非代码块**行内文本中的高亮。
 *
 * 行内代码（`` `...` ``）先被占位符摘出去，避免 `==` 出现在代码里时被改写；
 * 调用方若已经自行跳过围栏代码块，直接传整行即可。
 */
export function convertHighlightInline(value: string, style: HighlightStyle = "mark"): string {
  if (!value.includes("==")) return value;
  const codes: string[] = [];
  const protectedText = value.replace(/`[^`]*`/g, (whole) => {
    const token = `${PLACEHOLDER_PREFIX}${codes.length}${PLACEHOLDER_SUFFIX}`;
    codes.push(whole);
    return token;
  });
  const converted = protectedText.replace(HIGHLIGHT_GLOBAL, (whole, body: string) =>
    isHighlightBody(body) ? `${OPEN_TAG[style]}${body}${CLOSE_TAG[style]}` : whole
  );
  if (codes.length === 0) return converted;
  return converted.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, "g"),
    (whole, index: string) => codes[Number(index)] ?? whole
  );
}

/**
 * 转换整篇 Markdown 中的高亮，自动跳过围栏代码块（``` … ```）。
 * 用于把 Markdown 原文直接提交给平台的渠道（掘金、博客园）。
 */
export function convertHighlightMarkdown(markdown: string, style: HighlightStyle = "mark"): string {
  if (!markdown.includes("==")) return markdown;
  const lines = markdown.split("\n");
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        const opening = !inFence;
        inFence = opening;
        return line;
      }
      if (inFence) return line;
      return convertHighlightInline(line, style);
    })
    .join("\n");
}

import type { ContentSourceService } from "../content/content-source-service";

export interface JuejinImageInliningResult {
  markdown: string;
  inlinedCount: number;
  failed: Array<{ source: string; reason: string }>;
}

/**
 * 内联预算上限（字符）。掘金正文 mark_content 有服务端长度限制（本地校验为
 * 100000），base64 会把图片放大到原体积的 4/3 倍，若全部内联很容易超限。
 * 默认预算留出余量：内联后 markdown 总长不会逼近 100000。
 */
export const DEFAULT_MAX_INLINE_TOTAL_CHARS = 90_000;

interface ImageMatch {
  start: number;
  end: number;
  alt: string;
  source: string;
}

const imagePattern = /!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

/**
 * Inline local article images as base64 data URIs before submitting a Juejin
 * draft. Juejin's image upload endpoint requires msToken + a_bogus anti-crawl
 * signatures that a plain fetch cannot obtain, so the channel relies on
 * external-link references instead. Remote http(s) images stay untouched
 * (Juejin renders external URLs), and local relative paths (e.g.
 * `./assets/foo.png`) — which Juejin can never resolve — are converted to
 * inline data URIs so they render inside the draft.
 */
export async function inlineJuejinLocalImages(
  markdown: string,
  workspaceId: string,
  sourceRelativePath: string,
  contentSources: ContentSourceService,
  maxTotalInlineChars = DEFAULT_MAX_INLINE_TOTAL_CHARS
): Promise<JuejinImageInliningResult> {
  const matches = collectJuejinImageMatches(markdown);
  // Replace from end to start so earlier indices stay valid after each splice.
  let result = markdown;
  let inlinedCount = 0;
  let inlinedTotalChars = 0;
  const failed: Array<{ source: string; reason: string }> = [];

  for (let index = matches.length - 1; index >= 0; index--) {
    const { start, end, alt, source } = matches[index];
    if (source.startsWith("data:")) continue;
    // Remote images stay as-is: Juejin accepts external URLs.
    if (/^https?:\/\//i.test(source)) continue;

    try {
      const resource = contentSources.readArticleResource(workspaceId, sourceRelativePath, source);
      const chunks: Buffer[] = [];
      for await (const chunk of resource.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        failed.push({ source, reason: "图片内容为空。" });
        continue;
      }
      const dataUrl = `data:${resource.mimeType};base64,${buffer.toString("base64")}`;
      // 内联预算保护：base64 会把图片放大 4/3 倍，全部内联可能撑爆掘金正文
      // 长度限制。超出预算的图片保留原路径并记录失败原因，由用户侧处理。
      if (inlinedTotalChars + dataUrl.length > maxTotalInlineChars) {
        failed.push({ source, reason: `图片过大（base64 ${dataUrl.length} 字符），内联后将超过掘金正文长度预算（${maxTotalInlineChars} 字符），已保留原路径。` });
        continue;
      }
      result = result.slice(0, start) + `![${alt}](${dataUrl})` + result.slice(end);
      inlinedCount++;
      inlinedTotalChars += dataUrl.length;
    } catch (error) {
      failed.push({ source, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { markdown: result, inlinedCount, failed };
}

export function collectJuejinImageMatches(markdown: string): ImageMatch[] {
  const matches: ImageMatch[] = [];
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  let fenceCloser = "";
  let offset = 0;

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (!inFence && fenceMatch) {
      inFence = true;
      fenceCloser = fenceMatch[1][0].repeat(fenceMatch[1].length);
    } else if (inFence && line.startsWith(fenceCloser)) {
      inFence = false;
      fenceCloser = "";
    }

    if (!inFence) {
      let match: RegExpExecArray | null;
      imagePattern.lastIndex = 0;
      while ((match = imagePattern.exec(line)) !== null) {
        matches.push({
          start: offset + match.index,
          end: offset + match.index + match[0].length,
          alt: match[1],
          source: match[2]
        });
      }
    }

    offset += line.length + 1; // +1 for the newline separator
  }

  return matches;
}

import type { ContentSourceService } from "../content/content-source-service";
import type { JuejinImageUploader } from "./juejin-image-uploader";

export interface JuejinImageInliningResult {
  markdown: string;
  inlinedCount: number;
  uploadedCount: number;
  failed: Array<{ source: string; reason: string }>;
}

/**
 * 内联预算上限（字符）。掘金正文 mark_content 有服务端长度限制（本地校验为
 * 100000），base64 会把图片放大到原体积的 4/3 倍，若全部内联很容易超限。
 * 默认预算留出余量：内联后 markdown 总长不会逼近 100000。
 * 仅在上传失败回退内联时生效。
 */
export const DEFAULT_MAX_INLINE_TOTAL_CHARS = 90_000;

/** 单张图片超过该字节数（10 MiB）时跳过上传，直接回退 data URI 内联。 */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface ImageMatch {
  start: number;
  end: number;
  alt: string;
  source: string;
}

const imagePattern = /!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

export interface InlineJuejinLocalImagesOptions {
  /** 回退内联时的总字符预算（默认 DEFAULT_MAX_INLINE_TOTAL_CHARS）。 */
  maxTotalInlineChars?: number;
  /** 图片上传器。提供时本地图片优先走掘金 ImageX 上传，失败回退内联；缺省时全部内联。 */
  uploader?: JuejinImageUploader;
  /** 单张图片上传大小上限（默认 10 MiB），超过则跳过上传直接内联。 */
  maxUploadBytes?: number;
}

/**
 * 将文章中的本地图片转换为掘金可访问的 URL。
 *
 * 掘金图片上传接口现已支持（ImageX 5 步流程），因此本地相对路径图片（如
 * `./assets/foo.png`）优先通过上传器上传到掘金图床，替换为 CDN URL；上传失败
 * （含超时、超大小上限、无上传器）时回退为 base64 data URI 内联，保证正文可渲染。
 * 远程 http(s) 图片保持原样（掘金外链渲染），data URI 与代码块内语法不动。
 */
export async function inlineJuejinLocalImages(
  markdown: string,
  workspaceId: string,
  sourceRelativePath: string,
  contentSources: ContentSourceService,
  options: InlineJuejinLocalImagesOptions | number = {}
): Promise<JuejinImageInliningResult> {
  const opts: InlineJuejinLocalImagesOptions =
    typeof options === "number" ? { maxTotalInlineChars: options } : options;
  const maxTotalInlineChars = opts.maxTotalInlineChars ?? DEFAULT_MAX_INLINE_TOTAL_CHARS;
  const uploader = opts.uploader;
  const maxUploadBytes = opts.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;

  const matches = collectJuejinImageMatches(markdown);
  // Replace from end to start so earlier indices stay valid after each splice.
  let result = markdown;
  let uploadedCount = 0;
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

      // 优先上传到掘金图床；仅当没有上传器、图片超过大小上限或上传失败时回退内联。
      if (uploader && buffer.length <= maxUploadBytes) {
        try {
          const { url } = await uploader.uploadImage(buffer);
          result = result.slice(0, start) + `![${alt}](${url})` + result.slice(end);
          uploadedCount++;
          continue;
        } catch (error) {
          failed.push({
            source,
            reason: `图片上传失败，已回退内联：${error instanceof Error ? error.message : String(error)}`
          });
        }
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

  return { markdown: result, inlinedCount, uploadedCount, failed };
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

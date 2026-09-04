import type { ContentSourceService } from "../content/content-source-service";
import type { JuejinImageUploader } from "./juejin-image-uploader";

export interface JuejinImageInliningResult {
  markdown: string;
  /** 成功上传到掘金 ImageX 图床并替换为远程 CDN URL 的张数。 */
  uploadedCount: number;
  failed: Array<{ source: string; reason: string }>;
}

interface ImageMatch {
  start: number;
  end: number;
  alt: string;
  source: string;
}

const imagePattern = /!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

/**
 * 把文章中的本地图片上传到掘金 ImageX 图床并替换为远程 CDN URL。
 *
 * 行为约定（2026-09-04）：
 * - uploader 是必传参数——掘金发布前必须成功上传所有本地图，否则文章不可用。
 * - 上传失败（含 cookie 过期/接口改版/网络/图片过大等任何原因）只把原因 push 进
 *   `failed`，markdown 原文保留——由 `juejin-channel-service` 拿到非空 `failed`
 *   时整体 transitionJob('failed')，不再走发布。
 * - 远程 http(s) 图片保持原样（掘金支持外链渲染）。
 * - data URI 与代码块内的图片语法不动。
 * - 已删除 2026-09-04 之前的"上传失败回退 base64 data URI"行为——用户反馈：
 *   "回退后的文章根本不可用，回退么有意义"。
 */
export async function inlineJuejinLocalImages(
  markdown: string,
  workspaceId: string,
  sourceRelativePath: string,
  contentSources: ContentSourceService,
  uploader: JuejinImageUploader
): Promise<JuejinImageInliningResult> {
  const matches = collectJuejinImageMatches(markdown);
  // Replace from end to start so earlier indices stay valid after each splice.
  let result = markdown;
  let uploadedCount = 0;
  const failed: Array<{ source: string; reason: string }> = [];

  for (let index = matches.length - 1; index >= 0; index--) {
    const { start, end, alt, source } = matches[index];
    if (source.startsWith("data:")) continue;
    // Remote images stay as-is: Juejin accepts external URLs.
    if (/^https?:\/\//i.test(source)) continue;

    let buffer: Buffer;
    try {
      const resource = contentSources.readArticleResource(workspaceId, sourceRelativePath, source);
      const chunks: Buffer[] = [];
      for await (const chunk of resource.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        failed.push({ source, reason: "图片内容为空。" });
        continue;
      }
    } catch (error) {
      failed.push({ source, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }

    try {
      const { url } = await uploader.uploadImage(buffer);
      result = result.slice(0, start) + `![${alt}](${url})` + result.slice(end);
      uploadedCount++;
    } catch (error) {
      // 上传失败：保留原 source，仅记录原因，由 channel-service 整体判定失败。
      const reason = error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null
          ? JSON.stringify(error, Object.getOwnPropertyNames(error))
          : String(error);
      console.error(`[juejin] 本地图片上传掘金 ImageX 失败：source=${source} reason=${reason}`);
      failed.push({ source, reason });
    }
  }

  return { markdown: result, uploadedCount, failed };
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
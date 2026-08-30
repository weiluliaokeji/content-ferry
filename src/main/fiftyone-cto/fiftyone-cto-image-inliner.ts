import type { ContentSourceService } from "../content/content-source-service";
import { FiftyoneCtoImageUploader } from "./fiftyone-cto-image-uploader";

export interface FiftyoneCtoImageInliningResult {
  markdown: string;
  inlinedCount: number;
  failed: Array<{ source: string; reason: string }>;
}

export interface FiftyoneCtoImageUploadingResult {
  markdown: string;
  /** 成功上传到 51CTO 图床并替换为远程 URL 的张数。 */
  uploadedCount: number;
  /** 图床上传失败、回退为 base64 内联的张数。 */
  inlinedCount: number;
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
 * 将文章中的本地图片转换为 base64 data URI 内联。
 *
 * 51CTO 的 MVP 图片策略：本地相对路径图片（如 `./assets/foo.png`）读取后直接以
 * data URI 内联进正文，保证本地文章图片无需外部图床即可在 51CTO 渲染；远程 http(s)
 * 图片保持原样由 51CTO 外链渲染；data URI 与代码块内的图片语法不动。
 *
 * 注：真正的 51CTO 阿里云 OSS 图床上传（getUploadConfig → getUploadSign → OSS PUT）
 * 需要实时 Cookie 才能验证签名协议，留作后续增强。
 */
export async function inlineFiftyoneCtoLocalImages(
  markdown: string,
  workspaceId: string,
  sourceRelativePath: string,
  contentSources: ContentSourceService
): Promise<FiftyoneCtoImageInliningResult> {
  const matches = collectFiftyoneCtoImageMatches(markdown);
  let result = markdown;
  let inlinedCount = 0;
  const failed: Array<{ source: string; reason: string }> = [];

  for (let index = matches.length - 1; index >= 0; index--) {
    const { start, end, alt, source } = matches[index];
    if (source.startsWith("data:")) continue;
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
      result = result.slice(0, start) + `![${alt}](${dataUrl})` + result.slice(end);
      inlinedCount++;
    } catch (error) {
      failed.push({ source, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { markdown: result, inlinedCount, failed };
}

/**
 * 把文章中的本地图片上传到 51CTO 图床（OSS），替换为远程 URL；
 * 单张上传失败时回退为 base64 内联，保证发布不中断。
 *
 * 远程 http(s) 图片、data URI 不动。仅在 51CTO 账号已配置 Cookie 时调用。
 */
export async function uploadFiftyoneCtoLocalImages(
  markdown: string,
  workspaceId: string,
  sourceRelativePath: string,
  contentSources: ContentSourceService,
  uploader: FiftyoneCtoImageUploader
): Promise<FiftyoneCtoImageUploadingResult> {
  const matches = collectFiftyoneCtoImageMatches(markdown);
  let result = markdown;
  let uploadedCount = 0;
  let inlinedCount = 0;
  const failed: Array<{ source: string; reason: string }> = [];

  for (let index = matches.length - 1; index >= 0; index--) {
    const { start, end, alt, source } = matches[index];
    if (source.startsWith("data:")) continue;
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

      let url: string;
      try {
        url = await uploader.upload(buffer, resource.mimeType, source.split("/").pop() || "image.png");
        uploadedCount++;
      } catch {
        // 图床上传失败（端点/网络/Cookie 问题），回退为 base64 内联，避免图片丢失。
        url = `data:${resource.mimeType};base64,${buffer.toString("base64")}`;
        inlinedCount++;
      }

      result = result.slice(0, start) + `![${alt}](${url})` + result.slice(end);
    } catch (error) {
      failed.push({ source, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { markdown: result, uploadedCount, inlinedCount, failed };
}

export function collectFiftyoneCtoImageMatches(markdown: string): ImageMatch[] {
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

    offset += line.length + 1;
  }

  return matches;
}

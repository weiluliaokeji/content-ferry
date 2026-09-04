import type { ContentSourceService } from "../content/content-source-service";
import { rasterizeSvgToPng } from "../../shared/svg-rasterize";
import { FiftyoneCtoImageUploader } from "./fiftyone-cto-image-uploader";

/**
 * 把文章中的本地图片上传到 51CTO 图床（OSS），替换为远程 URL。
 * 单张上传失败时**不**回退为 base64 内联——内联后的文章包含超长 data URI，
 * 51CTO 文章页加载异常且可能被截断，实际不可用。由调用方（频道服务）在拿到
 * failed 列表后整体中止发布。
 *
 * 远程 http(s) 图片、data URI 不动。仅在 51CTO 账号已配置 Cookie 时调用。
 */
export interface FiftyoneCtoImageUploadingResult {
  markdown: string;
  /** 成功上传到 51CTO 图床并替换为远程 URL 的张数。 */
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
 * 51CTO 编辑器（am-engine）与发布后的文章页都不渲染 <img src="...svg">，会显示成深灰块。
 * 提前把 SVG 栅格化为 PNG，扩展名同步改成 .png，避免 COS/51CTO 按扩展名校验 mime 后再次失败。
 */
function rasterizeSvgIfNeeded(buffer: Buffer, mimeType: string, source: string): { buffer: Buffer; mimeType: string; filename: string } {
  const filename = source.split("/").pop() || "image.png";
  if (mimeType !== "image/svg+xml" && !filename.toLowerCase().endsWith(".svg")) {
    return { buffer, mimeType, filename };
  }
  const png = rasterizeSvgToPng(buffer);
  return { buffer: png, mimeType: "image/png", filename: filename.replace(/\.svg$/i, ".png") || "image.png" };
}

/**
 * 把文章中的本地图片上传到 51CTO 图床（OSS），替换为远程 URL。
 * 单张上传失败时**不**回退为 base64 内联——内联后的文章包含超长 data URI，
 * 51CTO 文章页加载异常且可能被截断，实际不可用。由调用方（频道服务）在拿到
 * failed 列表后整体中止发布。
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

      const { buffer: preparedBuffer, mimeType: preparedMime, filename: preparedName } = rasterizeSvgIfNeeded(buffer, resource.mimeType, source);

      try {
        const url = await uploader.upload(preparedBuffer, preparedMime, preparedName);
        uploadedCount++;
        result = result.slice(0, start) + `![${alt}](${url})` + result.slice(end);
      } catch (uploadErr) {
        // 图床上传失败（端点/网络/Cookie 问题）：不回退为 base64 内联，记到 failed，
        // 让频道服务整体中止发布（内联文章不可用）。同时打日志便于定位。
        const reason = uploadErr instanceof Error
          ? uploadErr.message
          : typeof uploadErr === "object" && uploadErr !== null
            ? JSON.stringify(uploadErr, Object.getOwnPropertyNames(uploadErr))
            : String(uploadErr);
        console.error(`[51cto] COS 上传失败：source=${source} reason=${reason}`);
        failed.push({ source, reason });
      }
    } catch (error) {
      failed.push({ source, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { markdown: result, uploadedCount, failed };
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

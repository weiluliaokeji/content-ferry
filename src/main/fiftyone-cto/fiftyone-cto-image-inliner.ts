import type { ContentSourceService } from "../content/content-source-service";

export interface FiftyoneCtoImageInliningResult {
  markdown: string;
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

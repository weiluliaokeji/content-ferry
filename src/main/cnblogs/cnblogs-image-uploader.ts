import type { ContentSourceService } from "../content/content-source-service";
import type { LocalAssetStore } from "../content/local-asset-store";

export interface CnblogsAssetFailure {
  source: string;
  reason: string;
}

export interface CnblogsUploadedAsset {
  source: string;
  url: string;
}

export interface CnblogsImageUploadingResult {
  markdown: string;
  uploadedAssets: CnblogsUploadedAsset[];
  failedAssets: CnblogsAssetFailure[];
}

export const CNBLOGS_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface ImageMatch {
  start: number;
  end: number;
  alt: string;
  source: string;
}

const imagePattern = /!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

/** Collect every Markdown image reference, skipping fenced code blocks so URLs
 * inside code snippets are never treated as article images. Mirrors the
 * CSDN inliner's scan so behaviour stays consistent across platforms. */
export function collectCnblogsImageMatches(markdown: string): ImageMatch[] {
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

/**
 * Upload every local image referenced by the channel draft Markdown to the
 * Cnblogs image hosting through MetaWeblog `newMediaObject` and rewrite the
 * Markdown to use the permanent returned URLs. Remote http(s) references and
 * data: URIs are left untouched (Cnblogs can render them directly). An optional
 * cover source is uploaded first and inserted at the very beginning of the
 * Markdown so it becomes the first (cover) image.
 *
 * Images larger than 10 MB are reported in `failedAssets` and skipped — they
 * would be rejected by Cnblogs anyway, so failing fast avoids a half-published
 * draft with broken images.
 */
export async function uploadCnblogsImages(
  input: {
    markdown: string;
    workspaceId: string;
    sourceRelativePath: string;
    contentSources: ContentSourceService;
    assetStore?: LocalAssetStore;
    coverSource?: string;
    uploadImage: (source: string, buffer: Buffer, mimeType: string, fileName: string) => Promise<string>;
  }
): Promise<CnblogsImageUploadingResult> {
  const { markdown, workspaceId, sourceRelativePath, contentSources, assetStore, coverSource, uploadImage } = input;
  const uploadedAssets: CnblogsUploadedAsset[] = [];
  const failedAssets: CnblogsAssetFailure[] = [];
  const seen = new Map<string, string>(); // source -> uploaded url (dedupe)

  let body = markdown;

  // Cover first: it must become the first image of the article. 先上传封面并登记
  // 去重映射，但**先不插入正文**——封面会改变 result 的长度，导致基于原始
  // markdown 计算出的图片偏移全部失效。这里先完成正文图片替换，最后再前插封面。
  let coverInsertion = "";
  if (coverSource) {
    const upload = await uploadOne(coverSource);
    if (upload) {
      coverInsertion = `![封面](${upload.url})\n\n`;
      uploadedAssets.push({ source: coverSource, url: upload.url });
      seen.set(coverSource, upload.url);
    }
  }

  const matches = collectCnblogsImageMatches(markdown);
  // Replace from end to start so earlier indices stay valid after each splice.
  // 替换始终基于原始 markdown 的偏移在 body 上进行；封面最后统一前插，不参与偏移计算。
  for (let index = matches.length - 1; index >= 0; index--) {
    const { start, end, alt, source } = matches[index];
    if (source.startsWith("data:")) continue;
    if (/^https?:\/\//i.test(source)) continue; // remote images stay as-is
    const existing = seen.get(source);
    if (existing) {
      body = body.slice(0, start) + `![${alt}](${existing})` + body.slice(end);
      continue;
    }
    const upload = await uploadOne(source);
    if (upload) {
      seen.set(source, upload.url);
      body = body.slice(0, start) + `![${alt}](${upload.url})` + body.slice(end);
      uploadedAssets.push({ source, url: upload.url });
    }
  }

  return { markdown: coverInsertion + body, uploadedAssets, failedAssets };

  async function uploadOne(source: string): Promise<CnblogsUploadedAsset | null> {
    try {
      const { buffer, mimeType, fileName } = await resolveImageBytes(source, workspaceId, sourceRelativePath, contentSources, assetStore);
      if (buffer.length === 0) {
        failedAssets.push({ source, reason: "图片内容为空。" });
        return null;
      }
      if (buffer.length > CNBLOGS_MAX_IMAGE_BYTES) {
        const sizeMb = (buffer.length / (1024 * 1024)).toFixed(1);
        failedAssets.push({ source, reason: `图片 ${sizeMb} MB 超过博客园 10 MB 限制。` });
        return null;
      }
      const url = await uploadImage(source, buffer, mimeType, fileName);
      if (!url) {
        failedAssets.push({ source, reason: "博客园没有返回图片地址。" });
        return null;
      }
      return { source, url };
    } catch (error) {
      failedAssets.push({ source, reason: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
}

async function resolveImageBytes(
  source: string,
  workspaceId: string,
  sourceRelativePath: string,
  contentSources: ContentSourceService,
  assetStore?: LocalAssetStore
): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  if (source.startsWith("contentferry-asset://")) {
    const match = /^contentferry-asset:\/\/([^/]+)\/(.+)$/.exec(source);
    if (!match) throw new Error(`无法解析素材地址：${source}`);
    if (!assetStore) throw new Error("本地素材库未启用，无法读取该图片。");
    const { bytes, mimeType } = assetStore.readBytes(match[1], match[2]);
    return { buffer: bytes, mimeType, fileName: match[2] };
  }

  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）。`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || guessMimeType(source);
    return { buffer, mimeType, fileName: fileNameFromSource(source) };
  }

  const resource = contentSources.readArticleResource(workspaceId, sourceRelativePath, source);
  const chunks: Buffer[] = [];
  for await (const chunk of resource.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return { buffer: Buffer.concat(chunks), mimeType: resource.mimeType, fileName: fileNameFromSource(source) };
}

function guessMimeType(source: string): string {
  const extension = source.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "avif": return "image/avif";
    default: return "application/octet-stream";
  }
}

function fileNameFromSource(source: string): string {
  const name = source.split(/[\\/]/).at(-1)?.split(/[?#]/, 1)[0] || "cnblogs-image.png";
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // keep original
  }
  return decoded.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 200) || "cnblogs-image.png";
}

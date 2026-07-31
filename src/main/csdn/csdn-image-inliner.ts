import type { ContentSourceService } from "../content/content-source-service";

export interface CsdnImageInliningResult {
  markdown: string;
  inlinedCount: number;
  failed: Array<{ source: string; reason: string }>;
}

export interface CsdnImageUploadingResult {
  markdown: string;
  uploadedCount: number;
  failed: Array<{ source: string; reason: string }>;
}

interface ImageMatch {
  start: number;
  end: number;
  alt: string;
  source: string;
  whole: string;
}

const imagePattern = /!\[([^\]]*)]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

/** Inline local article images as base64 data URIs so CSDN's editor can render
 * them without relying on external hotlinking (which CSDN blocks with an
 * anti-hotlink mechanism). Remote http(s) images are downloaded best-effort;
 * if download fails the original URL is left untouched so CSDN can still try
 * its own transfer. */
export async function inlineCsdnImages(
  markdown: string,
  workspaceId: string,
  sourceRelativePath: string,
  contentSources: ContentSourceService
): Promise<CsdnImageInliningResult> {
  const matches = collectImageMatches(markdown);
  // Replace from end to start so earlier indices stay valid after each splice.
  let result = markdown;
  let inlinedCount = 0;
  const failed: Array<{ source: string; reason: string }> = [];

  for (let index = matches.length - 1; index >= 0; index--) {
    const { start, end, alt, source } = matches[index];
    if (source.startsWith("data:")) continue;

    try {
      const { buffer, mimeType } = await resolveImage(source, workspaceId, sourceRelativePath, contentSources);
      if (buffer.length === 0) {
        failed.push({ source, reason: "图片内容为空。" });
        continue;
      }
      const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
      result = result.slice(0, start) + `![${alt}](${dataUrl})` + result.slice(end);
      inlinedCount++;
    } catch (error) {
      failed.push({ source, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { markdown: result, inlinedCount, failed };
}

/** Upload local/remote article images to CSDN's image hosting and rewrite the
 * Markdown to use the returned CSDN URLs. This is the only reliable way to make
 * images render inside CSDN's Markdown editor: CSDN treats base64 data URIs as
 * external links and its transfer proxy fails, so we upload before filling. */
export async function uploadCsdnImages(
  markdown: string,
  workspaceId: string,
  sourceRelativePath: string,
  contentSources: ContentSourceService,
  uploadImage: (source: string, buffer: Buffer, mimeType: string) => Promise<string>
): Promise<CsdnImageUploadingResult> {
  const matches = collectImageMatches(markdown);
  let result = markdown;
  let uploadedCount = 0;
  const failed: Array<{ source: string; reason: string }> = [];

  for (let index = matches.length - 1; index >= 0; index--) {
    const { start, end, alt, source } = matches[index];
    if (source.startsWith("data:")) continue;
    // Already hosted on CSDN — no need to re-upload.
    if (/^https?:\/\/(?:img-)?blog\.csdnimg\.cn\//i.test(source) || /^https?:\/\/[\w-]*\.csdnimg\.cn\//i.test(source)) continue;

    try {
      const { buffer, mimeType } = await resolveImage(source, workspaceId, sourceRelativePath, contentSources);
      if (buffer.length === 0) {
        failed.push({ source, reason: "图片内容为空。" });
        continue;
      }
      const csdnUrl = await uploadImage(source, buffer, mimeType);
      result = result.slice(0, start) + `![${alt}](${csdnUrl})` + result.slice(end);
      uploadedCount++;
    } catch (error) {
      failed.push({ source, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { markdown: result, uploadedCount, failed };
}

export function collectImageMatches(markdown: string): ImageMatch[] {
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
      let match;
      imagePattern.lastIndex = 0;
      while ((match = imagePattern.exec(line)) !== null) {
        matches.push({
          start: offset + match.index,
          end: offset + match.index + match[0].length,
          alt: match[1],
          source: match[2],
          whole: match[0]
        });
      }
    }

    offset += line.length + 1; // +1 for the newline separator
  }

  return matches;
}

async function resolveImage(
  source: string,
  workspaceId: string,
  sourceRelativePath: string,
  contentSources: ContentSourceService
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (/^https?:\/\//i.test(source)) {
    return downloadRemoteImage(source);
  }

  const resource = contentSources.readArticleResource(workspaceId, sourceRelativePath, source);
  const chunks: Buffer[] = [];
  for await (const chunk of resource.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return { buffer: Buffer.concat(chunks), mimeType: resource.mimeType };
}

async function downloadRemoteImage(source: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await fetch(source, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}），保留原链接让 CSDN 尝试转存。`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || guessMimeType(source);
  return { buffer, mimeType };
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

function isCsdnHosted(source: string): boolean {
  return /^https?:\/\/(?:img-)?blog\.csdnimg\.cn\//i.test(source) || /^https?:\/\/[\w-]*\.csdnimg\.cn\//i.test(source);
}

function sanitizeImageName(name: string): string {
  let decoded = name;
  try { decoded = decodeURIComponent(name); } catch { /* keep original */ }
  return decoded.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 200) || "image";
}

export interface ResolvedCsdnImage {
  source: string;
  dataUrl: string;
  mimeType: string;
  filename: string;
}

/** Resolve every uploadable image in the Markdown (local files via the article
 * source store, remote http(s) by download) into a base64 data URL so the main
 * process can push the bytes into the CSDN editor page and let CSDN's own
 * upload API host them. Already-CSDN-hosted and data: URIs are skipped. */
export async function resolveCsdnImagesForBrowser(
  markdown: string,
  workspaceId: string,
  sourceRelativePath: string,
  contentSources: ContentSourceService
): Promise<ResolvedCsdnImage[]> {
  const matches = collectImageMatches(markdown);
  const seen = new Set<string>();
  const out: ResolvedCsdnImage[] = [];

  for (const { source } of matches) {
    if (source.startsWith("data:")) continue;
    if (isCsdnHosted(source)) continue;
    if (seen.has(source)) continue;
    seen.add(source);

    try {
      const { buffer, mimeType } = await resolveImage(source, workspaceId, sourceRelativePath, contentSources);
      if (buffer.length === 0) continue;
      const rawName = source.split("/").pop()?.split("?")[0] || "image";
      out.push({
        source,
        dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
        mimeType,
        filename: sanitizeImageName(rawName)
      });
    } catch {
      // Unresolvable images are left untouched for CSDN to attempt on its own.
    }
  }

  return out;
}

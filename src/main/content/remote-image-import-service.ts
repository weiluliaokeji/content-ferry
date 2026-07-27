import { lookup } from "node:dns/promises";
import net from "node:net";
import type { ContentSourceService } from "./content-source-service";
import type { LocalAssetStore } from "./local-asset-store";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export class RemoteImageImportService {
  constructor(
    private readonly assets: LocalAssetStore | undefined,
    private readonly contentSources: ContentSourceService,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async importForArticle(workspaceId: string, relativePath: string, sourceUrl: string): Promise<{ assetUrl: string }> {
    const image = await this.download(sourceUrl);
    return this.contentSources.saveArticleAsset(workspaceId, relativePath, image.mimeType, image.bytes.toString("base64"));
  }

  async importForProject(contextId: string, sourceUrl: string): Promise<{ assetUrl: string; previewUrl: string }> {
    if (!this.assets) throw new Error("本地素材服务尚未启用。");
    const image = await this.download(sourceUrl);
    return this.assets.save(contextId, image.mimeType, image.bytes.toString("base64"));
  }

  private async download(sourceUrl: string): Promise<{ bytes: Buffer; mimeType: ImageMime }> {
    let current = parsePublicImageUrl(sourceUrl);
    for (let attempt = 0; attempt <= MAX_REDIRECTS; attempt += 1) {
      await assertPublicHost(current);
      const response = await this.fetcher(current, {
        redirect: "manual",
        headers: { accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1" },
        signal: AbortSignal.timeout(30_000)
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("远程图片重定向缺少目标地址。");
        current = parsePublicImageUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) throw new Error(`下载远程图片失败（HTTP ${response.status}）。`);
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) throw new Error("远程图片超过 15 MB，未保存。");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("远程图片为空或超过 15 MB，未保存。");
      const mimeType = detectImageMime(bytes);
      if (!mimeType) throw new Error("远程地址返回的不是受支持的 JPG、PNG、GIF 或 WebP 图片。");
      return { bytes, mimeType };
    }
    throw new Error("远程图片重定向次数过多，未保存。");
  }
}

type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function parsePublicImageUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("图片地址无效。"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("只能导入 HTTP 或 HTTPS 图片地址。");
  if (url.username || url.password) throw new Error("图片地址不能包含用户名或密码。");
  return url;
}

async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("不能导入本机地址中的图片。");
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error("不能导入私有网络或保留地址中的图片。");
  }
}

function isPrivateAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    return first === 0 || first === 10 || first === 127 || first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19));
  }
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") ||
    normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
}

function detectImageMime(bytes: Buffer): ImageMime | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

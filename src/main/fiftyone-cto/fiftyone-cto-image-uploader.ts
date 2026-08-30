import { FiftyoneCtoCredentialsError } from "./fiftyone-cto-channel-error";

type FetchLike = typeof fetch;

/**
 * 51CTO 编辑器基于 am-editor，其 ImageUploader 通过 POST multipart 把图片传到 51CTO
 * 后端的图床（阿里云 OSS），再由后端返回公网可访问的图片 URL。客户端不需要自己计算
 * OSS 签名 —— 这是服务端行为。am-editor 的响应解析约定为：
 *   response.url || response.data?.url || response.src || response.data?.src
 *
 * 上传端点（IMAGE_UPLOAD_URL）来自 51CTO 编辑器 JS 配置，需登录态才能从浏览器抓到。
 * 下方为常用候选；若实际返回非预期（如一直走 base64 回退），请以浏览器 DevTools 中
 * 上传图片时的真实请求地址覆盖此常量。
 */
export const FIFTYONE_CTO_IMAGE_UPLOAD_URL = "https://blog.51cto.com/blogger/upload";

const UPLOAD_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0";

export interface FiftyoneCtoImageUploaderOptions {
  /** 覆盖默认上传端点（用于联调或端点变更）。 */
  uploadUrl?: string;
}

export class FiftyoneCtoImageUploader {
  private readonly uploadUrl: string;

  constructor(
    private readonly cookie: string,
    private readonly fetcher: FetchLike = fetch,
    options: FiftyoneCtoImageUploaderOptions = {}
  ) {
    this.uploadUrl = options.uploadUrl ?? FIFTYONE_CTO_IMAGE_UPLOAD_URL;
  }

  /** 上传单张图片，返回 51CTO 图床的公网 URL。失败时抛出 FiftyoneCtoCredentialsError。 */
  async upload(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
    if (!this.cookie) {
      throw new FiftyoneCtoCredentialsError("51CTO 账号尚未配置 Cookie，无法上传图片到图床。");
    }

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimeType || "application/octet-stream" }), filename);

    const headers: Record<string, string> = {
      "User-Agent": UPLOAD_USER_AGENT,
      Cookie: this.cookie,
      "x-requested-with": "XMLHttpRequest",
      Origin: "https://blog.51cto.com",
      Referer: "https://blog.51cto.com/blogger/publish"
    };

    const resp = await this.fetcher(this.uploadUrl, {
      method: "POST",
      headers,
      body: form
    });
    if (!resp.ok) {
      throw new FiftyoneCtoCredentialsError(`51CTO 图片上传失败：HTTP ${resp.status}`);
    }

    const text = await resp.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
    const url: unknown =
      parsed?.url ?? parsed?.data?.url ?? parsed?.src ?? parsed?.data?.src;
    if (typeof url !== "string" || !url) {
      throw new FiftyoneCtoCredentialsError(`51CTO 图片上传响应缺少图片 URL：${text.slice(0, 200)}`);
    }
    return url;
  }
}

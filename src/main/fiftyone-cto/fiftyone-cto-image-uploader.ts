import { FiftyoneCtoCredentialsError } from "./fiftyone-cto-channel-error";

type FetchLike = typeof fetch;

const UPLOAD_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0";

/** 51CTO 登录态相关的接口需要浏览器特征头，否则会被当作非浏览器请求拒绝。 */
export function buildFiftyoneCtoHeaders(cookie: string): Record<string, string> {
  return {
    "User-Agent": UPLOAD_USER_AGENT,
    Cookie: cookie,
    accept: "application/json, text/javascript, */*; q=0.01",
    "accept-language": "zh-CN,zh;q=0.9",
    origin: "https://blog.51cto.com",
    referer: "https://blog.51cto.com/blogger/publish",
    "x-requested-with": "XMLHttpRequest"
  };
}

const SIGN_URL = "https://blog.51cto.com/getUploadSign";
const CONFIG_URL = "https://blog.51cto.com/getUploadConfig";

interface UploadSignResponse {
  code: number;
  msg?: string;
  data?: {
    url?: string;
    sign?: string;
  };
}

interface UploadConfigField {
  key: string;
  policy: string;
  "x-amz-algorithm": string;
  "x-amz-signature": string;
  "x-amz-credential": string;
  "X-Amz-Date": string;
  [key: string]: string;
}

interface UploadConfigResponse {
  code: number;
  msg?: string;
  data?: {
    url?: string;
    fields?: UploadConfigField;
  };
}

export class FiftyoneCtoImageUploader {
  private readonly baseHeaders: Record<string, string>;

  constructor(
    private readonly cookie: string,
    private readonly fetcher: FetchLike = fetch
  ) {
    this.baseHeaders = buildFiftyoneCtoHeaders(cookie);
  }

  /** 上传单张图片到 51CTO 腾讯云 COS 图床，返回公网可访问的 URL。 */
  async upload(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
    if (!this.cookie) {
      throw new FiftyoneCtoCredentialsError("51CTO 账号尚未配置 Cookie，无法上传图片到图床。");
    }
    if (!buffer || buffer.length === 0) {
      throw new FiftyoneCtoCredentialsError("上传图片内容为空。");
    }

    const sign = await this.fetchUploadSign();
    const config = await this.fetchUploadConfig(sign.sign);

    const key = config.fields.key;
    if (!key) {
      throw new FiftyoneCtoCredentialsError("51CTO 上传配置缺少 key 字段。");
    }

    await this.postToCos(config.url, config.fields, buffer, mimeType, filename);

    const cdnBase = sign.url.endsWith("/") ? sign.url : `${sign.url}/`;
    return `${cdnBase}${key}`;
  }

  private async fetchUploadSign(): Promise<{ url: string; sign?: string }> {
    // getUploadSign 必须为 POST + upload_type=image，否则 51CTO 返回
    // code:10003 "请求方式错误"（GET 会被服务端判定为错误请求方式）。
    const resp = await this.fetcher(SIGN_URL, {
      method: "POST",
      headers: this.baseHeaders,
      body: new URLSearchParams({ upload_type: "image" })
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new FiftyoneCtoCredentialsError(`获取 51CTO 上传签名失败：HTTP ${resp.status}`);
    }
    let parsed: UploadSignResponse;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new FiftyoneCtoCredentialsError(`51CTO 上传签名响应不是 JSON：${text.slice(0, 200)}`);
    }
    if (parsed.code !== 0 || !parsed.data?.url) {
      throw new FiftyoneCtoCredentialsError(
        `51CTO 上传签名响应异常：${parsed.msg || text.slice(0, 200)}`
      );
    }
    return { url: parsed.data.url, sign: parsed.data.sign };
  }

  private async fetchUploadConfig(sign?: string): Promise<{ url: string; fields: UploadConfigField }> {
    // getUploadConfig 同样需要 POST；并按 51CTO 文档依赖 getUploadSign 返回的签名。
    const params = new URLSearchParams({ upload_type: "image" });
    if (sign) params.set("upload_sign", sign);
    const resp = await this.fetcher(CONFIG_URL, {
      method: "POST",
      headers: this.baseHeaders,
      body: params
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new FiftyoneCtoCredentialsError(`获取 51CTO 上传配置失败：HTTP ${resp.status}`);
    }
    let parsed: UploadConfigResponse;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new FiftyoneCtoCredentialsError(`51CTO 上传配置响应不是 JSON：${text.slice(0, 200)}`);
    }
    if (parsed.code !== 0 || !parsed.data?.url || !parsed.data?.fields) {
      // 把 51CTO 服务端的 raw 响应一并抛上来，便于 channel-service 把 raw 写进
      // status_note —— 排查"参数错误"等通用错时这是唯一线索。这里只截 500 字避免
      // 把 base64 之类的整段 COS 凭证写进日志/DB。
      throw new FiftyoneCtoCredentialsError(
        `51CTO 上传配置响应异常：${parsed.msg || "无 msg"} (code=${parsed.code}, body=${text.slice(0, 500)})`
      );
    }
    const fields = parsed.data.fields;
    const required = ["key", "policy", "x-amz-algorithm", "x-amz-signature", "x-amz-credential", "X-Amz-Date"];
    const missing = required.filter((k) => !fields[k]);
    if (missing.length > 0) {
      throw new FiftyoneCtoCredentialsError(`51CTO 上传配置缺少字段：${missing.join(", ")}`);
    }
    return { url: parsed.data.url, fields };
  }

  private async postToCos(
    cosUrl: string,
    fields: UploadConfigField,
    buffer: Buffer,
    mimeType: string,
    filename: string
  ): Promise<void> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      form.append(k, v);
    }
    form.append("content-type", mimeType || "application/octet-stream");
    form.append("file", new Blob([buffer], { type: mimeType || "application/octet-stream" }), filename);

    const headers: Record<string, string> = {
      ...this.baseHeaders,
      origin: "https://blog.51cto.com",
      referer: "https://blog.51cto.com/"
    };
    // FormData 自己设置 boundary，不能覆盖 content-type。
    delete headers["content-type"];

    const resp = await this.fetcher(cosUrl, { method: "POST", headers, body: form as unknown as RequestInit["body"] });
    if (!resp.ok && resp.status !== 204) {
      const body = await resp.text().catch(() => "");
      throw new FiftyoneCtoCredentialsError(`COS 图片上传失败：HTTP ${resp.status} ${body.slice(0, 200)}`);
    }
  }
}

/**
 * Juejin ImageX image uploader.
 *
 * Implements the 5-step Juejin image upload flow:
 *   ① GET  https://api.juejin.cn/imagex/gen_token?client=web   (Cookie auth)
 *        -> STS credentials {AccessKeyID, SecretAccessKey, SessionToken}
 *        (falls back to /imagex/v2/gen_token on failure)
 *   ② GET  https://imagex.bytedanceapi.com/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=k3u1fbpfcp
 *        (AWS SigV4, region cn-north-1, service imagex)
 *        -> UploadHosts / StoreInfos(StoreUri+Auth) / SessionKey
 *   ③ POST https://{uploadHost}/{storeUri}                      (raw binary)
 *        headers: authorization=StoreAuth, Content-Type: application/octet-stream,
 *                 content-crc32=<CRC32 hex (poly 0xEDB88320)>
 *   ④ POST https://imagex.bytedanceapi.com/?Action=CommitImageUpload&Version=2018-08-01&SessionKey={sessionKey}&ServiceId=k3u1fbpfcp
 *        (SigV4) -> confirm upload
 *   ⑤ GET  https://api.juejin.cn/imagex/get_img_url?uri={storeUri}
 *        -> main_url as the final CDN image URL.
 *
 * SigV4 signing is hand-written with Node's built-in crypto (hmac-sha256); no
 * new npm dependency is introduced. The juejin gen_token/get_img_url calls only
 * carry Cookie + User-Agent — no msToken/a_bogus required.
 */
import { createHash, createHmac } from "node:crypto";

const JUJIN_API_BASE = "https://api.juejin.cn";
const IMAGEX_API_HOST = "imagex.bytedanceapi.com";
const IMAGEX_SERVICE_ID = "k3u1fbpfcp";
const IMAGEX_REGION = "cn-north-1";
const IMAGEX_SERVICE = "imagex";
const IMAGEX_VERSION = "2018-08-01";

export interface JuejinImageUploadOptions {
  cookie: string;
  fetcher?: typeof fetch;
  userAgent?: string;
}

export interface JuejinImageUploadResult {
  url: string;
  storeUri: string;
}

export class JuejinImageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JuejinImageUploadError";
  }
}

/** CRC32 (poly 0xEDB88320, reflected, init 0xFFFFFFFF, final xor 0xFFFFFFFF). */
export function crc32(buffer: Buffer): string {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16);
}

/** RFC3986 URI component encoding (AWS canonical query requires it). */
function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** AWS SigV4 signing key chain. */
function signingKey(secretAccessKey: string, date: string, region: string, service: string): Buffer {
  const kDate = createHmac("sha256", `AWS4${secretAccessKey}`).update(date).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}

interface SigV4Params {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  date: string;
}

/** Build the AWS SigV4 Authorization header for a request. */
export function buildSigV4Authorization(params: SigV4Params): { authorization: string; amzDate: string } {
  const { method, host, path, query, headers, body, accessKeyId, secretAccessKey, sessionToken, date } = params;
  const amzDate = `${date}T000000Z`;
  const scope = `${date}/${IMAGEX_REGION}/${IMAGEX_SERVICE}/aws4_request`;

  // Canonical query string: sorted by key, RFC3986-encoded key=value.
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((key) => `${rfc3986Encode(key)}=${rfc3986Encode(query[key])}`)
    .join("&");

  const signedHeadersList = ["host", "x-amz-date"];
  if (sessionToken) signedHeadersList.push("x-amz-security-token");
  const signedHeaders = signedHeadersList.join(";");

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-date:${amzDate}\n` +
    (sessionToken ? `x-amz-security-token:${sessionToken}\n` : "");

  const hashedPayload = createHash("sha256").update(body).digest("hex");
  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    hashedPayload
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex")
  ].join("\n");

  const key = signingKey(secretAccessKey, date, IMAGEX_REGION, IMAGEX_SERVICE);
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");

  const credential = `${accessKeyId}/${scope}`;
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, amzDate };
}

/** Tolerant field lookup for STS/JSON payloads with different key casings. */
function pick<T>(obj: Record<string, unknown>, keys: string[]): T | undefined {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key] as T;
  }
  return undefined;
}

interface StsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

interface ApplyImageUploadInfo {
  uploadHosts: string[];
  storeUri: string;
  auth: string;
  sessionKey: string;
}

export class JuejinImageUploader {
  private readonly cookie: string;
  private readonly fetcher: typeof fetch;
  private readonly userAgent: string;

  constructor(options: JuejinImageUploadOptions) {
    this.cookie = options.cookie;
    this.fetcher = options.fetcher ?? fetch;
    this.userAgent = options.userAgent ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  }

  /** Upload an image buffer to Juejin ImageX and return the CDN URL. */
  async uploadImage(buffer: Buffer): Promise<JuejinImageUploadResult> {
    const sts = await this.getStsCredentials();
    const apply = await this.applyImageUpload(sts);
    await this.uploadBinary(buffer, apply);
    await this.commitImageUpload(sts, apply.sessionKey);
    const url = await this.getImageUrl(apply.storeUri);
    return { url, storeUri: apply.storeUri };
  }

  /** ① gen_token -> STS credentials (with /v2 fallback). */
  private async getStsCredentials(): Promise<StsCredentials> {
    let data: Record<string, unknown> | undefined;
    for (const url of [`${JUJIN_API_BASE}/imagex/gen_token?client=web`, `${JUJIN_API_BASE}/imagex/v2/gen_token`]) {
      const response = await this.fetcher(url, {
        method: "GET",
        headers: { Cookie: this.cookie, "User-Agent": this.userAgent }
      });
      if (!response.ok) continue;
      const json = (await response.json()) as Record<string, unknown>;
      const errNo = pick<number>(json, ["err_no", "errNo"]);
      if (errNo !== undefined && errNo !== 0) continue;
      const payload = (json.data ?? json) as Record<string, unknown>;
      // 真实响应为 { err_no, data: { token: { AccessKeyId, SecretAccessKey, SessionToken } } }
      const tokenPayload = (payload.token ?? payload) as Record<string, unknown>;
      const accessKeyId = pick<string>(tokenPayload, ["AccessKeyID", "AccessKeyId", "accessKeyID", "accessKeyId", "access_key_id"]);
      const secretAccessKey = pick<string>(tokenPayload, ["SecretAccessKey", "secretAccessKey", "secret_access_key"]);
      const sessionToken = pick<string>(tokenPayload, ["SessionToken", "sessionToken", "session_token"]);
      if (accessKeyId && secretAccessKey && sessionToken) {
        data = { accessKeyId, secretAccessKey, sessionToken };
        break;
      }
    }
    if (!data) {
      throw new JuejinImageUploadError("获取掘金图片上传 STS 凭证失败（gen_token），请检查账号 Cookie 是否有效。");
    }
    return data as unknown as StsCredentials;
  }

  /** ② ApplyImageUpload -> UploadHosts / StoreInfos / SessionKey (SigV4). */
  private async applyImageUpload(sts: StsCredentials): Promise<ApplyImageUploadInfo> {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const query: Record<string, string> = {
      Action: "ApplyImageUpload",
      Version: IMAGEX_VERSION,
      ServiceId: IMAGEX_SERVICE_ID
    };
    const sig = buildSigV4Authorization({
      method: "GET",
      host: IMAGEX_API_HOST,
      path: "/",
      query,
      headers: {},
      body: "",
      accessKeyId: sts.accessKeyId,
      secretAccessKey: sts.secretAccessKey,
      sessionToken: sts.sessionToken,
      date
    });
    const queryString = Object.keys(query)
      .sort()
      .map((key) => `${rfc3986Encode(key)}=${rfc3986Encode(query[key])}`)
      .join("&");
    const response = await this.fetcher(`https://${IMAGEX_API_HOST}/?${queryString}`, {
      method: "GET",
      headers: {
        Authorization: sig.authorization,
        "X-Amz-Date": sig.amzDate,
        "X-Amz-Security-Token": sts.sessionToken,
        "User-Agent": this.userAgent
      }
    });
    if (!response.ok) {
      throw new JuejinImageUploadError(`ApplyImageUpload 失败（HTTP ${response.status}）。`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    // 真实响应为 { ResponseMetadata, Result: { UploadAddress: { UploadHosts, StoreInfos, SessionKey } } }
    const result = (json.Result ?? json.result ?? {}) as Record<string, unknown>;
    const uploadAddress = (result.UploadAddress ?? result.upload_address ?? json.UploadAddress ?? json.upload_address ?? {}) as Record<string, unknown>;
    const uploadHosts = (pick<unknown[]>(uploadAddress, ["UploadHosts", "uploadHosts"]) ?? []) as string[];
    const storeInfos = (pick<unknown[]>(uploadAddress, ["StoreInfos", "storeInfos"]) ?? []) as Array<Record<string, unknown>>;
    const sessionKey = pick<string>(uploadAddress, ["SessionKey", "sessionKey"]) ?? "";
    const firstStore = storeInfos[0] ?? {};
    const storeUri = pick<string>(firstStore, ["StoreUri", "storeUri"]) ?? "";
    const auth = pick<string>(firstStore, ["Auth", "auth"]) ?? "";
    if (!uploadHosts.length || !storeUri || !auth || !sessionKey) {
      throw new JuejinImageUploadError("ApplyImageUpload 返回缺少上传地址或凭证。");
    }
    return { uploadHosts, storeUri, auth, sessionKey };
  }

  /** ③ Upload raw binary to the upload host. */
  private async uploadBinary(buffer: Buffer, apply: ApplyImageUploadInfo): Promise<void> {
    const uploadHost = apply.uploadHosts[0];
    const url = `https://${uploadHost}/${apply.storeUri}`;
    const response = await this.fetcher(url, {
      method: "POST",
      headers: {
        Authorization: apply.auth,
        "Content-Type": "application/octet-stream",
        "content-crc32": crc32(buffer),
        "User-Agent": this.userAgent
      },
      body: new Uint8Array(buffer)
    });
    if (!response.ok) {
      throw new JuejinImageUploadError(`图片直传失败（HTTP ${response.status}）。`);
    }
  }

  /** ④ CommitImageUpload (SigV4) to confirm the upload. */
  private async commitImageUpload(sts: StsCredentials, sessionKey: string): Promise<void> {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const query: Record<string, string> = {
      Action: "CommitImageUpload",
      Version: IMAGEX_VERSION,
      SessionKey: sessionKey,
      ServiceId: IMAGEX_SERVICE_ID
    };
    const sig = buildSigV4Authorization({
      method: "POST",
      host: IMAGEX_API_HOST,
      path: "/",
      query,
      headers: {},
      body: "",
      accessKeyId: sts.accessKeyId,
      secretAccessKey: sts.secretAccessKey,
      sessionToken: sts.sessionToken,
      date
    });
    const queryString = Object.keys(query)
      .sort()
      .map((key) => `${rfc3986Encode(key)}=${rfc3986Encode(query[key])}`)
      .join("&");
    const response = await this.fetcher(`https://${IMAGEX_API_HOST}/?${queryString}`, {
      method: "POST",
      headers: {
        Authorization: sig.authorization,
        "X-Amz-Date": sig.amzDate,
        "X-Amz-Security-Token": sts.sessionToken,
        "User-Agent": this.userAgent
      }
    });
    if (!response.ok) {
      throw new JuejinImageUploadError(`CommitImageUpload 失败（HTTP ${response.status}）。`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    // 真实响应为 { ResponseMetadata, Result: { Results: [{ Uri, UriStatus }] } }，UriStatus 2000 表示成功
    const result = (json.Result ?? json.result ?? {}) as Record<string, unknown>;
    const results = (result.Results ?? result.results ?? []) as Array<Record<string, unknown>>;
    const successCount = pick<number>(result, ["SuccessCount", "successCount"]) ?? 0;
    const firstStatus = results[0] ? pick<number>(results[0], ["UriStatus", "uriStatus"]) ?? 0 : 0;
    if (successCount < 1 && firstStatus !== 2000) {
      throw new JuejinImageUploadError("CommitImageUpload 返回成功数为 0。");
    }
  }

  /** ⑤ get_img_url -> final CDN main_url. */
  private async getImageUrl(storeUri: string): Promise<string> {
    const url = `${JUJIN_API_BASE}/imagex/get_img_url?uri=${encodeURIComponent(storeUri)}`;
    const response = await this.fetcher(url, {
      method: "GET",
      headers: { Cookie: this.cookie, "User-Agent": this.userAgent }
    });
    if (!response.ok) {
      throw new JuejinImageUploadError(`get_img_url 失败（HTTP ${response.status}）。`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const errNo = pick<number>(json, ["err_no", "errNo"]);
    if (errNo !== undefined && errNo !== 0) {
      throw new JuejinImageUploadError("get_img_url 返回错误：" + String(pick(json, ["err_msg", "errMsg"]) ?? errNo));
    }
    const data = (json.data ?? {}) as Record<string, unknown>;
    const mainUrl = pick<string>(data, ["main_url", "mainUrl", "url"]);
    if (!mainUrl) {
      throw new JuejinImageUploadError("get_img_url 返回缺少 main_url。");
    }
    return mainUrl;
  }
}

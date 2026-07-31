import { ProxyAgent, fetch as undiciFetch } from "undici";
import { appendCsdnDiagnostics } from "./csdn-diagnostics";

export interface CsdnCookie {
  name: string;
  value: string;
}

export interface CsdnImageUploadOptions {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  cookies: CsdnCookie[];
  proxyUrl?: string;
}

export interface CsdnImageUploadResult {
  url: string;
  width?: string;
  height?: string;
}

interface UploadToken {
  accessId: string;
  callbackUrl: string;
  dir: string;
  expire: string;
  filePath: string;
  host: string;
  policy: string;
  signature: string;
}

const UPLOAD_TOKEN_URL = "https://imgservice.csdn.net/direct/v1.0/image/upload";
const OSS_UPLOAD_HOST = "https://csdn-img-blog.oss-cn-beijing.aliyuncs.com";

/** Upload a single image to CSDN's image hosting using credentials from an
 * already-logged-in browser session. Returns the public CSDN URL that can be
 * used directly in Markdown. */
export async function uploadImageToCsdn(options: CsdnImageUploadOptions): Promise<CsdnImageUploadResult> {
  const suffix = extensionFromFilename(options.filename) || extensionFromMime(options.mimeType) || "png";
  const filename = sanitizeFilename(options.filename);
  const token = await requestUploadToken({ suffix, cookies: options.cookies, proxyUrl: options.proxyUrl });
  return uploadToOss({ ...options, filename, suffix, token });
}

interface RequestTokenInput {
  suffix: string;
  cookies: CsdnCookie[];
  proxyUrl?: string;
}

async function requestUploadToken(input: RequestTokenInput): Promise<UploadToken> {
  const url = new URL(UPLOAD_TOKEN_URL);
  url.searchParams.set("type", "blog");
  url.searchParams.set("rtype", "markdown");
  url.searchParams.set("x-image-template", "");
  url.searchParams.set("x-image-app", "direct_blog");
  url.searchParams.set("x-image-dir", "direct");
  url.searchParams.set("x-image-suffix", input.suffix);

  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    origin: "https://editor.csdn.net",
    referer: "https://editor.csdn.net/",
    "sec-ch-ua": '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  };

  const cookieHeader = buildCookieHeader(input.cookies);
  if (cookieHeader) headers.cookie = cookieHeader;

  const response = await csdnFetch(url.toString(), { method: "GET", headers }, input.proxyUrl);
  const responseText = await response.text().catch(() => "");
  if (!response.ok) {
    appendCsdnDiagnostics(`CSDN 图片上传凭证请求失败：HTTP ${response.status}，响应：${responseText.slice(0, 1000)}`);
    throw new Error(`获取 CSDN 图片上传凭证失败（HTTP ${response.status}）。请确认 CSDN 编辑器已登录；如已登录仍失败，可能是 CSDN 接口变更。`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    appendCsdnDiagnostics(`CSDN 图片上传凭证响应不是 JSON：${responseText.slice(0, 1000)}`);
    throw new Error("解析 CSDN 图片上传凭证响应失败。");
  }

  const data = extractData(payload);
  const required = ["accessId", "callbackUrl", "filePath", "host", "policy", "signature"] as const;
  for (const key of required) {
    if (typeof data[key] !== "string" || !data[key]) {
      appendCsdnDiagnostics(`CSDN 上传凭证缺少字段 ${key}，完整响应：${JSON.stringify(payload).slice(0, 1000)}`);
      throw new Error(`CSDN 上传凭证缺少字段：${key}。`);
    }
  }

  return {
    accessId: data.accessId as string,
    callbackUrl: data.callbackUrl as string,
    dir: typeof data.dir === "string" ? data.dir : "direct",
    expire: typeof data.expire === "string" ? data.expire : "",
    filePath: data.filePath as string,
    host: data.host as string,
    policy: data.policy as string,
    signature: data.signature as string
  };
}

interface UploadToOssInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  suffix: string;
  token: UploadToken;
  cookies: CsdnCookie[];
  proxyUrl?: string;
}

async function uploadToOss(input: UploadToOssInput): Promise<CsdnImageUploadResult> {
  const form = new FormData();
  form.append("key", input.token.filePath);
  form.append("policy", input.token.policy);
  form.append("OSSAccessKeyId", input.token.accessId);
  form.append("success_action_status", "200");
  form.append("signature", input.token.signature);
  form.append("callback", input.token.callbackUrl);
  form.append("file", new Blob([input.buffer]), input.filename);

  const headers: Record<string, string> = {
    accept: "application/json, text/javascript, */*; q=0.01",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    origin: "https://editor.csdn.net",
    referer: "https://editor.csdn.net/",
    "sec-ch-ua": '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  };

  const cookieHeader = buildCookieHeader(input.cookies);
  if (cookieHeader) headers.cookie = cookieHeader;

  const response = await csdnFetch(
    input.token.host || OSS_UPLOAD_HOST,
    { method: "POST", headers, body: form as unknown as never },
    input.proxyUrl
  );

  const text = await response.text();
  if (!response.ok) {
    appendCsdnDiagnostics(`CSDN OSS 上传失败：HTTP ${response.status}，响应：${text.slice(0, 1000)}`);
    throw new Error(`上传图片到 CSDN OSS 失败（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    appendCsdnDiagnostics(`CSDN OSS 上传后返回非 JSON：${text.slice(0, 1000)}`);
    throw new Error(`上传图片后 CSDN 返回非 JSON 响应：${text.slice(0, 200)}`);
  }

  const data = extractData(payload);
  if (typeof data.imageUrl !== "string" || !data.imageUrl) {
    appendCsdnDiagnostics(`CSDN OSS 上传响应缺少 imageUrl：${JSON.stringify(payload).slice(0, 1000)}`);
    throw new Error("上传图片成功但响应中缺少 imageUrl。");
  }

  return {
    url: data.imageUrl as string,
    width: typeof data.width === "string" ? data.width : undefined,
    height: typeof data.height === "string" ? data.height : undefined
  };
}

function extractData(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const data = record.data;
  if (!data || typeof data !== "object") return {};
  return data as Record<string, unknown>;
}

function buildCookieHeader(cookies: CsdnCookie[]): string | undefined {
  if (cookies.length === 0) return undefined;
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function extensionFromFilename(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext || undefined;
}

/** Decode URL-encoded names (e.g. Pasted%20image...) and remove characters that
 * are likely to confuse OSS/CSDN file handling. Keeps a safe extension. */
function sanitizeFilename(filename: string): string {
  let decoded = filename;
  try { decoded = decodeURIComponent(filename); } catch { /* keep original */ }
  return decoded
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 200) || "image";
}

function extensionFromMime(mimeType: string): string | undefined {
  switch (mimeType.toLowerCase()) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/svg+xml": return "svg";
    case "image/avif": return "avif";
    default: return undefined;
  }
}

let cachedAgent: ProxyAgent | null = null;
let cachedProxy = "";

function resolveAgent(proxyUrl?: string): ProxyAgent | null {
  const proxy = proxyUrl?.trim() ?? "";
  if (!proxy) return null;
  if (cachedAgent && cachedProxy === proxy) return cachedAgent;
  try {
    new URL(proxy);
    cachedAgent = new ProxyAgent(proxy);
    cachedProxy = proxy;
    return cachedAgent;
  } catch {
    appendCsdnDiagnostics(`CSDN 图片上传代理地址无效，已忽略并直连：${proxy}`);
    cachedAgent = null;
    cachedProxy = proxy;
    return null;
  }
}

async function csdnFetch(input: string, init: RequestInit, proxyUrl?: string): Promise<Response> {
  const agent = resolveAgent(proxyUrl);
  if (agent) {
    return undiciFetch(input, { ...init, dispatcher: agent } as Parameters<typeof undiciFetch>[1]);
  }
  return fetch(input, init);
}

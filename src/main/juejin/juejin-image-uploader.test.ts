import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSigV4Authorization,
  crc32,
  JuejinImageUploader,
  JuejinImageUploadError
} from "./juejin-image-uploader";

/** 构造一个返回 JSON 的 mock Response。 */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** 构造完整的 ImageX 5 步流程 mock，返回 fetcher 与各步骤调用记录。 */
function setupImagexMocks(overrides: {
  stsErrNo?: number;
  applyFail?: boolean;
  commitSuccessCount?: number;
  urlErrNo?: number;
  urlMainUrl?: string;
} = {}) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);

    if (url.includes("/imagex/gen_token")) {
      if (overrides.stsErrNo !== undefined && overrides.stsErrNo !== 0) {
        return jsonResponse({ err_no: overrides.stsErrNo, err_msg: "invalid cookie" });
      }
      return jsonResponse({
        err_no: 0,
        data: {
          token: {
            AccessKeyId: "AKID-test",
            SecretAccessKey: "SK-test-secret",
            SessionToken: "TOKEN-test-session"
          }
        }
      });
    }

    if (url.includes("Action=ApplyImageUpload")) {
      if (overrides.applyFail) return jsonResponse({}, false, 400);
      return jsonResponse({
        Result: {
          UploadAddress: {
            UploadHosts: ["upload-host-1.example.com"],
            StoreInfos: [{ StoreUri: "tos-cn-i-test/2026/08/22/img-abc.png", Auth: "store-auth-token" }],
            SessionKey: "session-key-123"
          }
        }
      });
    }

    if (url.startsWith("https://upload-host-1.example.com/")) {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: "store-auth-token",
        "Content-Type": "application/octet-stream"
      });
      return new Response(null, { status: 200 });
    }

    if (url.includes("Action=CommitImageUpload")) {
      return jsonResponse({
        Result: { Results: [{ Uri: "tos-cn-i-test/2026/08/22/img-abc.png", UriStatus: overrides.commitSuccessCount === 0 ? 0 : 2000 }] }
      });
    }

    if (url.includes("/imagex/get_img_url")) {
      if (overrides.urlErrNo !== undefined && overrides.urlErrNo !== 0) {
        return jsonResponse({ err_no: overrides.urlErrNo, err_msg: "uri not found" });
      }
      return jsonResponse({
        err_no: 0,
        data: { main_url: overrides.urlMainUrl ?? "https://p1-juejin.byteimg.com/tos-cn-i-test/img-abc.png~tplv-k3u1fbpfcp-watermark.image" }
      });
    }

    return jsonResponse({ err_no: 0 });
  });

  return { fetcher, calls };
}

describe("crc32", () => {
  it("computes the CRC32 checksum for known bytes (poly 0xEDB88320)", () => {
    // CRC32("123456789") = 0xCBF43926（标准校验值）
    expect(crc32(Buffer.from("123456789", "ascii"))).toBe("cbf43926");
    expect(crc32(Buffer.from(""))).toBe("0");
  });
});

describe("buildSigV4Authorization", () => {
  it("produces an AWS4-HMAC-SHA256 authorization header", () => {
    const { authorization, amzDate } = buildSigV4Authorization({
      method: "GET",
      host: "imagex.bytedanceapi.com",
      path: "/",
      query: { Action: "ApplyImageUpload", Version: "2018-08-01", ServiceId: "k3u1fbpfcp" },
      headers: {},
      body: "",
      accessKeyId: "AKID-test",
      secretAccessKey: "SK-test-secret",
      sessionToken: "TOKEN-test-session",
      date: "20260822"
    });

    expect(amzDate).toBe("20260822T000000Z");
    expect(authorization).toContain("AWS4-HMAC-SHA256");
    expect(authorization).toContain("Credential=AKID-test/20260822/cn-north-1/imagex/aws4_request");
    expect(authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token");
    expect(authorization).toMatch(/Signature=[0-9a-f]{64}/);
  });
});

describe("JuejinImageUploader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads an image through the full 5-step flow and returns the CDN URL", async () => {
    const { fetcher, calls } = setupImagexMocks();
    const uploader = new JuejinImageUploader({ cookie: "sessionid=abc", fetcher });

    const result = await uploader.uploadImage(Buffer.from("fake-png-bytes", "utf8"));

    expect(result.url).toContain("https://p1-juejin.byteimg.com/");
    expect(result.storeUri).toBe("tos-cn-i-test/2026/08/22/img-abc.png");

    // 5 步：gen_token -> Apply -> 直传 -> Commit -> get_img_url
    expect(calls[0]).toContain("/imagex/gen_token?client=web");
    expect(calls[1]).toContain("Action=ApplyImageUpload");
    expect(calls[2]).toContain("upload-host-1.example.com");
    expect(calls[3]).toContain("Action=CommitImageUpload");
    expect(calls[4]).toContain("/imagex/get_img_url");
    expect(calls).toHaveLength(5);
  });

  it("falls back to /imagex/v2/gen_token when the first endpoint fails", async () => {
    let genTokenCalls = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("gen_token?client=web") || url.includes("imagex/v2/gen_token")) {
        genTokenCalls++;
        if (genTokenCalls === 1) return jsonResponse({ err_no: 40001, err_msg: "bad cookie" });
        return jsonResponse({
          err_no: 0,
          data: { token: { AccessKeyId: "AKID-test", SecretAccessKey: "SK", SessionToken: "TOKEN" } }
        });
      }
      if (url.includes("Action=ApplyImageUpload")) {
        return jsonResponse({ Result: { UploadAddress: { UploadHosts: ["h1"], StoreInfos: [{ StoreUri: "u1", Auth: "a1" }], SessionKey: "s1" } } });
      }
      if (url.startsWith("https://h1/")) return new Response(null, { status: 200 });
      if (url.includes("Action=CommitImageUpload")) {
        return jsonResponse({ Result: { Results: [{ Uri: "u1", UriStatus: 2000 }] } });
      }
      if (url.includes("/imagex/get_img_url")) {
        return jsonResponse({ err_no: 0, data: { main_url: "https://cdn.example.com/u1" } });
      }
      return jsonResponse({ err_no: 0 });
    });

    const uploader = new JuejinImageUploader({ cookie: "sessionid=abc", fetcher });
    const result = await uploader.uploadImage(Buffer.from("x"));

    expect(genTokenCalls).toBe(2);
    expect(result.url).toBe("https://cdn.example.com/u1");
  });

  it("throws a clear error when STS credentials cannot be obtained", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ err_no: 40001, err_msg: "invalid" }));
    const uploader = new JuejinImageUploader({ cookie: "sessionid=bad", fetcher });

    await expect(uploader.uploadImage(Buffer.from("x"))).rejects.toThrow(JuejinImageUploadError);
    await expect(uploader.uploadImage(Buffer.from("x"))).rejects.toThrow(/STS 凭证失败|gen_token/);
  });

  it("throws a clear error when ApplyImageUpload returns an error status", async () => {
    const { fetcher } = setupImagexMocks({ applyFail: true });
    const uploader = new JuejinImageUploader({ cookie: "sessionid=abc", fetcher });

    await expect(uploader.uploadImage(Buffer.from("x"))).rejects.toThrow(/ApplyImageUpload 失败/);
  });

  it("throws a clear error when CommitImageUpload reports zero success count", async () => {
    const { fetcher } = setupImagexMocks({ commitSuccessCount: 0 });
    const uploader = new JuejinImageUploader({ cookie: "sessionid=abc", fetcher });

    await expect(uploader.uploadImage(Buffer.from("x"))).rejects.toThrow(/成功数为 0/);
  });

  it("throws a clear error when get_img_url reports a business error", async () => {
    const { fetcher } = setupImagexMocks({ urlErrNo: 50001 });
    const uploader = new JuejinImageUploader({ cookie: "sessionid=abc", fetcher });

    await expect(uploader.uploadImage(Buffer.from("x"))).rejects.toThrow(/uri not found/);
  });

  it("throws a clear error when get_img_url lacks main_url", async () => {
    const { fetcher } = setupImagexMocks({ urlMainUrl: "" });
    const uploader = new JuejinImageUploader({ cookie: "sessionid=abc", fetcher });

    await expect(uploader.uploadImage(Buffer.from("x"))).rejects.toThrow(/缺少 main_url/);
  });
});

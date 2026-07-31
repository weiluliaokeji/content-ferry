import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadImageToCsdn } from "./csdn-image-uploader";

describe("uploadImageToCsdn", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("requests a token and uploads to OSS, returning the CSDN image URL", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("imgservice.csdn.net/direct/v1.0/image/upload")) {
        return new Response(JSON.stringify({
          code: 200,
          data: {
            accessId: "AK",
            callbackUrl: "callback-base64",
            dir: "direct",
            expire: "9999999999",
            filePath: "direct/test-key.png",
            host: "https://csdn-img-blog.oss-cn-beijing.aliyuncs.com",
            policy: "policy-base64",
            signature: "sig"
          },
          msg: "success"
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("aliyuncs.com")) {
        return new Response(JSON.stringify({
          code: 200,
          data: {
            imageUrl: "https://img-blog.csdnimg.cn/direct/abc123.png",
            width: "640",
            height: "480"
          },
          msg: "success"
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await uploadImageToCsdn({
      buffer: Buffer.from("fake-image"),
      filename: "diagram.png",
      mimeType: "image/png",
      cookies: [{ name: "session", value: "abc" }]
    });

    expect(result.url).toBe("https://img-blog.csdnimg.cn/direct/abc123.png");
    expect(result.width).toBe("640");
    expect(result.height).toBe("480");
  });

  it("throws when the token endpoint returns an error", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("imgservice.csdn.net")) {
        return new Response(JSON.stringify({ code: 500, msg: "fail" }), { status: 500, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(uploadImageToCsdn({
      buffer: Buffer.from("fake-image"),
      filename: "diagram.png",
      mimeType: "image/png",
      cookies: [{ name: "session", value: "abc" }]
    })).rejects.toThrow("获取 CSDN 图片上传凭证失败");
  });

  it("throws when the token response is missing required fields", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("imgservice.csdn.net")) {
        return new Response(JSON.stringify({ code: 200, data: { accessId: "AK" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(uploadImageToCsdn({
      buffer: Buffer.from("fake-image"),
      filename: "diagram.png",
      mimeType: "image/png",
      cookies: [{ name: "session", value: "abc" }]
    })).rejects.toThrow("CSDN 上传凭证缺少字段");
  });

  it("throws when OSS returns a non-200 response even with a body", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = input.toString();
      if (url.includes("imgservice.csdn.net")) {
        return new Response(JSON.stringify({
          code: 200,
          data: {
            accessId: "AK",
            callbackUrl: "callback-base64",
            dir: "direct",
            expire: "9999999999",
            filePath: "direct/test-key.png",
            host: "https://csdn-img-blog.oss-cn-beijing.aliyuncs.com",
            policy: "policy-base64",
            signature: "sig"
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("aliyuncs.com")) {
        return new Response(JSON.stringify({ code: 400, msg: "callback failed" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(uploadImageToCsdn({
      buffer: Buffer.from("fake-image"),
      filename: "diagram.png",
      mimeType: "image/png",
      cookies: [{ name: "session", value: "abc" }]
    })).rejects.toThrow("上传图片到 CSDN OSS 失败（HTTP 400）");
  });
});

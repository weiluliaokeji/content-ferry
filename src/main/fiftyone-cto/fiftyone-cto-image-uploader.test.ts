import { describe, expect, it } from "vitest";
import type { ContentSourceService } from "../content/content-source-service";
import { FiftyoneCtoImageUploader } from "./fiftyone-cto-image-uploader";
import { uploadFiftyoneCtoLocalImages } from "./fiftyone-cto-image-inliner";

const SIGN_URL = "https://blog.51cto.com/getUploadSign";
const CONFIG_URL = "https://blog.51cto.com/getUploadConfig";
const COS_URL = "https://51cto-edu-image-1253198479.cos.ap-beijing.myqcloud.com";

function makeFetcher(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function makeSignResponse(cdnBase = "https://s2.51cto.com/") {
  return okJson({ code: 0, msg: "success", data: { url: cdnBase, sign: "sign-value" } });
}

function makeConfigResponse(key = "images/blog/front/202608/fake.png") {
  return okJson({
    code: 0,
    msg: "success",
    data: {
      url: COS_URL,
      fields: {
        key,
        policy: "policy-value",
        "x-amz-algorithm": "AWS4-HMAC-SHA256",
        "x-amz-signature": "sig-value",
        "x-amz-credential": "AKID/20260830/ap-beijing/s3/aws4_request",
        "X-Amz-Date": "20260830T134341Z"
      }
    }
  });
}

function cosOkResponse(): Response {
  return new Response(null, { status: 204, headers: { Location: `${COS_URL}/${"images/blog/front/202608/fake.png"}` } });
}

describe("FiftyoneCtoImageUploader", () => {
  it("returns CDN base + key after sign -> config -> cos multipart post", async () => {
    const fetcher = makeFetcher((url) => {
      if (url === SIGN_URL) return makeSignResponse("https://s2.51cto.com/");
      if (url === CONFIG_URL) return makeConfigResponse("images/blog/front/202608/abc.png");
      if (url === COS_URL) return cosOkResponse();
      return new Response("unexpected", { status: 500 });
    });

    const uploader = new FiftyoneCtoImageUploader("cookie=1", fetcher);
    const url = await uploader.upload(Buffer.from("abc"), "image/png", "abc.png");
    expect(url).toBe("https://s2.51cto.com/images/blog/front/202608/abc.png");
  });

  it("adds a trailing slash to CDN base when missing", async () => {
    const fetcher = makeFetcher((url) => {
      if (url === SIGN_URL) return makeSignResponse("https://s2.51cto.com");
      if (url === CONFIG_URL) return makeConfigResponse("images/x.png");
      if (url === COS_URL) return cosOkResponse();
      return new Response("unexpected", { status: 500 });
    });

    const url = await new FiftyoneCtoImageUploader("c", fetcher).upload(Buffer.from("a"), "image/png", "x.png");
    expect(url).toBe("https://s2.51cto.com/images/x.png");
  });

  it("throws when cookie is missing", async () => {
    await expect(new FiftyoneCtoImageUploader("").upload(Buffer.from("a"), "image/png", "x.png")).rejects.toThrow(/Cookie/);
  });

  it("throws when getUploadSign fails", async () => {
    const fetcher = makeFetcher((url) => {
      if (url === SIGN_URL) return new Response("login", { status: 302 });
      return new Response("unexpected", { status: 500 });
    });
    await expect(new FiftyoneCtoImageUploader("c", fetcher).upload(Buffer.from("a"), "image/png", "x.png"))
      .rejects.toThrow(/签名失败/);
  });

  it("throws when getUploadSign returns non-zero code", async () => {
    const fetcher = makeFetcher((url) => {
      if (url === SIGN_URL) return okJson({ code: 1, msg: "登录态失效" });
      return new Response("unexpected", { status: 500 });
    });
    await expect(new FiftyoneCtoImageUploader("c", fetcher).upload(Buffer.from("a"), "image/png", "x.png"))
      .rejects.toThrow(/登录态失效/);
  });

  it("throws when getUploadConfig returns missing fields", async () => {
    const fetcher = makeFetcher((url) => {
      if (url === SIGN_URL) return makeSignResponse();
      if (url === CONFIG_URL) {
        return okJson({ code: 0, data: { url: COS_URL, fields: { key: "k" } } });
      }
      return new Response("unexpected", { status: 500 });
    });
    await expect(new FiftyoneCtoImageUploader("c", fetcher).upload(Buffer.from("a"), "image/png", "x.png"))
      .rejects.toThrow(/缺少字段/);
  });

  it("includes send body + url + response in the error when getUploadConfig returns non-zero code", async () => {
    // 真实失败：9/4 用户发布时 5 张图全部 code:10001 "参数错误"。
    // 排查需要直接看到 send body / response，assertion 锁这一行为。
    const fetcher = makeFetcher((url) => {
      if (url === SIGN_URL) return makeSignResponse();
      if (url === CONFIG_URL) {
        // 51CTO 后端的真实返回形态。
        return okJson({ code: 10001, msg: "参数错误", data: {} });
      }
      return new Response("unexpected", { status: 500 });
    });
    let err: Error | undefined;
    try {
      await new FiftyoneCtoImageUploader("c", fetcher).upload(Buffer.from("a"), "image/png", "x.png");
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // send 侧：URL + method + body 三件都得在 error message 里
    expect(err!.message).toContain(CONFIG_URL);
    expect(err!.message).toMatch(/send=POST/);
    expect(err!.message).toContain("upload_type=image");
    expect(err!.message).toContain("upload_sign=sign-value");
    // response 侧：message + code
    expect(err!.message).toContain("参数错误");
    expect(err!.message).toContain("code=10001");
  });

  it("posts multipart form-data to COS with signature fields and file", async () => {
    let cosCall: { url: string; body: unknown } | undefined;
    const fetcher = makeFetcher((url, init) => {
      if (url === SIGN_URL) return makeSignResponse();
      if (url === CONFIG_URL) return makeConfigResponse("images/y.png");
      if (url === COS_URL) {
        cosCall = { url, body: init?.body };
        return cosOkResponse();
      }
      return new Response("unexpected", { status: 500 });
    });

    await new FiftyoneCtoImageUploader("sess=xyz", fetcher).upload(Buffer.from("abc"), "image/png", "y.png");
    expect(cosCall).toBeDefined();
    expect(cosCall!.body).toBeInstanceOf(FormData);
    const form = cosCall!.body as FormData;
    expect(form.get("key")).toBe("images/y.png");
    expect(form.get("x-amz-algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("throws when COS returns non-204/ok", async () => {
    const fetcher = makeFetcher((url) => {
      if (url === SIGN_URL) return makeSignResponse();
      if (url === CONFIG_URL) return makeConfigResponse();
      if (url === COS_URL) return new Response("bad request", { status: 400 });
      return new Response("unexpected", { status: 500 });
    });
    await expect(new FiftyoneCtoImageUploader("c", fetcher).upload(Buffer.from("a"), "image/png", "x.png"))
      .rejects.toThrow(/COS 图片上传失败/);
  });
});

describe("uploadFiftyoneCtoLocalImages", () => {
  function fakeContentSources(map: Record<string, { mimeType: string; bytes: Buffer }>) {
    return {
      readArticleResource: (_ws: string, _rel: string, source: string) => {
        const entry = map[source];
        if (!entry) throw new Error(`找不到资源：${source}`);
        return {
          mimeType: entry.mimeType,
          stream: (async function* () { yield entry.bytes; })()
        };
      }
    } as unknown as ContentSourceService;
  }

  const okUploader = {
    upload: async (_b: Buffer, _m: string, _f: string) => "https://s2.51cto.com/up.png"
  } as unknown as FiftyoneCtoImageUploader;

  const failUploader = {
    upload: async () => { throw new Error("boom"); }
  } as unknown as FiftyoneCtoImageUploader;

  it("uploads local images and leaves remote/data URIs untouched", async () => {
    const sources = fakeContentSources({ "./a.png": { mimeType: "image/png", bytes: Buffer.from("fake") } });
    const md = "![a](./a.png)\n![b](https://x.com/b.png)\n![c](data:image/png;base64,AAA)";
    const result = await uploadFiftyoneCtoLocalImages(md, "ws", "post/index.md", sources, okUploader);

    expect(result.uploadedCount).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(result.markdown).toContain("https://s2.51cto.com/up.png");
    expect(result.markdown).toContain("https://x.com/b.png");
    expect(result.markdown).toContain("data:image/png;base64,AAA");
  });

  it("records failure and does NOT inline when the uploader throws", async () => {
    const sources = fakeContentSources({ "./a.png": { mimeType: "image/png", bytes: Buffer.from("fake") } });
    const result = await uploadFiftyoneCtoLocalImages("![a](./a.png)", "ws", "post/index.md", sources, failUploader);

    expect(result.uploadedCount).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toContain("boom");
    // 不再回退为 base64 内联：保留原始本地引用，交由频道服务整体中止发布。
    expect(result.markdown).not.toMatch(/!\[a\]\(data:image\/png;base64,/);
    expect(result.markdown).toContain("![a](./a.png)");
  });

  it("records failures for missing resources", async () => {
    const sources = fakeContentSources({});
    const result = await uploadFiftyoneCtoLocalImages("![a](./missing.png)", "ws", "post/index.md", sources, okUploader);

    expect(result.uploadedCount).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].source).toBe("./missing.png");
  });

  it("rasterizes SVG to PNG before calling uploader.upload", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="#00f"/></svg>');
    const sources = fakeContentSources({ "./a.svg": { mimeType: "image/svg+xml", bytes: svg } });
    let captured: { mimeType: string; filename: string; bytes: Buffer } | undefined;
    const spyUploader = {
      upload: async (bytes: Buffer, mimeType: string, filename: string) => {
        captured = { mimeType, filename, bytes };
        return "https://s2.51cto.com/up.png";
      }
    } as unknown as FiftyoneCtoImageUploader;

    const result = await uploadFiftyoneCtoLocalImages("![a](./a.svg)", "ws", "post/index.md", sources, spyUploader);

    expect(result.uploadedCount).toBe(1);
    expect(captured).toBeDefined();
    expect(captured!.mimeType).toBe("image/png");
    expect(captured!.filename).toBe("a.png");
    expect(captured!.bytes.toString("binary", 1, 4)).toBe("PNG");
  }, 15_000);

  it("does not inline SVG as base64 when the upload fails (records failure instead)", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="#0f0"/></svg>');
    const sources = fakeContentSources({ "./a.svg": { mimeType: "image/svg+xml", bytes: svg } });

    const result = await uploadFiftyoneCtoLocalImages("![a](./a.svg)", "ws", "post/index.md", sources, failUploader);

    expect(result.uploadedCount).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].source).toBe("./a.svg");
    expect(result.failed[0].reason).toMatch(/boom/);
    // 失败时绝不回退成 base64 内联——内联后的文章对 51CTO 不可用（data URI 超长、可能被截断）。
    expect(result.markdown).not.toContain("data:image/");
    expect(result.markdown).toContain("./a.svg");
  }, 15_000);
});

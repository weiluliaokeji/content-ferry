import { describe, expect, it } from "vitest";
import type { ContentSourceService } from "../content/content-source-service";
import { FiftyoneCtoImageUploader, FIFTYONE_CTO_IMAGE_UPLOAD_URL } from "./fiftyone-cto-image-uploader";
import { uploadFiftyoneCtoLocalImages } from "./fiftyone-cto-image-inliner";

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

describe("FiftyoneCtoImageUploader", () => {
  it("uploads and returns the url from response.url", async () => {
    const fetcher = makeFetcher(() => okJson({ url: "https://img.51cto.com/x.png" }));
    const uploader = new FiftyoneCtoImageUploader("cookie=1", fetcher);
    const url = await uploader.upload(Buffer.from("abc"), "image/png", "x.png");
    expect(url).toBe("https://img.51cto.com/x.png");
  });

  it("parses the data.url variant", async () => {
    const fetcher = makeFetcher(() => okJson({ data: { url: "https://img.51cto.com/y.png" } }));
    const uploader = new FiftyoneCtoImageUploader("cookie=1", fetcher);
    const url = await uploader.upload(Buffer.from("abc"), "image/png", "y.png");
    expect(url).toBe("https://img.51cto.com/y.png");
  });

  it("parses the src / data.src variants", async () => {
    const fetcherSrc = makeFetcher(() => okJson({ src: "https://img.51cto.com/s.png" }));
    expect(await new FiftyoneCtoImageUploader("c", fetcherSrc).upload(Buffer.from("a"), "image/png", "s.png"))
      .toBe("https://img.51cto.com/s.png");

    const fetcherDataSrc = makeFetcher(() => okJson({ data: { src: "https://img.51cto.com/ds.png" } }));
    expect(await new FiftyoneCtoImageUploader("c", fetcherDataSrc).upload(Buffer.from("a"), "image/png", "ds.png"))
      .toBe("https://img.51cto.com/ds.png");
  });

  it("throws on a non-ok response", async () => {
    const fetcher = makeFetcher(() => new Response("forbidden", { status: 403 }));
    const uploader = new FiftyoneCtoImageUploader("cookie=1", fetcher);
    await expect(uploader.upload(Buffer.from("a"), "image/png", "z.png")).rejects.toThrow(/HTTP 403/);
  });

  it("throws when the response has no url", async () => {
    const fetcher = makeFetcher(() => okJson({ code: 0, msg: "fail" }));
    const uploader = new FiftyoneCtoImageUploader("cookie=1", fetcher);
    await expect(uploader.upload(Buffer.from("a"), "image/png", "z.png")).rejects.toThrow(/缺少图片 URL/);
  });

  it("posts multipart form-data with the cookie header", async () => {
    let captured: { url: string; cookie?: string; body?: unknown } = { url: "" };
    const fetcher = makeFetcher((url, init) => {
      captured = { url, cookie: (init?.headers as Record<string, string>)?.Cookie, body: init?.body };
      return okJson({ url: "https://img.51cto.com/up.png" });
    });
    await new FiftyoneCtoImageUploader("sess=xyz", fetcher).upload(Buffer.from("abc"), "image/png", "x.png");
    expect(captured.url).toBe(FIFTYONE_CTO_IMAGE_UPLOAD_URL);
    expect(captured.cookie).toBe("sess=xyz");
    expect(captured.body).toBeInstanceOf(FormData);
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
    upload: async (_b: Buffer, _m: string, _f: string) => "https://img.51cto.com/up.png"
  } as unknown as FiftyoneCtoImageUploader;

  const failUploader = {
    upload: async () => { throw new Error("boom"); }
  } as unknown as FiftyoneCtoImageUploader;

  it("uploads local images and leaves remote/data URIs untouched", async () => {
    const sources = fakeContentSources({ "./a.png": { mimeType: "image/png", bytes: Buffer.from("fake") } });
    const md = "![a](./a.png)\n![b](https://x.com/b.png)\n![c](data:image/png;base64,AAA)";
    const result = await uploadFiftyoneCtoLocalImages(md, "ws", "post/index.md", sources, okUploader);

    expect(result.uploadedCount).toBe(1);
    expect(result.inlinedCount).toBe(0);
    expect(result.markdown).toContain("https://img.51cto.com/up.png");
    expect(result.markdown).toContain("https://x.com/b.png");
    expect(result.markdown).toContain("data:image/png;base64,AAA");
  });

  it("falls back to base64 inlining when the uploader throws", async () => {
    const sources = fakeContentSources({ "./a.png": { mimeType: "image/png", bytes: Buffer.from("fake") } });
    const result = await uploadFiftyoneCtoLocalImages("![a](./a.png)", "ws", "post/index.md", sources, failUploader);

    expect(result.uploadedCount).toBe(0);
    expect(result.inlinedCount).toBe(1);
    expect(result.markdown).toMatch(/!\[a\]\(data:image\/png;base64,/);
  });

  it("records failures for missing resources", async () => {
    const sources = fakeContentSources({});
    const result = await uploadFiftyoneCtoLocalImages("![a](./missing.png)", "ws", "post/index.md", sources, okUploader);

    expect(result.uploadedCount).toBe(0);
    expect(result.inlinedCount).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].source).toBe("./missing.png");
  });
});

import { describe, it, expect } from "vitest";
import { extractCsdnUploadUrl } from "./csdn-upload-url";

// Real shape captured from CSDN's editor page (see diagnostics log):
// res[0] is an axios response whose `.data` is CSDN's own payload, whose
// `.data` holds { hostname, imageUrl, targetObjectKey }.
const REAL_AXIOS_WRAPPED = [
  {
    data: {
      code: 200,
      data: {
        hostname: "https://i-blog.csdnimg.cn/",
        imageUrl: "https://i-blog.csdnimg.cn/direct/b33d1ee4df4d455a8208d0c49298f89d.png",
        width: "760",
        targetObjectKey: "direct/b33d1ee4df4d455a8208d0c49298f89d.png",
        "x-image-suffix": "png",
        height: "653"
      },
      msg: "success"
    },
    status: 200,
    statusText: "OK",
    headers: {},
    config: {},
    request: {}
  }
];

describe("extractCsdnUploadUrl", () => {
  it("extracts URL from axios-wrapped CSDN payload (real diagnostic shape)", () => {
    expect(extractCsdnUploadUrl(REAL_AXIOS_WRAPPED)).toBe(
      "https://i-blog.csdnimg.cn/direct/b33d1ee4df4d455a8208d0c49298f89d.png"
    );
  });

  it("falls back to hostname + targetObjectKey when imageUrl is absent", () => {
    const res = [
      {
        data: {
          code: 200,
          data: {
            hostname: "https://i-blog.csdnimg.cn/",
            targetObjectKey: "direct/abc123.png"
          },
          msg: "success"
        }
      }
    ];
    expect(extractCsdnUploadUrl(res)).toBe("https://i-blog.csdnimg.cn/direct/abc123.png");
  });

  it("handles a bare array of plain url strings", () => {
    expect(extractCsdnUploadUrl(["https://img.example.com/a.png"])).toBe(
      "https://img.example.com/a.png"
    );
  });

  it("handles a single payload object (no array, no axios wrapper)", () => {
    const res = {
      code: 200,
      data: {
        hostname: "https://i-blog.csdnimg.cn/",
        imageUrl: "https://i-blog.csdnimg.cn/direct/zzz.png"
      },
      msg: "success"
    };
    expect(extractCsdnUploadUrl(res)).toBe("https://i-blog.csdnimg.cn/direct/zzz.png");
  });

  it("prefers imageUrl over url field when both present", () => {
    const res = { imageUrl: "https://a.com/1.png", url: "https://a.com/2.png" };
    expect(extractCsdnUploadUrl(res)).toBe("https://a.com/1.png");
  });

  it("returns null when no http url is present", () => {
    expect(extractCsdnUploadUrl({ code: 500, data: { msg: "fail" } })).toBeNull();
    expect(extractCsdnUploadUrl(null)).toBeNull();
    expect(extractCsdnUploadUrl({})).toBeNull();
  });
});

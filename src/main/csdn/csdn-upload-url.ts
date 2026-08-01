/**
 * Extract the final image URL from CSDN's in-page upload response.
 *
 * `window.csdn.upload.uploadImg` returns the result wrapped by axios and
 * nested by CSDN's own payload shape, e.g.:
 *
 *   [ {                       // array (one entry per file)
 *       data: {               // axios `data` = CSDN payload
 *         code: 200,
 *         data: {             // CSDN inner payload
 *           hostname: "https://i-blog.csdnimg.cn/",
 *           imageUrl: "https://i-blog.csdnimg.cn/direct/xxxx.png",
 *           targetObjectKey: "direct/xxxx.png",
 *           width, height, x-image-suffix
 *         },
 *         msg: "success"
 *       },
 *       status: 200, statusText: "OK", headers, config, request
 *     } ]
 *
 * This helper walks the structure recursively so it tolerates either the
 * axios wrapper, the CSDN payload, or a bare URL being present. It is
 * intentionally pure (no browser/Node globals) so it can be both injected
 * into the page-context upload script and unit-tested in Node.
 */
export function extractCsdnUploadUrl(response: unknown): string | null {
  function firstHttpUrl(v: unknown): string | null {
    if (typeof v === "string") return v.startsWith("http") ? v : null;
    if (v && typeof v === "object") {
      if (Array.isArray(v)) {
        for (const item of v) {
          const u = firstHttpUrl(item);
          if (u) return u;
        }
      } else {
        const obj = v as Record<string, unknown>;
        const cand =
          (typeof obj.imageUrl === "string" ? obj.imageUrl : null) ||
          (typeof obj.url === "string" ? obj.url : null) ||
          (typeof obj.hostname === "string" && typeof obj.targetObjectKey === "string"
            ? obj.hostname + obj.targetObjectKey
            : null) ||
          (obj.data ? firstHttpUrl(obj.data) : null);
        return cand;
      }
    }
    return null;
  }
  return firstHttpUrl(response);
}

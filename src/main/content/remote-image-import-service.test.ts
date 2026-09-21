import { describe, expect, it } from "vitest";
import { isAllowedRemoteImageHost } from "./remote-image-import-service";

describe("remote image host validation", () => {
  it("allows synthetic egress DNS answers for a hostname", () => {
    expect(isAllowedRemoteImageHost("i-blog.csdnimg.cn", [{ address: "198.18.0.27" }])).toBe(true);
  });

  it("still rejects a literal synthetic-range IP", () => {
    expect(isAllowedRemoteImageHost("198.18.0.27", [{ address: "198.18.0.27" }])).toBe(false);
  });

  it("rejects mixed public and private DNS answers", () => {
    expect(isAllowedRemoteImageHost("example.com", [{ address: "198.18.0.27" }, { address: "192.168.1.20" }])).toBe(false);
  });
});

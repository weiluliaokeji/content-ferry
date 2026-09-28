import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readBuildInfo } from "./build-info";

describe("readBuildInfo", () => {
  it("reads the packaged build stamp and ignores a stale stamp from another version", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-build-info-"));
    try {
      fs.mkdirSync(path.join(root, "dist"));
      fs.writeFileSync(path.join(root, "dist", "build-info.json"), JSON.stringify({ version: "0.2.3", buildId: "0.2.3-20260927T123456Z", builtAt: "2026-09-27T12:34:56.000Z" }));
      expect(readBuildInfo(root, "0.2.3").buildId).toBe("0.2.3-20260927T123456Z");
      expect(readBuildInfo(root, "0.2.4").buildId).toBe("0.2.4-development");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

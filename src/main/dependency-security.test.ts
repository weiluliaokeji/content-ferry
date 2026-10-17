import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type LockedPackage = { version?: string };
type Lockfile = { packages: Record<string, LockedPackage> };

const lockfile = JSON.parse(readFileSync(resolve(process.cwd(), "package-lock.json"), "utf8")) as Lockfile;

function versionParts(version: string): number[] {
  return version.split("-")[0].split(".").map(Number);
}

function isOlderThan(version: string, safeVersion: string): boolean {
  const actual = versionParts(version);
  const safe = versionParts(safeVersion);
  return safe.some((part, index) => {
    if (actual[index] === part) return false;
    return actual[index] < part && safe.slice(0, index).every((earlier, earlierIndex) => actual[earlierIndex] === earlier);
  });
}

describe("known vulnerable production dependency versions", () => {
  it("recognizes the previously locked vulnerable versions", () => {
    expect(isOlderThan("1.42.1", "1.42.3")).toBe(true);
    expect(isOlderThan("1.42.3", "1.42.3")).toBe(false);
    expect(isOlderThan("1.43.0", "1.42.3")).toBe(false);
  });

  it.each([
    ["fastify", "5.12.5"],
    ["find-my-way", "9.7.0"],
    ["prosemirror-view", "1.42.3"],
    ["nanoid", "3.3.18"],
    ["postcss", "8.5.23"],
    ["source-map-js", "1.2.2"],
    ["dompurify", "3.4.16"],
    ["vue", "3.5.42"]
  ])("keeps every locked %s copy at or above %s", (name, safeVersion) => {
    let matched = 0;
    for (const [location, entry] of Object.entries(lockfile.packages)) {
      if (location !== `node_modules/${name}` && !location.endsWith(`/node_modules/${name}`)) continue;
      matched += 1;
      expect(entry.version, location).toBeDefined();
      expect(isOlderThan(entry.version!, safeVersion), `${location}@${entry.version}`).toBe(false);
    }
    expect(matched, `No locked copy of ${name}`).toBeGreaterThan(0);
  });

  it("keeps both fast-uri major lines patched", () => {
    let matched = 0;
    for (const [location, entry] of Object.entries(lockfile.packages)) {
      if (location !== "node_modules/fast-uri" && !location.endsWith("/node_modules/fast-uri")) continue;
      matched += 1;
      const version = entry.version ?? "";
      const safeVersion = version.startsWith("3.") ? "3.1.8" : "4.1.5";
      expect(isOlderThan(version, safeVersion), `${location}@${version}`).toBe(false);
    }
    expect(matched, "No locked copy of fast-uri").toBeGreaterThan(0);
  });

  it("keeps the shipped Undici 8 release patched", () => {
    const version = lockfile.packages["node_modules/undici"]?.version;
    expect(version).toBeDefined();
    expect(isOlderThan(version!, "8.10.2")).toBe(false);
  });
});

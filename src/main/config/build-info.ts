import fs from "node:fs";
import path from "node:path";

export interface BuildInfo {
  version: string;
  buildId: string;
  builtAt: string;
}

export function readBuildInfo(appPath: string, version: string): BuildInfo {
  const fallback: BuildInfo = { version, buildId: `${version}-development`, builtAt: "" };
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(appPath, "dist", "build-info.json"), "utf8"));
    if (typeof value !== "object" || value === null) return fallback;
    const record = value as Record<string, unknown>;
    if (record.version !== version || typeof record.buildId !== "string" || !/^\d+\.\d+\.\d+-\d{8}T\d{6}Z$/u.test(record.buildId) || typeof record.builtAt !== "string") return fallback;
    return { version, buildId: record.buildId, builtAt: record.builtAt };
  } catch {
    return fallback;
  }
}

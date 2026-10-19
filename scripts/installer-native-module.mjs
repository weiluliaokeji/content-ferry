import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAbi } from "node-abi";

export function findBetterSqliteBinary(projectRoot, electronVersion, platform, arch) {
  const abi = getAbi(electronVersion, "electron");
  const targetOs = { win32: "win", darwin: "mac", linux: "linux" }[platform];
  if (!abi || !targetOs) return null;

  const moduleDir = path.join(projectRoot, "node_modules", "better-sqlite3", "build");
  const candidate = path.join(moduleDir, "Release", "better_sqlite3.node");
  const configPath = path.join(moduleDir, "config.gypi");
  if (!existsSync(candidate) || !existsSync(configPath)) return null;

  try {
    const config = readFileSync(configPath, "utf8");
    const readValue = (name) => {
      const match = config.match(new RegExp(`^\\s*"${name}"\\s*:\\s*("[^"\\r\\n]*"|\\d+)\\s*,?\\s*$`, "m"));
      return match ? JSON.parse(match[1]) : undefined;
    };
    if (
      readValue("runtime") !== "electron" ||
      readValue("built_with_electron") !== 1 ||
      readValue("node_module_version") !== Number(abi) ||
      readValue("target_arch") !== arch
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return candidate;
}

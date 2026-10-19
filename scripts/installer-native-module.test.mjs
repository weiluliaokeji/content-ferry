import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findBetterSqliteBinary } from "./installer-native-module.mjs";

test("installer check rejects a better-sqlite3 binary built for an older Electron ABI", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "contentferry-installer-abi-"));
  const moduleBuildDir = path.join(root, "node_modules", "better-sqlite3", "build");
  const binary = path.join(moduleBuildDir, "Release", "better_sqlite3.node");
  const config = path.join(moduleBuildDir, "config.gypi");

  try {
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, "native module placeholder");
    writeFileSync(
      config,
      'variables = {\n  "runtime": "electron",\n  "built_with_electron": 1,\n  "node_module_version": 136,\n  "target_arch": "x64"\n}\n'
    );
    assert.equal(findBetterSqliteBinary(root, "44.9.0", "win32", "x64"), null);

    writeFileSync(
      config,
      'variables = {\n  "runtime": "electron",\n  "built_with_electron": 1,\n  "node_module_version": 149,\n  "target_arch": "x64"\n}\n'
    );
    assert.equal(findBetterSqliteBinary(root, "44.9.0", "win32", "x64"), binary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

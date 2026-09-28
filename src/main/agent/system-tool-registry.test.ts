import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findInstalledCommandCandidates, findPortableCommandCandidates, findPowerShellScriptCandidates, SystemToolRegistry } from "./system-tool-registry";

describe("SystemToolRegistry", () => {
  it("finds PowerShell script shims in PATH when where.exe omits .ps1 files", () => {
    const existing = new Set(["D:\\Tools\\Scoop\\shims\\scoop.ps1"]);

    expect(findPowerShellScriptCandidates("scoop", "C:\\Windows\\System32;D:\\Tools\\Scoop\\shims", (candidate) => existing.has(candidate)))
      .toEqual(["D:\\Tools\\Scoop\\shims\\scoop.ps1"]);
  });

  it("prefers an installed command launcher over a PowerShell shim when resolving a CLI", async () => {
    const registry = new SystemToolRegistry(
      async (command) => command === "scoop"
        ? ["C:\\Scoop\\shims\\scoop.cmd", "C:\\Scoop\\shims\\scoop.ps1"]
        : []
    );

    const scoop = await registry.resolveCommand("scoop");

    expect(scoop).toEqual({
      id: "cli:scoop",
      command: "scoop",
      path: "C:\\Scoop\\shims\\scoop.cmd",
      version: "按需读取实际运行结果",
      capabilities: ["task_cli"]
    });
  });

  it("dynamically lists arbitrary commands from PATH and filters by command name without running them", async () => {
    const commandDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-command-inventory-"));
    try {
      fs.writeFileSync(path.join(commandDirectory, "scoop.cmd"), "@echo off");
      fs.writeFileSync(path.join(commandDirectory, "other-tool.exe"), "not executed");
      const registry = new SystemToolRegistry(async () => [], undefined, { PATH: commandDirectory });

      await expect(registry.list("scoop")).resolves.toEqual([{
        id: "cli:scoop",
        command: "scoop",
        path: path.join(commandDirectory, "scoop.cmd"),
        version: "未探测（发现阶段不会运行工具）",
        capabilities: ["task_cli"]
      }]);
    } finally {
      fs.rmSync(commandDirectory, { recursive: true, force: true });
    }
  });

  it("discovers arbitrary commands in a Portable installation's adjacent tool folders", async () => {
    const toolsHome = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-portable-inventory-"));
    try {
      const commandDirectory = path.join(toolsHome, "PackageManager", "shims");
      fs.mkdirSync(commandDirectory, { recursive: true });
      fs.writeFileSync(path.join(commandDirectory, "custom-manager.cmd"), "@echo off");

      await expect(findInstalledCommandCandidates({
        PATH: "",
        PORTABLE_EXECUTABLE_FILE: path.join(toolsHome, "ContentFerry", "文渡-Portable.exe")
      })).resolves.toContainEqual({
        command: "custom-manager",
        path: path.join(commandDirectory, "custom-manager.cmd")
      });
    } finally {
      fs.rmSync(toolsHome, { recursive: true, force: true });
    }
  });

  it("enumerates commands from a user-configured directory without a product-specific entry", async () => {
    const directories: Record<string, string[]> = {
      "D:\\Tools\\Scoop\\shims": ["scoop.cmd", "scoop.ps1", "unrelated.exe"]
    };
    const entries = findInstalledCommandCandidates(
      { PATH: "D:\\Tools\\Scoop\\shims" },
      async (directory) => directories[directory] ?? [],
      () => true
    );
    await expect(entries).resolves.toEqual([
      { command: "scoop", path: "D:\\Tools\\Scoop\\shims\\scoop.cmd" },
      { command: "unrelated", path: "D:\\Tools\\Scoop\\shims\\unrelated.exe" }
    ]);
  });

  it("discovers a command next to a portable app when Explorer PATH lacks it", async () => {
    const toolsHome = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-tools-home-"));
    try {
      const shimDirectory = path.join(toolsHome, "PackageManager", "shims");
      fs.mkdirSync(shimDirectory, { recursive: true });
      fs.writeFileSync(path.join(shimDirectory, "packagemgr.cmd"), "@echo off");
      const registry = new SystemToolRegistry(
        async () => { throw new Error("where.exe found no matching files"); },
        undefined,
        { PATH: "C:\\Windows\\System32", PORTABLE_EXECUTABLE_FILE: path.join(toolsHome, "ContentFerry", "文渡-Portable.exe") }
      );

      await expect(registry.resolveCommand("packagemgr")).resolves.toMatchObject({ path: path.join(shimDirectory, "packagemgr.cmd") });
    } finally {
      fs.rmSync(toolsHome, { recursive: true, force: true });
    }
  });

  it("finds any named launcher in a portable app's sibling tools", () => {
    const launcher = path.resolve("D:\\Tools\\PackageManager\\shims\\packagemgr.cmd");
    expect(findPortableCommandCandidates("packagemgr", { PORTABLE_EXECUTABLE_FILE: "D:\\Tools\\ContentFerry\\文渡-Portable.exe" }, (candidate) => candidate === launcher, () => ["PackageManager"]))
      .toContain(launcher);
  });

  it("resolves an installed CLI by name without executing it during discovery", async () => {
    const registry = new SystemToolRegistry(
      async (command) => command === "java" ? ["C:\\Java\\bin\\java.exe"] : []
    );

    await expect(registry.resolveCommand("java")).resolves.toMatchObject({
      id: "cli:java", command: "java", path: "C:\\Java\\bin\\java.exe", capabilities: ["task_cli"]
    });
    await expect(registry.resolveCommand("C:\\Java\\bin\\java.exe")).resolves.toBeNull();
  });
});

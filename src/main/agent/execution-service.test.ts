import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ExecutionPolicyError, ExecutionService, type ExecutionRequest } from "./execution-service";

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  const cwd = overrides.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-exec-"));
  return {
    targetType: "host_trusted",
    runtime: "node",
    args: ["-e", "process.stdout.write('ok')"],
    cwd,
    directoryGrants: [{ path: cwd, access: "write" }],
    networkPolicy: "disabled",
    confirmed: true,
    acknowledgeHostRisk: true,
    ...overrides
  };
}

function hostNodeExecutable(): string {
  return process.platform === "win32"
    ? execFileSync("where.exe", ["node"], { encoding: "utf8" }).split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? process.execPath
    : process.execPath;
}
function findHostNvmExecutable(): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    return execFileSync("where.exe", ["nvm"], { encoding: "utf8" }).split(/\r?\n/u).map((line) => line.trim()).find((line) => line.toLowerCase().endsWith("nvm.exe"));
  } catch { return undefined; }
}
const hostNvmExecutable = findHostNvmExecutable();

describe("ExecutionService", () => {
  it("runs structured node argv and returns output", async () => {
    const result = await new ExecutionService().run(request());
    expect(result.status).toBe("completed");
    expect(result.stdout).toBe("ok");
  });

  it("rejects an unapproved host run and unsupported target without fallback", async () => {
    const service = new ExecutionService();
    await expect(service.preflight(request({ acknowledgeHostRisk: false }))).rejects.toThrow(ExecutionPolicyError);
    const preflight = await service.preflight(request({ targetType: "wsl", targetOptions: { wslDistribution: "__contentferry_missing_distribution__" } }));
    expect(preflight.available).toBe(false);
    expect(preflight.reason).toContain("不会自动回退");
  });

  it("requires a writable grant for an output directory", async () => {
    const service = new ExecutionService();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "contentferry-exec-"));
    await expect(service.preflight(request({ cwd: root, directoryGrants: [{ path: root, access: "read" }], outputDirectory: root }))).rejects.toThrow("可写目录");
  });

  it("accepts digit-leading DNS names but rejects IP literals in an allowlist", async () => {
    const service = new ExecutionService();
    const accepted = await service.preflight(request({ networkPolicy: "allowlist", allowedHosts: ["1password.com"] }));
    expect(accepted.available).toBe(true);
    await expect(service.preflight(request({ networkPolicy: "allowlist", allowedHosts: ["127.0.0.1"] }))).rejects.toThrow("公开域名");
  });

  it("stops a run when the output limit is reached", async () => {
    const result = await new ExecutionService().run(request({
      args: ["-e", "process.stdout.write('x'.repeat(20000))"],
      outputLimitBytes: 4096
    }));
    expect(result.status).toBe("output_limit");
    expect(result.truncated).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("runs in a Windows terminal and captures console output", async () => {
    const result = await new ExecutionService().run(request({
      terminal: true,
      runtime: "custom",
      executable: hostNodeExecutable(),
      args: ["-e", "process.stdout.write(`stdin=${Boolean(process.stdin.isTTY)} stdout=${Boolean(process.stdout.isTTY)}\\r\\nterminal-output-ok\\r\\n`)"]
    }));

    expect(result.status).toBe("completed");
    expect(result.stdout).toContain("stdin=true stdout=true");
    expect(result.stdout).toContain("terminal-output-ok");
  });

  it.skipIf(process.platform !== "win32")("bounds ConPTY output and cancels the attached process", async () => {
    const bounded = await new ExecutionService().run(request({
      terminal: true,
      runtime: "custom",
      executable: hostNodeExecutable(),
      args: ["-e", "process.stdout.write('x'.repeat(20000))"],
      outputLimitBytes: 4096
    }));
    expect(bounded.status).toBe("output_limit");
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.stdout, "utf8")).toBeLessThanOrEqual(4096);

    const controller = new AbortController();
    const running = new ExecutionService().run(request({ terminal: true, runtime: "custom", executable: hostNodeExecutable(), args: ["-e", "setInterval(() => process.stdout.write('alive\\r\\n'), 20)"] }), controller.signal);
    setTimeout(() => controller.abort(), 80);
    const cancelled = await running;
    expect(cancelled.status).toBe("cancelled");
  });

  it.skipIf(!hostNvmExecutable)("captures the installed NVM for Windows version list through ConPTY", async () => {
    const result = await new ExecutionService().run(request({
      runtime: "custom",
      executable: hostNvmExecutable,
      terminal: true,
      args: ["list"]
    }));

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/u);
    expect(result.stdout).not.toContain("Terminal Only");
  });
});

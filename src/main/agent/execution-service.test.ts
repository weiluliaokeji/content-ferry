import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
});

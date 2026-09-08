import { describe, expect, it } from "vitest";
import { evaluatePermission } from "./permission-policy";
import { ToolRunner } from "./tool-runner";

describe("tool permission and execution seam", () => {
  it("lets explicit deny win over a more specific allow", () => {
    const result = evaluatePermission(
      { toolId: "git", action: "read", risk: "low", projectId: "p", target: "D:/repo" },
      [
        { scope: "global", decision: "deny", toolId: "git" },
        { scope: "run", decision: "allow", toolId: "git", projectId: "p", targetPrefix: "D:/repo" }
      ]
    );
    expect(result.decision).toBe("deny");
  });

  it("matches directory grants on path boundaries", () => {
    const result = evaluatePermission(
      { toolId: "git", action: "read", risk: "medium", target: "C:/workspace-other/file.ts" },
      [{ scope: "global", decision: "allow", toolId: "git", targetPrefix: "C:\\workspace" }]
    );
    expect(result.decision).toBe("ask");
  });

  it("matches network grants only on DNS label boundaries", () => {
    const grant = [{ scope: "global" as const, decision: "allow" as const, action: "network_read" as const, targetPrefix: "example.com" }];
    expect(evaluatePermission({ toolId: "web", action: "network_read", risk: "medium", target: "api.example.com" }, grant).decision).toBe("allow");
    expect(evaluatePermission({ toolId: "web", action: "network_read", risk: "medium", target: "example.com.evil" }, grant).decision).toBe("ask");
  });

  it("does not run an unapproved adapter and runs an approved one", async () => {
    const runner = new ToolRunner([{ id: "echo", async run(input) { return input; } }]);
    const blocked = await runner.run({ toolId: "echo", action: "write", risk: "medium", input: "x" }, []);
    expect(blocked.status).toBe("waiting_user");
    const allowed = await runner.run({ toolId: "echo", action: "read", risk: "low", defaultAllow: true, input: "x" }, []);
    expect(allowed).toMatchObject({ status: "completed", output: "x" });
  });
});

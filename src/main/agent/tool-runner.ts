import type { PermissionResult, ToolPermissionGrant, ToolPermissionRequest } from "./permission-policy";
import { evaluatePermission } from "./permission-policy";

export interface ToolExecutionContext {
  signal?: AbortSignal;
  projectId?: string;
  workspaceId?: string;
}

export interface ToolAdapter {
  readonly id: string;
  run(input: unknown, context: ToolExecutionContext): Promise<unknown>;
}

export interface ToolInvocation extends ToolPermissionRequest {
  input: unknown;
}

export type ToolRunResult =
  | { status: "completed"; toolId: string; output: unknown; permission: PermissionResult }
  | { status: "waiting_user"; toolId: string; permission: PermissionResult }
  | { status: "denied"; toolId: string; permission: PermissionResult }
  | { status: "failed"; toolId: string; permission: PermissionResult; error: string };

/** Executes only adapters that passed the shared permission policy. */
export class ToolRunner {
  private readonly adapters = new Map<string, ToolAdapter>();

  constructor(adapters: ToolAdapter[] = []) {
    for (const adapter of adapters) this.adapters.set(adapter.id, adapter);
  }

  register(adapter: ToolAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  async run(invocation: ToolInvocation, grants: ToolPermissionGrant[], context: ToolExecutionContext = {}): Promise<ToolRunResult> {
    const permission = evaluatePermission(invocation, grants);
    if (permission.decision === "deny") return { status: "denied", toolId: invocation.toolId, permission };
    if (permission.decision === "ask") return { status: "waiting_user", toolId: invocation.toolId, permission };
    const adapter = this.adapters.get(invocation.toolId);
    if (!adapter) return { status: "failed", toolId: invocation.toolId, permission, error: `未注册工具：${invocation.toolId}` };
    try {
      return { status: "completed", toolId: invocation.toolId, output: await adapter.run(invocation.input, context), permission };
    } catch (error) {
      return { status: "failed", toolId: invocation.toolId, permission, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

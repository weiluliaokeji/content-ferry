import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { PermissionDecision, PermissionScope, ToolAction, ToolPermissionGrant } from "./permission-policy";

export interface StoredPermissionGrant extends ToolPermissionGrant {
  id: string;
  createdAt: string;
}

export class PermissionGrantRepository {
  constructor(private readonly db: Database.Database) {}

  list(projectId?: string): StoredPermissionGrant[] {
    const rows = projectId
      ? this.db.prepare(`SELECT id, scope, decision, tool_id AS toolId, action, project_id AS projectId,
          target_prefix AS targetPrefix, expires_at AS expiresAt, created_at AS createdAt
          FROM agent_permission_grants WHERE project_id IS NULL OR project_id = ? ORDER BY created_at DESC`).all(projectId) as PermissionGrantRow[]
      : this.db.prepare(`SELECT id, scope, decision, tool_id AS toolId, action, project_id AS projectId,
          target_prefix AS targetPrefix, expires_at AS expiresAt, created_at AS createdAt
          FROM agent_permission_grants ORDER BY created_at DESC`).all() as PermissionGrantRow[];
    return rows.map(toGrant);
  }

  create(input: ToolPermissionGrant): StoredPermissionGrant {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO agent_permission_grants
      (id, scope, decision, tool_id, action, project_id, target_prefix, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.scope, input.decision, input.toolId ?? null, input.action ?? null,
      input.projectId ?? null, input.targetPrefix ?? null, input.expiresAt ?? null, createdAt
    );
    return { ...input, id, createdAt };
  }

  remove(id: string): void {
    const result = this.db.prepare("DELETE FROM agent_permission_grants WHERE id = ?").run(id);
    if (result.changes === 0) throw new Error("找不到这条权限授权。");
  }
}

interface PermissionGrantRow {
  id: string;
  scope: PermissionScope;
  decision: PermissionDecision;
  toolId: string | null;
  action: ToolAction | null;
  projectId: string | null;
  targetPrefix: string | null;
  expiresAt: string | null;
  createdAt: string;
}

function toGrant(row: PermissionGrantRow): StoredPermissionGrant {
  return {
    id: row.id,
    scope: row.scope,
    decision: row.decision,
    ...(row.toolId ? { toolId: row.toolId } : {}),
    ...(row.action ? { action: row.action } : {}),
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.targetPrefix ? { targetPrefix: row.targetPrefix } : {}),
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    createdAt: row.createdAt
  };
}

import { describe, expect, it } from "vitest";
import { openInMemoryDatabase } from "../db/database";
import { DEFAULT_PROJECT_PERMISSION_LEASE_MS, PermissionGrantRepository } from "./permission-grant-repository";

describe("PermissionGrantRepository", () => {
  it("gives project leases a bounded default lifetime", () => {
    const database = openInMemoryDatabase();
    const repository = new PermissionGrantRepository(database.connection);
    const grant = repository.create({ scope: "project", decision: "allow", toolId: "git_clone_source", action: "write" });
    expect(grant.expiresAt).toBeDefined();
    expect(Date.parse(grant.expiresAt ?? "") - Date.parse(grant.createdAt)).toBe(DEFAULT_PROJECT_PERMISSION_LEASE_MS);
    database.close();
  });
});

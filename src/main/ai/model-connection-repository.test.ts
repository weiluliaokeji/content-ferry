import { describe, it, expect } from "vitest";
import { ModelConnectionRepository } from "./model-connection-repository";

// The repository imports `better-sqlite3` only as a type, so a stub DB keeps
// this test free of the native module (which fails to load under the regular
// Node/better-sqlite3 ABI mismatch on some machines).
function stubDb(overrides: Record<string, { proxy_url: string }> = {}) {
  return {
    prepare: (_sql: string) => ({
      run: () => ({}),
      get: (provider: string) => overrides[provider] ?? undefined,
      all: () => []
    })
  } as any;
}

function stubCredentials() {
  return { configured: () => false, get: () => "", save: () => {} } as any;
}

describe("ModelConnectionRepository defaults", () => {
  it("ships no proxy baked into any default connection", () => {
    const repo = new ModelConnectionRepository(stubDb(), stubCredentials());
    for (const connection of repo.list()) {
      expect(connection.proxyUrl, `default "${connection.provider}" must not bake in a proxy`).toBe("");
    }
  });

  it("ships built-in search on by default (Codex native retrieval trade-off)", () => {
    const repo = new ModelConnectionRepository(stubDb(), stubCredentials());
    for (const connection of repo.list()) {
      expect(connection.builtInSearch, `default "${connection.provider}" should enable built-in search`).toBe(true);
    }
  });
});

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AppCredentialRepository } from "../security/app-credential-repository";

export const modelProviderIds = [
  "openai_codex",
  "modelscope",
  "agnes"
] as const;

export type ModelProviderId = typeof modelProviderIds[number];

/** Provider 主键：内置预置项使用枚举值，用户自定义连接使用 "custom:<uuid>"。 */
export type ModelProviderKey = ModelProviderId | (string & {});

export const CUSTOM_PROVIDER_PREFIX = "custom:";

export function isModelProviderId(provider: string): provider is ModelProviderId {
  return (modelProviderIds as readonly string[]).includes(provider);
}

export interface ModelConnection {
  provider: ModelProviderKey;
  displayName: string;
  modelId: string;
  baseUrl: string;
  proxyUrl: string;
  enabled: boolean;
  /** When true (default for OpenAI Codex), 联网补研 uses the provider's own
   *  built-in web search instead of the app-owned WebSearchClient. Only
   *  meaningful for providers that ship a built-in search (currently Codex). */
  builtInSearch: boolean;
  /** True for user-created connections (provider = "custom:<uuid>"); built-in
   *  presets are always false and cannot be deleted. */
  custom: boolean;
  credentialConfigured: boolean;
}

type ModelConnectionRow = {
  provider: string;
  display_name: string;
  model_id: string;
  base_url: string;
  proxy_url: string;
  enabled: number;
  built_in_search: number;
  custom: number;
};

export interface CustomConnectionInput {
  displayName: string;
  modelId?: string;
  baseUrl: string;
  proxyUrl?: string;
  credential?: string;
}

const defaults: Record<ModelProviderId, Omit<ModelConnection, "credentialConfigured" | "custom">> = {
  openai_codex: { provider: "openai_codex", displayName: "OpenAI Codex", modelId: "", baseUrl: "", proxyUrl: "", enabled: true, builtInSearch: true },
  modelscope: { provider: "modelscope", displayName: "ModelScope", modelId: "Tongyi-MAI/Z-Image-Turbo", baseUrl: "https://api-inference.modelscope.cn", proxyUrl: "", enabled: true, builtInSearch: true },
  agnes: { provider: "agnes", displayName: "Agnes AI", modelId: "agnes-image-2.1-flash", baseUrl: "https://apihub.agnes-ai.com/v1", proxyUrl: "", enabled: true, builtInSearch: true }
};

export class ModelConnectionRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly credentials: AppCredentialRepository
  ) {
    this.migrateBuiltInSearchColumn();
    this.migrateCustomColumn();
    this.pruneRemovedPresets();
  }

  /** Add the `custom` column on existing installs. The column was introduced
   *  for user-created connections; NOT NULL DEFAULT 0 keeps every pre-existing
   *  row (built-in presets) marked as built-in. */
  private migrateCustomColumn(): void {
    const row = this.db
      .prepare(`SELECT 1 AS present FROM pragma_table_info('model_connections') WHERE name = 'custom'`)
      .get() as { present: number } | undefined;
    if (row) return;
    this.db
      .prepare(`ALTER TABLE model_connections ADD COLUMN custom INTEGER NOT NULL DEFAULT 0`)
      .run();
  }

  /** Add the `built_in_search` column on existing installs. The column was
   *  introduced after launch, so only databases created earlier lack it. The
   *  NOT NULL DEFAULT 1 keeps the on-by-default behaviour for every existing
   *  row, matching the shipped default for new connections. */
  private migrateBuiltInSearchColumn(): void {
    const row = this.db
      .prepare(`SELECT 1 AS present FROM pragma_table_info('model_connections') WHERE name = 'built_in_search'`)
      .get() as { present: number } | undefined;
    if (row) return;
    this.db
      .prepare(`ALTER TABLE model_connections ADD COLUMN built_in_search INTEGER NOT NULL DEFAULT 1`)
      .run();
  }

  /** Remove rows left behind by preset templates that were dropped from the
   *  shipped defaults (e.g. OpenAI API, OpenRouter, Nous, NVIDIA Build, GitHub
   *  Copilot). Old installs carry those rows with custom=0; without cleanup the
   *  list would show them as undelatable "预置模板". Their credentials are
   *  removed too, so users re-enter keys when recreating the connection. */
  private pruneRemovedPresets(): void {
    const removed = this.db.prepare(
      `SELECT provider FROM model_connections WHERE custom = 0`
    ).all() as Array<{ provider: string }>;
    for (const { provider } of removed) {
      if (isModelProviderId(provider)) continue;
      this.credentials.remove(this.credentialKind(provider));
      this.db.prepare(`DELETE FROM model_connections WHERE provider = ?`).run(provider);
    }
  }

  /** Returns built-in presets (in canonical order) followed by user-created
   *  custom connections. */
  list(): ModelConnection[] {
    const rows = this.db.prepare(`SELECT provider, display_name, model_id, base_url, proxy_url, enabled, built_in_search, custom
      FROM model_connections ORDER BY custom ASC, provider ASC`).all() as ModelConnectionRow[];
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    const items: ModelConnection[] = [];
    for (const provider of modelProviderIds) {
      const row = byProvider.get(provider);
      items.push(row ? this.toConnection(row) : this.get(provider));
    }
    for (const row of rows) {
      if (!isModelProviderId(row.provider)) items.push(this.toConnection(row));
    }
    return items;
  }

  get(provider: string): ModelConnection {
    const row = this.db.prepare(`SELECT provider, display_name, model_id, base_url, proxy_url, enabled, built_in_search, custom
      FROM model_connections WHERE provider = ?`).get(provider) as ModelConnectionRow | undefined;
    if (row) return this.toConnection(row);
    if (isModelProviderId(provider)) {
      const value = defaults[provider];
      return {
        ...value,
        custom: false,
        credentialConfigured: provider === "openai_codex" || this.credentials.configured(this.credentialKind(provider))
      };
    }
    return {
      provider,
      displayName: provider,
      modelId: "",
      baseUrl: "",
      proxyUrl: "",
      enabled: false,
      builtInSearch: true,
      custom: true,
      credentialConfigured: this.credentials.configured(this.credentialKind(provider))
    };
  }

  save(input: Omit<ModelConnection, "credentialConfigured" | "custom"> & { credential?: string; custom?: boolean }): ModelConnection {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO model_connections
      (provider, display_name, model_id, base_url, proxy_url, enabled, built_in_search, custom, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET display_name = excluded.display_name,
        model_id = excluded.model_id, base_url = excluded.base_url, proxy_url = excluded.proxy_url,
        enabled = excluded.enabled, built_in_search = excluded.built_in_search, updated_at = excluded.updated_at`)
      .run(input.provider, input.displayName, input.modelId, input.baseUrl, input.proxyUrl, input.enabled ? 1 : 0, input.builtInSearch ? 1 : 0, input.custom ? 1 : 0, now, now);
    if (input.credential?.trim()) this.credentials.save(this.credentialKind(input.provider), input.credential.trim());
    return this.get(input.provider);
  }

  /** Creates a user-owned connection with a unique `custom:<uuid>` provider key
   *  and the OpenAI-compatible defaults (enabled, built-in search on). */
  createCustom(input: CustomConnectionInput): ModelConnection {
    const provider = `${CUSTOM_PROVIDER_PREFIX}${randomUUID()}`;
    return this.save({
      provider,
      displayName: input.displayName,
      modelId: input.modelId ?? "",
      baseUrl: input.baseUrl,
      proxyUrl: input.proxyUrl ?? "",
      enabled: true,
      builtInSearch: true,
      custom: true,
      credential: input.credential
    });
  }

  /** Deletes a user-created custom connection together with its credential.
   *  Built-in presets are protected and throw. */
  deleteCustom(provider: string): void {
    const row = this.db.prepare(`SELECT custom FROM model_connections WHERE provider = ?`).get(provider) as { custom: number } | undefined;
    if (!row) throw new Error("该模型连接不存在。");
    if (!row.custom) throw new Error("内置预置连接不可删除，只能编辑。");
    this.credentials.remove(this.credentialKind(provider));
    this.db.prepare(`DELETE FROM model_connections WHERE provider = ?`).run(provider);
  }

  private toConnection(row: ModelConnectionRow): ModelConnection {
    return {
      provider: row.provider,
      displayName: row.display_name,
      modelId: row.model_id,
      baseUrl: row.base_url,
      proxyUrl: row.proxy_url,
      enabled: Boolean(row.enabled),
      builtInSearch: Boolean(row.built_in_search),
      custom: Boolean(row.custom),
      credentialConfigured: row.provider === "openai_codex" || this.credentials.configured(this.credentialKind(row.provider))
    };
  }

  getCredential(provider: string): string {
    return this.credentials.get(this.credentialKind(provider), `${this.get(provider).displayName} 尚未配置访问凭证。`);
  }

  private credentialKind(provider: string): string {
    // Keep the old key so existing ModelScope installations migrate without asking users to enter it again.
    return provider === "modelscope" ? "modelscope_api_key" : `model_provider:${provider}:credential`;
  }
}

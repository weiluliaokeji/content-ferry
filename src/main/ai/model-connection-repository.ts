import type Database from "better-sqlite3";
import type { AppCredentialRepository } from "../security/app-credential-repository";

export const modelProviderIds = [
  "openai_codex",
  "openai",
  "openrouter",
  "nous",
  "nvidia_build",
  "github_copilot",
  "modelscope",
  "gemini"
] as const;

export type ModelProviderId = typeof modelProviderIds[number];

export interface ModelConnection {
  provider: ModelProviderId;
  displayName: string;
  modelId: string;
  baseUrl: string;
  proxyUrl: string;
  enabled: boolean;
  credentialConfigured: boolean;
}

const defaults: Record<ModelProviderId, Omit<ModelConnection, "credentialConfigured">> = {
  openai_codex: { provider: "openai_codex", displayName: "OpenAI Codex", modelId: "", baseUrl: "", proxyUrl: "", enabled: true },
  openai: { provider: "openai", displayName: "OpenAI API", modelId: "gpt-5-mini", baseUrl: "https://api.openai.com/v1", proxyUrl: "", enabled: true },
  openrouter: { provider: "openrouter", displayName: "OpenRouter", modelId: "openai/gpt-5-mini", baseUrl: "https://openrouter.ai/api/v1", proxyUrl: "", enabled: true },
  nous: { provider: "nous", displayName: "Nous Research Portal", modelId: "stepfun/step-3.7-flash:free", baseUrl: "https://inference-api.nousresearch.com/v1", proxyUrl: "", enabled: true },
  nvidia_build: { provider: "nvidia_build", displayName: "NVIDIA Build", modelId: "z-ai/glm-5.2", baseUrl: "https://integrate.api.nvidia.com/v1", proxyUrl: "", enabled: true },
  github_copilot: { provider: "github_copilot", displayName: "GitHub Copilot", modelId: "gpt-5", baseUrl: "", proxyUrl: "", enabled: true },
  modelscope: { provider: "modelscope", displayName: "ModelScope", modelId: "Qwen/Qwen-Image-2512", baseUrl: "https://api-inference.modelscope.cn", proxyUrl: "", enabled: true },
  gemini: { provider: "gemini", displayName: "Google Gemini", modelId: "gemini-3.1-flash-image", baseUrl: "https://generativelanguage.googleapis.com", proxyUrl: "http://127.0.0.1:7890", enabled: true }
};

export class ModelConnectionRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly credentials: AppCredentialRepository
  ) {
    this.migrateNousEndpoint();
  }

  /** Self-heal the Nous Research Portal endpoint. The original default pointed at a
   *  wrong domain (api.portal.ai) instead of the real inference endpoint. Existing
   *  installs that saved the connection still carry the broken value, so rewrite any
   *  record that still uses the typo domain. User-customized endpoints are left alone. */
  private migrateNousEndpoint(): void {
    this.db.prepare(
      `UPDATE model_connections SET base_url = ?, updated_at = ?
       WHERE provider = 'nous' AND base_url LIKE '%api.portal.ai%'`
    ).run(defaults.nous.baseUrl, new Date().toISOString());
  }

  list(): ModelConnection[] {
    return modelProviderIds.map((provider) => this.get(provider));
  }

  get(provider: ModelProviderId): ModelConnection {
    const row = this.db.prepare(`SELECT provider, display_name, model_id, base_url, proxy_url, enabled
      FROM model_connections WHERE provider = ?`).get(provider) as {
        provider: ModelProviderId; display_name: string; model_id: string; base_url: string; proxy_url: string; enabled: number;
      } | undefined;
    const value = row ? {
      provider: row.provider,
      displayName: row.display_name,
      modelId: row.model_id,
      baseUrl: row.base_url,
      proxyUrl: row.proxy_url,
      enabled: Boolean(row.enabled)
    } : defaults[provider];
    return {
      ...value,
      credentialConfigured: provider === "openai_codex" || this.credentials.configured(this.credentialKind(provider))
    };
  }

  save(input: Omit<ModelConnection, "credentialConfigured"> & { credential?: string }): ModelConnection {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO model_connections
      (provider, display_name, model_id, base_url, proxy_url, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET display_name = excluded.display_name,
        model_id = excluded.model_id, base_url = excluded.base_url, proxy_url = excluded.proxy_url,
        enabled = excluded.enabled, updated_at = excluded.updated_at`)
      .run(input.provider, input.displayName, input.modelId, input.baseUrl, input.proxyUrl, input.enabled ? 1 : 0, now, now);
    if (input.credential?.trim()) this.credentials.save(this.credentialKind(input.provider), input.credential.trim());
    return this.get(input.provider);
  }

  getCredential(provider: ModelProviderId): string {
    return this.credentials.get(this.credentialKind(provider), `${this.get(provider).displayName} 尚未配置访问凭证。`);
  }

  /** Returns a proxy URL to use for app-owned external requests (web search + fetch),
   *  so the检索层 honors the same network proxy the user set on a model connection.
   *  Prefers the first connection that has one configured. */
  getSearchProxyUrl(): string | undefined {
    for (const connection of this.list()) {
      const proxy = connection.proxyUrl?.trim();
      if (proxy) return proxy;
    }
    return undefined;
  }

  private credentialKind(provider: ModelProviderId): string {
    // Keep the old key so existing ModelScope installations migrate without asking users to enter it again.
    return provider === "modelscope" ? "modelscope_api_key" : `model_provider:${provider}:credential`;
  }
}

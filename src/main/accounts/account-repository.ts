import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CredentialVault } from "../security/credential-vault";

export type AccountPlatform = "wechat_official" | "csdn" | "cnblogs" | "juejin";

export interface AccountProfile {
  positioning: string;
  targetAudience: string;
  prohibitedTopics: string;
  writingStyle: string;
  regularColumns: string;
  articleSignature: string;
}

export interface MediaAccount {
  id: string;
  workspaceId: string;
  platform: AccountPlatform;
  displayName: string;
  externalAccountId: string | null;
  capabilityLevel: string;
  credentialsConfigured: boolean;
  profile: AccountProfile;
}

export class AccountAlreadyExistsError extends Error {
  constructor() {
    super("该平台下已存在同名账号。");
    this.name = "AccountAlreadyExistsError";
  }
}

const emptyProfile: AccountProfile = {
  positioning: "",
  targetAudience: "",
  prohibitedTopics: "",
  writingStyle: "",
  regularColumns: "",
  articleSignature: ""
};

export class AccountRepository {
  constructor(private readonly db: Database.Database) {}

  getOrCreateDefaultWorkspace(): { id: string; displayName: string; timezone: string } {
    const found = this.db.prepare("SELECT id, display_name, timezone FROM workspaces ORDER BY created_at LIMIT 1").get() as
      | { id: string; display_name: string; timezone: string }
      | undefined;
    if (found) return { id: found.id, displayName: found.display_name, timezone: found.timezone };

    const workspace = { id: "local-default", displayName: "我的内容工作台", timezone: "Asia/Shanghai" };
    this.db.prepare("INSERT INTO workspaces (id, display_name, timezone, created_at) VALUES (?, ?, ?, ?)")
      .run(workspace.id, workspace.displayName, workspace.timezone, new Date().toISOString());
    return workspace;
  }

  listAccounts(workspaceId: string): MediaAccount[] {
    const rows = this.db.prepare(`
      SELECT a.id, a.workspace_id, a.platform, a.display_name, a.external_account_id, a.capability_level,
             EXISTS(SELECT 1 FROM account_credentials ac WHERE ac.account_id = a.id) AS credentials_configured,
             p.positioning, p.target_audience, p.prohibited_topics, p.writing_style, p.regular_columns, p.article_signature
      FROM media_accounts a LEFT JOIN account_profiles p ON p.account_id = a.id
      WHERE a.workspace_id = ? AND a.deleted_at IS NULL ORDER BY a.created_at
    `).all(workspaceId) as Array<Record<string, string | null>>;
    return rows.map((row) => this.mapAccount(row));
  }

  createAccount(input: { workspaceId: string; platform: AccountPlatform; displayName: string; externalAccountId?: string }): MediaAccount {
    const existing = this.db.prepare(`SELECT id FROM media_accounts
      WHERE workspace_id = ? AND platform = ? AND display_name = ? COLLATE NOCASE AND deleted_at IS NULL`).get(
      input.workspaceId, input.platform, input.displayName
    ) as { id: string } | undefined;
    if (existing) throw new AccountAlreadyExistsError();

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO media_accounts
      (id, workspace_id, platform, display_name, external_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, input.workspaceId, input.platform, input.displayName, input.externalAccountId ?? null, now);
    this.db.prepare(`INSERT INTO account_profiles (account_id, updated_at) VALUES (?, ?)`)
      .run(id, now);
    return this.requireAccount(id);
  }

  updateProfile(accountId: string, profile: AccountProfile): MediaAccount {
    const now = new Date().toISOString();
    const changed = this.db.prepare(`UPDATE account_profiles SET positioning = ?, target_audience = ?, prohibited_topics = ?,
      writing_style = ?, regular_columns = ?, article_signature = ?, updated_at = ? WHERE account_id = ?`)
      .run(profile.positioning, profile.targetAudience, profile.prohibitedTopics, profile.writingStyle, profile.regularColumns, profile.articleSignature, now, accountId);
    if (changed.changes === 0) throw new Error("Account not found.");
    return this.requireAccount(accountId);
  }

  updateDisplayName(accountId: string, displayName: string): MediaAccount {
    const account = this.requireAccount(accountId);
    const duplicate = this.db.prepare(`SELECT id FROM media_accounts
      WHERE workspace_id = ? AND platform = ? AND display_name = ? COLLATE NOCASE AND deleted_at IS NULL AND id <> ?`)
      .get(account.workspaceId, account.platform, displayName, accountId) as { id: string } | undefined;
    if (duplicate) throw new AccountAlreadyExistsError();
    const changed = this.db.prepare("UPDATE media_accounts SET display_name = ? WHERE id = ? AND deleted_at IS NULL")
      .run(displayName, accountId);
    if (changed.changes === 0) throw new Error("Account not found.");
    return this.requireAccount(accountId);
  }

  /** 更新账号绑定的外部账号标识（如博客园博客名/博客地址）。传空字符串会清空为 null。 */
  updateExternalAccountId(accountId: string, externalAccountId: string | null): MediaAccount {
    const value = externalAccountId?.trim() ? externalAccountId.trim() : null;
    const changed = this.db.prepare("UPDATE media_accounts SET external_account_id = ? WHERE id = ? AND deleted_at IS NULL")
      .run(value, accountId);
    if (changed.changes === 0) throw new Error("Account not found.");
    return this.requireAccount(accountId);
  }

  saveCredential(accountId: string, credentialKind: string, secret: string, vault: CredentialVault): void {
    this.requireAccount(accountId);
    const existing = this.db.prepare("SELECT secret_id FROM account_credentials WHERE account_id = ? AND credential_kind = ?")
      .get(accountId, credentialKind) as { secret_id: string } | undefined;
    const id = existing?.secret_id ?? randomUUID();
    const now = new Date().toISOString();
    const encrypted = vault.encrypt(secret);
    this.db.prepare(`INSERT INTO credential_secrets (id, encrypted_value, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET encrypted_value = excluded.encrypted_value, updated_at = excluded.updated_at`)
      .run(id, encrypted, now, now);
    this.db.prepare(`INSERT INTO account_credentials (account_id, credential_kind, secret_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, credential_kind)
      DO UPDATE SET secret_id = excluded.secret_id, updated_at = excluded.updated_at`)
      .run(accountId, credentialKind, id, now, now);
  }

  requireAccount(id: string): MediaAccount {
    const row = this.db.prepare(`SELECT a.id, a.workspace_id, a.platform, a.display_name, a.external_account_id, a.capability_level,
      EXISTS(SELECT 1 FROM account_credentials ac WHERE ac.account_id = a.id) AS credentials_configured,
      p.positioning, p.target_audience, p.prohibited_topics, p.writing_style, p.regular_columns, p.article_signature
      FROM media_accounts a JOIN account_profiles p ON p.account_id = a.id WHERE a.id = ? AND a.deleted_at IS NULL`).get(id) as Record<string, string | null> | undefined;
    if (!row) throw new Error("Account not found.");
    return this.mapAccount(row);
  }

  getCredential(accountId: string, credentialKind: string, vault: CredentialVault): string {
    this.requireAccount(accountId);
    const row = this.db.prepare(`SELECT s.encrypted_value
      FROM account_credentials c JOIN credential_secrets s ON s.id = c.secret_id
      WHERE c.account_id = ? AND c.credential_kind = ?`)
      .get(accountId, credentialKind) as { encrypted_value: Buffer } | undefined;
    if (!row) throw new Error(`账号尚未配置 ${credentialKind}。`);
    return vault.decrypt(row.encrypted_value);
  }

  credentialStatus(accountId: string, vault: CredentialVault): { appId: string; appSecretConfigured: boolean; callbackTokenConfigured: boolean; cnblogsUsername: string; cnblogsApiKeyConfigured: boolean; juejinCookieConfigured: boolean; juejinAidConfigured: boolean; juejinUuidConfigured: boolean } {
    this.requireAccount(accountId);
    const kinds = this.db.prepare("SELECT credential_kind FROM account_credentials WHERE account_id = ?")
      .all(accountId) as Array<{ credential_kind: string }>;
    const configured = new Set(kinds.map((row) => row.credential_kind));
    return {
      appId: configured.has("app_id") ? this.getCredential(accountId, "app_id", vault) : "",
      appSecretConfigured: configured.has("app_secret"),
      callbackTokenConfigured: configured.has("callback_token"),
      cnblogsUsername: configured.has("username") ? this.getCredential(accountId, "username", vault) : "",
      cnblogsApiKeyConfigured: configured.has("api_key"),
      juejinCookieConfigured: configured.has("juejin_cookie"),
      juejinAidConfigured: configured.has("juejin_aid"),
      juejinUuidConfigured: configured.has("juejin_uuid")
    };
  }

  deleteAccount(accountId: string): void {
    this.requireAccount(accountId);
    this.db.transaction(() => {
      const secrets = this.db.prepare("SELECT secret_id FROM account_credentials WHERE account_id = ?")
        .all(accountId) as Array<{ secret_id: string }>;
      this.db.prepare("DELETE FROM account_credentials WHERE account_id = ?").run(accountId);
      for (const secret of secrets) this.db.prepare("DELETE FROM credential_secrets WHERE id = ?").run(secret.secret_id);
      this.db.prepare("UPDATE media_accounts SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), accountId);
    })();
  }

  private mapAccount(row: Record<string, string | null>): MediaAccount {
    return {
      id: row.id as string, workspaceId: row.workspace_id as string, platform: row.platform as AccountPlatform,
      displayName: row.display_name as string, externalAccountId: row.external_account_id,
      capabilityLevel: row.capability_level as string, credentialsConfigured: Boolean(row.credentials_configured),
      profile: { positioning: row.positioning ?? emptyProfile.positioning, targetAudience: row.target_audience ?? emptyProfile.targetAudience,
        prohibitedTopics: row.prohibited_topics ?? emptyProfile.prohibitedTopics, writingStyle: row.writing_style ?? emptyProfile.writingStyle,
        regularColumns: row.regular_columns ?? emptyProfile.regularColumns,
        articleSignature: row.article_signature ?? emptyProfile.articleSignature }
    };
  }
}

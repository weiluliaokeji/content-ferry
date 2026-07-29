import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { CredentialVault } from "./credential-vault";

export class AppCredentialRepository {
  constructor(private readonly db: Database.Database, private readonly vault: CredentialVault) {}

  configured(kind: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM app_credentials WHERE credential_kind = ?").get(kind));
  }

  save(kind: string, secret: string): void {
    const existing = this.db.prepare("SELECT secret_id FROM app_credentials WHERE credential_kind = ?")
      .get(kind) as { secret_id: string } | undefined;
    const id = existing?.secret_id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO credential_secrets (id, encrypted_value, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET encrypted_value = excluded.encrypted_value, updated_at = excluded.updated_at`)
      .run(id, this.vault.encrypt(secret), now, now);
    this.db.prepare(`INSERT INTO app_credentials (credential_kind, secret_id, created_at, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(credential_kind)
      DO UPDATE SET secret_id = excluded.secret_id, updated_at = excluded.updated_at`)
      .run(kind, id, now, now);
  }

  remove(kind: string): void {
    const existing = this.db.prepare("SELECT secret_id FROM app_credentials WHERE credential_kind = ?")
      .get(kind) as { secret_id: string } | undefined;
    if (!existing) return;
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM app_credentials WHERE credential_kind = ?").run(kind);
      this.db.prepare("DELETE FROM credential_secrets WHERE id = ?").run(existing.secret_id);
    });
    transaction();
  }

  get(kind: string, missingMessage = "尚未配置访问凭证。"): string {
    const row = this.db.prepare(`SELECT s.encrypted_value FROM app_credentials a
      JOIN credential_secrets s ON s.id = a.secret_id WHERE a.credential_kind = ?`)
      .get(kind) as { encrypted_value: Buffer } | undefined;
    if (!row) throw new Error(missingMessage);
    return this.vault.decrypt(row.encrypted_value);
  }
}

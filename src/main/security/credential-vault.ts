export interface CredentialVault {
  encrypt(plainText: string): Buffer;
  decrypt(encryptedValue: Buffer): string;
}

/**
 * Electron's safeStorage is intentionally injected here rather than imported.
 * This keeps the database/API testable without an Electron process and prevents
 * an accidental plaintext fallback on machines without OS credential protection.
 */
export class ElectronCredentialVault implements CredentialVault {
  constructor(
    private readonly safeStorage: {
      isEncryptionAvailable(): boolean;
      encryptString(value: string): Buffer;
      decryptString(value: Buffer): string;
    }
  ) {}

  encrypt(plainText: string): Buffer {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows secure credential storage is unavailable. Credentials were not saved.");
    }
    return this.safeStorage.encryptString(plainText);
  }

  decrypt(encryptedValue: Buffer): string {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows secure credential storage is unavailable.");
    }
    return this.safeStorage.decryptString(encryptedValue);
  }
}

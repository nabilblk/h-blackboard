// Stand-in for the OS encryption boundary in unit tests only. The native smoke
// test also exercises Electron safeStorage on the real platform.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function secureStorage() {
  const key = randomBytes(32);
  return {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "test-keyring",
    async encryptStringAsync(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    async decryptStringAsync(value) {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        value.subarray(0, 12),
      );
      decipher.setAuthTag(value.subarray(12, 28));
      return {
        shouldReEncrypt: false,
        result: Buffer.concat([
          decipher.update(value.subarray(28)),
          decipher.final(),
        ]).toString("utf8"),
      };
    },
  };
}

/**
 * Secret encryption helpers using AES-256-GCM.
 * Key derivation: scryptSync(passphrase, 'comfyjourney-salt', 32) (legacy-name)
 *
 * The default salt intentionally keeps the pre-rename product name: changing
 * it changes the derived key, and every existing secret would stop decrypting.
 *
 * Encrypted format: <iv_hex>:<authTag_hex>:<ciphertext_hex>
 */

import {
  createCipheriv,
  createDecipheriv,
  scryptSync,
  randomBytes,
} from "crypto";

function resolveSalt(): string {
  // Intentionally legacy: see the header. Never rename this default.
  return process.env.SECRETS_SALT?.trim() || "comfyjourney-salt"; // legacy-name
}

function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, resolveSalt(), 32) as Buffer;
}

export function encryptSecret(plaintext: string, passphrase: string): string {
  const key = deriveKey(passphrase);
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(encrypted: string, passphrase: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error(
      "Invalid encrypted secret format — expected iv:authTag:ciphertext",
    );
  }
  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key = deriveKey(passphrase);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

// Module-level cache — decryption runs at most once per process.
let _civitaiApiKey: string | null = null;

export function getCivitaiApiKey(): string {
  if (_civitaiApiKey !== null) return _civitaiApiKey;

  const encrypted = process.env.CIVITAI_API_KEY_ENCRYPTED?.trim();
  if (encrypted) {
    const passphrase = process.env.SECRETS_PASSPHRASE?.trim();
    if (!passphrase) {
      throw new Error(
        "CIVITAI_API_KEY_ENCRYPTED is set but SECRETS_PASSPHRASE is missing",
      );
    }
    _civitaiApiKey = decryptSecret(encrypted, passphrase);
  } else {
    _civitaiApiKey = process.env.CIVITAI_API_KEY?.trim() ?? "";
  }

  return _civitaiApiKey;
}

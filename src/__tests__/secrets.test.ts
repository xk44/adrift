/**
 * Secrets Tests
 * =============
 * AES-256-GCM encrypt/decrypt, format validation, key derivation, getCivitaiApiKey.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { encryptSecret, decryptSecret, getCivitaiApiKey } from "@/lib/secrets";

describe("encryptSecret / decryptSecret", () => {
  const passphrase = "test-passphrase-32chars-minimum!";

  it("round-trips plaintext", () => {
    const plain = "my-super-secret-api-key";
    const encrypted = encryptSecret(plain, passphrase);
    expect(decryptSecret(encrypted, passphrase)).toBe(plain);
  });

  it("round-trips empty string", () => {
    const encrypted = encryptSecret("", passphrase);
    expect(decryptSecret(encrypted, passphrase)).toBe("");
  });

  it("round-trips unicode and emoji", () => {
    const plain = "sécret-键-🔑";
    const encrypted = encryptSecret(plain, passphrase);
    expect(decryptSecret(encrypted, passphrase)).toBe(plain);
  });

  it("round-trips long plaintext (10KB)", () => {
    const plain = "x".repeat(10_000);
    const encrypted = encryptSecret(plain, passphrase);
    expect(decryptSecret(encrypted, passphrase)).toBe(plain);
  });

  it("produces iv:authTag:ciphertext format", () => {
    const encrypted = encryptSecret("test", passphrase);
    const parts = encrypted.split(":");
    expect(parts).toHaveLength(3);
    // IV = 12 bytes = 24 hex chars
    expect(parts[0]).toHaveLength(24);
    // Auth tag = 16 bytes = 32 hex chars
    expect(parts[1]).toHaveLength(32);
    // Ciphertext is hex
    expect(parts[2]).toMatch(/^[0-9a-f]+$/);
  });

  it("produces different ciphertexts for same input (random IV)", () => {
    const a = encryptSecret("same", passphrase);
    const b = encryptSecret("same", passphrase);
    expect(a).not.toBe(b);
    // But both decrypt to the same value
    expect(decryptSecret(a, passphrase)).toBe("same");
    expect(decryptSecret(b, passphrase)).toBe("same");
  });

  it("fails with wrong passphrase", () => {
    const encrypted = encryptSecret("secret", passphrase);
    expect(() =>
      decryptSecret(encrypted, "wrong-passphrase-here!!!"),
    ).toThrow();
  });

  it("fails with tampered ciphertext", () => {
    const encrypted = encryptSecret("secret", passphrase);
    const parts = encrypted.split(":");
    // Flip a hex char in ciphertext
    const tampered =
      parts[2][0] === "0" ? "f" + parts[2].slice(1) : "0" + parts[2].slice(1);
    expect(() =>
      decryptSecret(`${parts[0]}:${parts[1]}:${tampered}`, passphrase),
    ).toThrow();
  });

  it("fails with tampered auth tag", () => {
    const encrypted = encryptSecret("secret", passphrase);
    const parts = encrypted.split(":");
    const tampered = "0".repeat(32);
    expect(() =>
      decryptSecret(`${parts[0]}:${tampered}:${parts[2]}`, passphrase),
    ).toThrow();
  });

  it("throws on malformed format (missing parts)", () => {
    expect(() => decryptSecret("abc:def", passphrase)).toThrow(
      /Invalid encrypted secret format/,
    );
    expect(() => decryptSecret("only-one-part", passphrase)).toThrow(
      /Invalid encrypted secret format/,
    );
    expect(() => decryptSecret("a:b:c:d", passphrase)).toThrow(
      /Invalid encrypted secret format/,
    );
  });

  it("throws on empty string input", () => {
    expect(() => decryptSecret("", passphrase)).toThrow(
      /Invalid encrypted secret format/,
    );
  });
});

describe("encryptSecret with custom SECRETS_SALT", () => {
  const passphrase = "test-pass";

  beforeEach(() => {
    process.env.SECRETS_SALT = "custom-salt-value";
  });

  afterEach(() => {
    delete process.env.SECRETS_SALT;
  });

  it("uses custom salt (different key derivation)", () => {
    const encrypted = encryptSecret("test", passphrase);
    // Decrypting with same salt works
    expect(decryptSecret(encrypted, passphrase)).toBe("test");
  });

  it("fails when salt changes between encrypt and decrypt", () => {
    const encrypted = encryptSecret("test", passphrase);
    process.env.SECRETS_SALT = "different-salt";
    expect(() => decryptSecret(encrypted, passphrase)).toThrow();
  });
});

describe("getCivitaiApiKey", () => {
  // The module caches the key, so we need to re-import for each test group
  // Instead, we test the precedence logic by manipulating env before first call

  afterEach(() => {
    delete process.env.CIVITAI_API_KEY_ENCRYPTED;
    delete process.env.SECRETS_PASSPHRASE;
    delete process.env.CIVITAI_API_KEY;
  });

  it("throws when encrypted key is set but no passphrase", async () => {
    // Fresh import to avoid cache
    vi.resetModules();
    process.env.CIVITAI_API_KEY_ENCRYPTED = "abc:def:ghi";
    delete process.env.SECRETS_PASSPHRASE;

    const { getCivitaiApiKey: freshGet } = await import("@/lib/secrets");
    expect(() => freshGet()).toThrow(/SECRETS_PASSPHRASE is missing/);
  });

  it("decrypts encrypted key when passphrase is provided", async () => {
    vi.resetModules();
    const passphrase = "test-passphrase";
    const apiKey = "civitai-key-12345";
    const encrypted = encryptSecret(apiKey, passphrase);

    process.env.CIVITAI_API_KEY_ENCRYPTED = encrypted;
    process.env.SECRETS_PASSPHRASE = passphrase;

    const { getCivitaiApiKey: freshGet } = await import("@/lib/secrets");
    expect(freshGet()).toBe(apiKey);
  });

  it("falls back to plaintext CIVITAI_API_KEY", async () => {
    vi.resetModules();
    delete process.env.CIVITAI_API_KEY_ENCRYPTED;
    process.env.CIVITAI_API_KEY = "plain-key-789";

    const { getCivitaiApiKey: freshGet } = await import("@/lib/secrets");
    expect(freshGet()).toBe("plain-key-789");
  });

  it("returns empty string when no key is configured", async () => {
    vi.resetModules();
    delete process.env.CIVITAI_API_KEY_ENCRYPTED;
    delete process.env.CIVITAI_API_KEY;

    const { getCivitaiApiKey: freshGet } = await import("@/lib/secrets");
    expect(freshGet()).toBe("");
  });

  it("caches result on second call", async () => {
    vi.resetModules();
    process.env.CIVITAI_API_KEY = "cached-key";
    delete process.env.CIVITAI_API_KEY_ENCRYPTED;

    const { getCivitaiApiKey: freshGet } = await import("@/lib/secrets");
    expect(freshGet()).toBe("cached-key");
    // Change env — should still return cached value
    process.env.CIVITAI_API_KEY = "new-key";
    expect(freshGet()).toBe("cached-key");
  });
});

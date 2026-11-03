import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "crypto";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir, rename, rm } from "fs/promises";
import path from "path";
import type { CivitaiSource } from "@/lib/civitai";
import { env } from "@/lib/env";

const CONFIG_DIR_NAME = ".adrift";
/** Config dir name written before the Adrift rename. */
const LEGACY_CONFIG_DIR_NAME = ".comfyjourney"; // legacy-name

/**
 * Config dir under COMFY_ROOT. An install from before the Adrift rename keeps
 * using its legacy dir (config and key file together; nothing is moved) until
 * a new-style dir exists.
 */
export function resolveConfigDir(comfyRoot: string): string {
  const dir = path.join(comfyRoot, CONFIG_DIR_NAME);
  const legacy = path.join(comfyRoot, LEGACY_CONFIG_DIR_NAME);
  return !existsSync(dir) && existsSync(legacy) ? legacy : dir;
}

function configFile(): string {
  return path.join(resolveConfigDir(env.COMFY_ROOT), "civitai.json");
}

function configKeyFile(): string {
  return path.join(resolveConfigDir(env.COMFY_ROOT), "civitai.key");
}

interface CivitaiConfig {
  apiKey?: string;
  showNsfw?: boolean;
  source?: CivitaiSource;
}

interface StoredCivitaiConfig {
  apiKey?: string;
  encryptedApiKey?: string;
  showNsfw?: boolean;
  source?: CivitaiSource;
}

async function writePrivateFileAtomic(filePath: string, payload: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpFile = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(tmpFile, payload, { encoding: "utf-8", mode: 0o600 });
    await rename(tmpFile, filePath);
  } catch (error) {
    await rm(tmpFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function getOrCreateConfigKey(): Promise<Buffer> {
  try {
    const encoded = (await readFile(configKeyFile(), "utf-8")).trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length === 32) return key;
  } catch {
    // Missing key is created below.
  }

  const key = randomBytes(32);
  await writePrivateFileAtomic(configKeyFile(), `${key.toString("base64")}\n`);
  return key;
}

async function encryptApiKey(apiKey: string): Promise<string> {
  const key = await getOrCreateConfigKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

async function decryptApiKey(encryptedApiKey: string): Promise<string> {
  const [version, iv64, tag64, ciphertext64] = encryptedApiKey.split(":");
  if (version !== "v1" || !iv64 || !tag64 || !ciphertext64) {
    throw new Error("Invalid encrypted Civitai API key format");
  }
  const key = await getOrCreateConfigKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv64, "base64"));
  decipher.setAuthTag(Buffer.from(tag64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function getCivitaiConfig(): Promise<CivitaiConfig> {
  try {
    const raw = await readFile(configFile(), "utf-8");
    const stored = JSON.parse(raw) as StoredCivitaiConfig;
    const apiKey = stored.encryptedApiKey
      ? await decryptApiKey(stored.encryptedApiKey)
      : stored.apiKey;
    const source =
      stored.source === "com" || stored.source === "red" ? stored.source : undefined;
    return {
      apiKey,
      showNsfw: stored.showNsfw,
      ...(source ? { source } : {}),
    };
  } catch {
    return {};
  }
}

export async function setCivitaiConfig(config: CivitaiConfig): Promise<void> {
  const trimmedApiKey = config.apiKey?.trim();
  const stored: StoredCivitaiConfig = {
    showNsfw: config.showNsfw,
    source: config.source,
    ...(trimmedApiKey ? { encryptedApiKey: await encryptApiKey(trimmedApiKey) } : {}),
  };
  await writePrivateFileAtomic(configFile(), `${JSON.stringify(stored, null, 2)}\n`);
}

export async function getCivitaiApiKey(): Promise<string> {
  const config = await getCivitaiConfig();
  return config.apiKey?.trim() || env.CIVITAI_API_KEY;
}

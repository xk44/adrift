/**
 * Civitai local config persistence safety.
 */

import { mkdtemp, readFile, readdir, rm, stat } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const roots: string[] = [];

async function loadConfigModule(comfyRoot: string) {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({
    env: {
      COMFY_ROOT: comfyRoot,
      CIVITAI_API_KEY: "env-fallback-key",
    },
  }));
  return import("@/lib/civitaiConfig");
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cj-civitai-config-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.doUnmock("@/lib/env");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("civitaiConfig persistence", () => {
  it("writes config atomically through a private temp file", async () => {
    const root = await makeRoot();
    const { getCivitaiConfig, setCivitaiConfig } = await loadConfigModule(root);

    await setCivitaiConfig({ apiKey: "stored-key", showNsfw: true });

    const configFile = path.join(root, ".adrift", "civitai.json");
    const keyFile = path.join(root, ".adrift", "civitai.key");
    const raw = await readFile(configFile, "utf-8");
    expect(raw).not.toContain("stored-key");
    expect(raw).toContain("encryptedApiKey");
    await expect(getCivitaiConfig()).resolves.toEqual({ apiKey: "stored-key", showNsfw: true });

    const entries = await readdir(path.join(root, ".adrift"));
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
  });

  it("overwrites existing config without leaving stale temp files", async () => {
    const root = await makeRoot();
    const { getCivitaiConfig, setCivitaiConfig } = await loadConfigModule(root);

    await setCivitaiConfig({ apiKey: "first", showNsfw: false });
    await setCivitaiConfig({ apiKey: "second", showNsfw: true });

    await expect(getCivitaiConfig()).resolves.toEqual({ apiKey: "second", showNsfw: true });
    const entries = await readdir(path.join(root, ".adrift"));
    expect(entries.sort()).toEqual(["civitai.json", "civitai.key"].sort());
  });

  it("can read legacy plaintext config while rewriting encrypted config on save", async () => {
    const root = await makeRoot();
    const configDir = path.join(root, ".adrift");
    await import("fs/promises").then((fs) => fs.mkdir(configDir, { recursive: true }));
    await import("fs/promises").then((fs) => fs.writeFile(
      path.join(configDir, "civitai.json"),
      JSON.stringify({ apiKey: "legacy-key", showNsfw: true }),
      "utf-8",
    ));
    const { getCivitaiConfig, setCivitaiConfig } = await loadConfigModule(root);

    await expect(getCivitaiConfig()).resolves.toEqual({ apiKey: "legacy-key", showNsfw: true });
    await setCivitaiConfig({ apiKey: "legacy-key", showNsfw: true });
    const raw = await readFile(path.join(configDir, "civitai.json"), "utf-8");
    expect(raw).not.toContain("legacy-key");
    expect(raw).toContain("encryptedApiKey");
  });

  it("keeps using a pre-rename config dir until a new one exists (files not moved)", async () => {
    const root = await makeRoot();
    const legacyDir = path.join(root, ".comfyjourney"); // legacy-name
    const fsp = await import("fs/promises");
    await fsp.mkdir(legacyDir, { recursive: true });
    await fsp.writeFile(
      path.join(legacyDir, "civitai.json"),
      JSON.stringify({ apiKey: "legacy-key", showNsfw: true }),
      "utf-8",
    );
    const { getCivitaiConfig, setCivitaiConfig, resolveConfigDir } = await loadConfigModule(root);

    expect(resolveConfigDir(root)).toBe(legacyDir);
    await expect(getCivitaiConfig()).resolves.toEqual({ apiKey: "legacy-key", showNsfw: true });
    await setCivitaiConfig({ apiKey: "legacy-key", showNsfw: false });
    expect((await readdir(legacyDir)).sort()).toEqual(["civitai.json", "civitai.key"]);
    await expect(stat(path.join(root, ".adrift"))).rejects.toThrow();
    await expect(getCivitaiConfig()).resolves.toEqual({ apiKey: "legacy-key", showNsfw: false });

    await fsp.mkdir(path.join(root, ".adrift"));
    expect(resolveConfigDir(root)).toBe(path.join(root, ".adrift"));
  });

  it("prefers stored API key and falls back to environment key", async () => {
    const root = await makeRoot();
    const { getCivitaiApiKey, setCivitaiConfig } = await loadConfigModule(root);

    await expect(getCivitaiApiKey()).resolves.toBe("env-fallback-key");

    await setCivitaiConfig({ apiKey: "stored-key" });
    await expect(getCivitaiApiKey()).resolves.toBe("stored-key");

    await setCivitaiConfig({ apiKey: "" });
    await expect(getCivitaiApiKey()).resolves.toBe("env-fallback-key");
  });
});

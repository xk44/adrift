import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  isTrainingPathSetting,
  sanitizeTrainingSettings,
} from "@/lib/training/local/schema";

let dir = "";

/** A fake trainer clone + venv python + model files (nothing is executed). */
function fakeMusubi() {
  const repo = path.join(dir, "musubi-tuner");
  for (const rel of [
    "src/musubi_tuner/krea2_cache_latents.py",
    "src/musubi_tuner/krea2_cache_text_encoder_outputs.py",
    "src/musubi_tuner/krea2_train_network.py",
  ]) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), "");
  }
  const py = path.join(repo, ".venv/bin/python");
  fs.mkdirSync(path.dirname(py), { recursive: true });
  fs.writeFileSync(py, "");
  fs.chmodSync(py, 0o755);
  const models: Record<string, string> = {};
  for (const k of ["krea2Dit", "krea2TextEncoder", "krea2Vae"]) {
    models[k] = path.join(dir, `${k}.safetensors`);
    fs.writeFileSync(models[k], "");
  }
  return { repo, py, models };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cj-train-settings-"));
  vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", path.join(dir, "rt.json"));
  vi.stubEnv("ADMIN_API_KEY", "");
  vi.resetModules();
  vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/rateLimit");
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("training settings schema", () => {
  it("accepts only absolute / home paths without control characters", () => {
    for (const ok of ["/opt/x", "~/x", "C:\\x", "\\\\server\\share"])
      expect(isTrainingPathSetting(ok)).toBe(true);
    for (const bad of ["x", "./x", "../x", " /x", "/x\n", "", 5, null, "~x"])
      expect(isTrainingPathSetting(bad)).toBe(false);
  });

  it("sanitize drops unknown backends, keys and bad paths", () => {
    expect(
      sanitizeTrainingSettings({
        backends: {
          "musubi-tuner": { repoPath: "/r", pythonBin: "rel", extra: "/x" },
          evil: { repoPath: "/e" },
        },
        models: { krea2Dit: "/d", bogus: "/b" },
      }),
    ).toEqual({
      backends: { "musubi-tuner": { repoPath: "/r" } },
      models: { krea2Dit: "/d" },
    });
    expect(sanitizeTrainingSettings({})).toBeUndefined();
  });
});

describe("parseTrainingSettingsInput", () => {
  it("validates existence: repo folder, executable python, model files", async () => {
    const { parseTrainingSettingsInput, TrainingSettingsError } =
      await import("@/lib/training/local/config");
    const f = fakeMusubi();
    expect(
      parseTrainingSettingsInput({
        backends: { "musubi-tuner": { repoPath: f.repo, pythonBin: f.py } },
        models: f.models,
      }),
    ).toEqual({
      backends: { "musubi-tuner": { repoPath: f.repo, pythonBin: f.py } },
      models: f.models,
    });
    const notExe = path.join(dir, "py");
    fs.writeFileSync(notExe, "");
    fs.chmodSync(notExe, 0o644);
    const cases: unknown[] = [
      { backends: { "musubi-tuner": { repoPath: path.join(dir, "nope") } } },
      { backends: { "musubi-tuner": { repoPath: f.py } } },
      { backends: { "musubi-tuner": { pythonBin: notExe } } },
      { backends: { "musubi-tuner": { repoPath: "relative/path" } } },
      { backends: { other: { repoPath: f.repo } } },
      { models: { krea2Dit: path.join(dir, "missing.safetensors") } },
      { models: { notAKey: f.models.krea2Dit } },
      [],
    ];
    for (const c of cases)
      expect(() => parseTrainingSettingsInput(c)).toThrow(
        TrainingSettingsError,
      );
    expect(
      parseTrainingSettingsInput({
        backends: { "musubi-tuner": { repoPath: "", pythonBin: null } },
      }),
    ).toEqual({});
  });
});

const req = (
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  new NextRequest("http://localhost:3000/api/settings/training", {
    method,
    headers: {
      host: "localhost:3000",
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("/api/settings/training", () => {
  it("saves validated paths and reports krea2 ready", async () => {
    const f = fakeMusubi();
    const { GET, PUT } = await import("@/app/api/settings/training/route");
    const empty = await (await GET(req("GET"))).json();
    expect(empty.backends.map((b: { id: string }) => b.id)).toEqual([
      "musubi-tuner",
      "ai-toolkit",
    ]);
    expect(empty.backends[0].setup).toContain(
      "git clone https://github.com/kohya-ss/musubi-tuner",
    );

    const res = await PUT(
      req("PUT", {
        training: {
          backends: { "musubi-tuner": { repoPath: f.repo, pythonBin: f.py } },
          models: f.models,
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const musubi = body.backends.find(
      (b: { id: string }) => b.id === "musubi-tuner",
    );
    expect(musubi.problems).toEqual([]);
    expect(
      musubi.families.find((x: { family: string }) => x.family === "krea2")
        .ready,
    ).toBe(true);
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, "rt.json"), "utf8"),
    );
    expect(onDisk.training.backends["musubi-tuner"].repoPath).toBe(f.repo);

    const { readyFamilies } = await import("@/lib/training/local/config");
    expect(readyFamilies()).toEqual(["krea2"]);
  });

  it("rejects a bad path with 400 and the field", async () => {
    const { PUT } = await import("@/app/api/settings/training/route");
    const res = await PUT(
      req("PUT", {
        training: {
          backends: { "musubi-tuner": { repoPath: path.join(dir, "missing") } },
        },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe("musubi-tuner.repoPath");
    expect(fs.existsSync(path.join(dir, "rt.json"))).toBe(false);
  });

  it("refuses cross-origin writes", async () => {
    const { PUT } = await import("@/app/api/settings/training/route");
    const res = await PUT(
      req("PUT", { training: {} }, { origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
  });

  it("caps the body size", async () => {
    const { PUT } = await import("@/app/api/settings/training/route");
    const res = await PUT(
      req("PUT", { training: {}, pad: "x".repeat(40_000) }),
    );
    expect(res.status).toBe(413);
  });

  it("detect checks the saved paths only (commit null outside git)", async () => {
    const f = fakeMusubi();
    fs.mkdirSync(path.join(f.repo, "src/musubi_tuner/krea2"), { recursive: true });
    fs.writeFileSync(
      path.join(f.repo, "src/musubi_tuner/krea2/krea2_mmdit.py"),
      "class LastLayer: pass\n",
    );
    const rt = await import("@/lib/runtimeSettings");
    rt.writeTrainingSettings({
      backends: { "musubi-tuner": { repoPath: f.repo, pythonBin: f.py } },
      models: f.models,
    });
    const { POST } = await import("@/app/api/settings/training/detect/route");
    const res = await POST(
      new NextRequest("http://localhost:3000/api/settings/training/detect", {
        method: "POST",
        headers: { host: "localhost:3000" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const musubi = body.backends.find(
      (b: { id: string }) => b.id === "musubi-tuner",
    );
    expect(musubi.ok).toBe(true);
    expect(musubi.commit).toBeNull();
    expect(musubi.warnings.join(" ")).toMatch(/last-layer/);
    const aitk = body.backends.find(
      (b: { id: string }) => b.id === "ai-toolkit",
    );
    expect(aitk.ok).toBe(false);
  });
});

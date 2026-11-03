/**
 * GPU smoke manifest integrity (scripts/gpu-smoke): ids, registry links,
 * preset ids, asset placeholders, offline graph builds and the --run guard.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Graphs with a `_fallback` ask /object_info; keep the build offline.
vi.mock("@/lib/comfy/objectInfoCache", async (orig) => ({
  ...(await orig<typeof import("@/lib/comfy/objectInfoCache")>()),
  getObjectInfoCached: vi.fn(async () => null),
}));

import registry from "@/lib/oj/registry.json";
import { ACTION_BUILDERS } from "@/lib/oj/actionBuilders";
import { CAMERA_PRESETS } from "@/lib/oj/h3Video";
import {
  WAN_CAMERA_POSES,
  WAN_LENGTHS,
  WAN_MODES,
  WAN_RESOLUTIONS,
  getWanMotionPreset,
} from "@/lib/oj/wanMotionPresets";
import { ASMR_SOUNDS } from "@/lib/tools/asmrPresets";
import { getEditTool } from "@/lib/tools/editTools";
import {
  SMOKE_ASSETS,
  drawGradient,
  drawShapes,
  drawSticker,
  encodePng,
  encodeWav,
  clearSmokeSourceOverrides,
  setSmokeSourceOverride,
  smokeAssetRef,
  synthToneSamples,
  SMOKE_SAMPLE_RATE,
} from "../../scripts/gpu-smoke/assets";
import { buildSmokeGraph, smokeSeedRun } from "../../scripts/gpu-smoke/build";
import {
  checkRunGuard,
  parseSmokeArgs,
  selectEntry,
} from "../../scripts/gpu-smoke/cli";
import {
  ASSET_PLACEHOLDER,
  SMOKE_ASMR_PRESET,
  SMOKE_CONTEXT_ONLY,
  SMOKE_DEFERRED,
  SMOKE_MANIFEST,
  applySmokeParamOverride,
  coveredIds,
  parityPendingIds,
} from "../../scripts/gpu-smoke/manifest";
import { FATAL_GPU_RE, stripAvailable } from "../../scripts/gpu-smoke/runner";

const ACTIONS = registry.actions as Record<string, { template?: string }>;
const DOCS = path.join(__dirname, "../../docs");
// The public export ships the parity table as docs/HIGGSFIELD.md.
const parityFile = ["higgsfield-parity.md", "HIGGSFIELD.md"]
  .map((f) => path.join(DOCS, f))
  .find((p) => fs.existsSync(p));
const parity = fs.readFileSync(
  parityFile ?? path.join(DOCS, "higgsfield-parity.md"),
  "utf8",
);
const toolsDoc = fs.readFileSync(path.join(DOCS, "TOOLS.md"), "utf8");

function placeholders(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string" && v.startsWith(ASSET_PLACEHOLDER)) out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => placeholders(x, out));
  else if (v && typeof v === "object")
    Object.values(v).forEach((x) => placeholders(x, out));
  return out;
}

describe("gpu smoke manifest", () => {
  it("has unique ids, valid kinds and a parity source per entry", () => {
    const ids = SMOKE_MANIFEST.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const extra = [...SMOKE_DEFERRED.map((d) => d.id), ...SMOKE_CONTEXT_ONLY];
    expect(new Set([...ids, ...extra]).size).toBe(ids.length + extra.length);
    for (const e of SMOKE_MANIFEST) {
      expect(["image", "video", "audio", "text"]).toContain(e.expect);
      expect(e.parity.length).toBeGreaterThan(5);
    }
  });

  it("points every action at a registry template and every tool at the edit registry", () => {
    for (const e of SMOKE_MANIFEST) {
      if (e.kind === "action") {
        expect(ACTIONS[e.action]?.template, e.id).toBeTruthy();
        expect(Object.hasOwn(ACTION_BUILDERS, e.action), e.id).toBe(true);
        expect(
          parity.includes(e.action) || toolsDoc.includes(e.toolsDoc ?? "\0"),
          e.id,
        ).toBe(true);
      } else {
        const tool = getEditTool(e.toolId);
        expect(tool, e.id).toBeDefined();
        expect(e.images.length).toBe(tool!.refCount);
        expect(parity.includes(e.toolId), e.id).toBe(true);
      }
    }
  });

  it("names real TOOLS.md cards", () => {
    for (const e of SMOKE_MANIFEST) {
      if (e.toolsDoc) expect(toolsDoc, e.id).toContain(`| ${e.toolsDoc} |`);
    }
  });

  it("uses preset / enum ids that exist (lookups fall back silently)", () => {
    const has = <T extends { id: string }>(list: readonly T[], id: unknown) =>
      list.some((x) => x.id === id);
    for (const e of SMOKE_MANIFEST) {
      if (e.kind !== "action") continue;
      const p = e.params;
      if (e.action === "wan_motion") {
        expect(getWanMotionPreset(p.preset).id, e.id).toBe(p.preset);
      }
      if (e.action === "wan_motion" || e.action === "wan_camera") {
        expect(has(WAN_MODES, p.mode), e.id).toBe(true);
        expect(has(WAN_RESOLUTIONS, p.resolution), e.id).toBe(true);
        expect(has(WAN_LENGTHS, p.duration), e.id).toBe(true);
        expect(p.resolution).toBe("480p");
        expect(p.mode).toBe("fast");
      }
      if (e.action === "wan_camera")
        expect(has(WAN_CAMERA_POSES, p.camera), e.id).toBe(true);
      if (e.action === "camera_move")
        expect(has(CAMERA_PRESETS, p.cameraMove), e.id).toBe(true);
    }
    const asmr = ASMR_SOUNDS.find((s) => s.id === SMOKE_ASMR_PRESET);
    expect(asmr?.phrase).toBeTruthy();
    const add = SMOKE_MANIFEST.find((e) => e.id === "action.add_sound");
    expect(add?.kind === "action" && add.params.prompt).toBe(asmr!.phrase);
  });

  it("only references assets that exist, and seeds clip/image sources", () => {
    for (const e of SMOKE_MANIFEST) {
      const refs = placeholders(e.kind === "action" ? e.params : e.options);
      for (const r of refs) {
        expect(Object.keys(SMOKE_ASSETS), e.id).toContain(
          r.slice(ASSET_PLACEHOLDER.length),
        );
      }
      if (e.kind === "action" && e.source !== "text") {
        expect(SMOKE_ASSETS[e.source].kind).not.toBe("audio");
      }
    }
    expect(smokeAssetRef("clip")).toBe(
      "adrift_smoke/adrift_smoke_clip.mp4 [input]",
    );
    const run = smokeSeedRun("clip", "http://203.0.113.5:8188");
    expect(run.jobs[0].videos?.[0]).toContain("subfolder=adrift_smoke");
    expect(run.params.video_seconds).toBe(1);
  });

  it("--source points a source id at real footage in ComfyUI input/", () => {
    try {
      setSmokeSourceOverride("clip=tests/street.mp4@1280x720:3");
      expect(smokeAssetRef("clip")).toBe("tests/street.mp4 [input]");
      const run = smokeSeedRun("clip", "http://203.0.113.5:8188");
      const url = new URL(run.jobs[0].videos?.[0] ?? "");
      expect(url.searchParams.get("filename")).toBe("street.mp4");
      expect(url.searchParams.get("subfolder")).toBe("tests");
      expect([run.width, run.height, run.params.video_seconds]).toEqual([1280, 720, 3]);
      setSmokeSourceOverride("gradient=photo.png");
      expect(smokeAssetRef("gradient")).toBe("photo.png [input]");
      expect(smokeSeedRun("gradient", "http://203.0.113.5:8188").width).toBe(256);
      for (const bad of ["clip", "nope=x.mp4", "clip=../x.mp4", "clip=a//b.mp4", "=x.mp4"])
        expect(() => setSmokeSourceOverride(bad), bad).toThrow();
      expect(parseSmokeArgs(["--source", "clip=a.mp4"], {}).sources).toEqual(["clip=a.mp4"]);
    } finally {
      clearSmokeSourceOverrides();
    }
    expect(smokeAssetRef("clip")).toBe("adrift_smoke/adrift_smoke_clip.mp4 [input]");
  });

  it("--param overrides one entry param for a quality pass", () => {
    const entry = SMOKE_MANIFEST.find((e) => e.id === "action.video_object_remove");
    if (!entry || entry.kind !== "action") throw new Error("missing entry");
    const before = entry.params;
    try {
      applySmokeParamOverride("action.video_object_remove:target=red car");
      applySmokeParamOverride("action.video_object_remove:seed=7");
      expect(entry.params).toMatchObject({ target: "red car", seed: 7, speed: "fast" });
      for (const bad of ["nope:target=x", "action.video_object_remove", "action.video_object_remove:=x"])
        expect(() => applySmokeParamOverride(bad), bad).toThrow();
      expect(parseSmokeArgs(["--param", "a:b=c"], {}).params).toEqual(["a:b=c"]);
    } finally {
      entry.params = before;
    }
  });

  it("builds every entry offline through the app's builders", async () => {
    for (const e of SMOKE_MANIFEST) {
      const built = await buildSmokeGraph(e, {
        comfyUrl: "http://203.0.113.5:8188",
      });
      const json = JSON.stringify(built.workflow);
      expect(Object.keys(built.workflow).length, e.id).toBeGreaterThan(0);
      expect(json, e.id).not.toContain(ASSET_PLACEHOLDER);
      expect(json, e.id).not.toContain("203.0.113.5");
      if (e.kind === "action" && e.source !== "text") {
        expect(json, e.id).toContain(smokeAssetRef(e.source));
      }
    }
  });

  it("extracts pending ids from parity text and accounts for them", () => {
    const fixture = [
      "| 1 | x | `foo_bar` done, GPU-checked |",
      "| 2 | y | `video_bg_change` HAVE. GPU run pending |",
      "| 3 | z | `overlay_composite` Not GPU-validated yet |",
    ].join("\n");
    expect(parityPendingIds(fixture).sort()).toEqual([
      "overlay_composite",
      "video_bg_change",
    ]);
    const covered = coveredIds();
    for (const id of [
      "qwen21-remove-bg",
      "dub_mux",
      "melt",
      "clipcut",
      "vace_restyle",
    ])
      expect(covered.has(id), id).toBe(true);
  });
});

describe("gpu smoke cli", () => {
  it("defaults to dry-run and refuses --run without ADRIFT_GPU_OK=1", () => {
    const dry = parseSmokeArgs([], {});
    expect(dry.mode).toBe("dry-run");
    expect(checkRunGuard(dry, {}).ok).toBe(true);
    const run = parseSmokeArgs(["--run"], {});
    expect(checkRunGuard(run, {}).ok).toBe(false);
    expect(checkRunGuard(run, { ADRIFT_GPU_OK: "true" }).ok).toBe(false);
    expect(checkRunGuard(run, { ADRIFT_GPU_OK: "1" }).ok).toBe(true);
    expect(() => parseSmokeArgs(["--run", "--dry-run"], {})).toThrow();
    expect(() => parseSmokeArgs(["--bogus"], {})).toThrow();
  });

  it("parses the comfy url, filters and prefix selection", () => {
    const a = parseSmokeArgs(
      [
        "--comfy",
        "http://203.0.113.7:8188/",
        "--only",
        "action.dub,tool.",
        "--skip",
        "action.dub_mux",
      ],
      {},
    );
    expect(a.comfyUrl).toBe("http://203.0.113.7:8188");
    expect(selectEntry("action.dub_voice", a)).toBe(true);
    expect(selectEntry("action.dub_mux", a)).toBe(false);
    expect(selectEntry("action.music", a)).toBe(false);
    expect(
      parseSmokeArgs([], { COMFY_HTTP_URL: "http://203.0.113.8:8188" })
        .comfyUrl,
    ).toBe("http://203.0.113.8:8188");
    expect(() => parseSmokeArgs(["--comfy", "203.0.113.7"], {})).toThrow();
  });
});

describe("gpu smoke runner helpers", () => {
  it("treats driver / device errors as fatal, ordinary node errors not", () => {
    expect(FATAL_GPU_RE.test("NVRM: Xid 158 GSP timeout")).toBe(true);
    expect(
      FATAL_GPU_RE.test("CUDA error: an illegal memory access was encountered"),
    ).toBe(true);
    expect(
      FATAL_GPU_RE.test("torch.OutOfMemoryError: CUDA out of memory"),
    ).toBe(true);
    expect(FATAL_GPU_RE.test("KSampler #3: shape mismatch")).toBe(false);
  });

  it("drops combo listings from reported problems", () => {
    expect(
      stripAvailable(
        'X (#1) / unet_name: Value "a" is not an available option (available: b, c, … (9 total))',
      ),
    ).toBe('X (#1) / unet_name: Value "a" is not an available option');
  });
});

describe("gpu smoke assets", () => {
  it("encodes valid PNG and WAV headers", () => {
    const png = encodePng(256, 256, 3, drawGradient(256, 256));
    expect([...png.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(png.readUInt32BE(16)).toBe(256);
    const rgba = encodePng(64, 64, 4, drawSticker(64));
    expect(rgba[25]).toBe(6); // colour type RGBA
    expect(encodePng(384, 256, 3, drawShapes(384, 256)).readUInt32BE(16)).toBe(
      384,
    );
    const wav = encodeWav(synthToneSamples(2), SMOKE_SAMPLE_RATE);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(40)).toBe(2 * SMOKE_SAMPLE_RATE * 2);
    expect(() => encodePng(2, 2, 3, new Uint8Array(3))).toThrow();
  });

  it("keeps the assets tiny", () => {
    for (const a of Object.values(SMOKE_ASSETS) as Array<{
      width?: number;
      seconds?: number;
    }>) {
      expect(a.width ?? 0).toBeLessThanOrEqual(512);
      expect(a.seconds ?? 0).toBeLessThanOrEqual(2);
    }
  });
});

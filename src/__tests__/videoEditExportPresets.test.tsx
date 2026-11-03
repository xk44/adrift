/** Export presets and formats: settings parsing, preset matching, encoder argv and real WebM / ProRes encodes. */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/hooks/useNavSync", () => ({ navigateTo: vi.fn() }));

import {
  DEFAULT_EXPORT,
  parseExportSettings,
} from "@/lib/videoEdit/requests";
import {
  EXPORT_PRESETS,
  matchExportPreset,
  presetFrame,
} from "@/lib/videoEdit/exportPresets";
import {
  buildProbeArgs,
  buildRenderArgs,
  parseProbe,
  type RenderInput,
} from "@/lib/videoEdit/ffmpegArgs";
import { exportEncoding, renderTimeoutMs } from "@/lib/videoEdit/server";
import type { VideoSource } from "@/lib/videoEdit/editList";
import { workMediaUrl } from "@/lib/videoEdit/sourceRef";
import { useVideoEditStore } from "@/store/videoEditStore";
import { ExportSettingsBox } from "@/components/editor/video/VideoClipPanel";
import { VideoExportPanel } from "@/components/editor/video/VideoPanels";

describe("parseExportSettings", () => {
  it("reads settings saved before formats existed as MP4", () => {
    expect(
      parseExportSettings({ resolution: "1080", fps: 24, quality: "high" }),
    ).toEqual({
      ok: true,
      value: { resolution: "1080", fps: 24, quality: "high", format: "mp4" },
    });
    expect(parseExportSettings(undefined)).toEqual({
      ok: true,
      value: DEFAULT_EXPORT,
    });
  });

  it("accepts 4K, 60 fps and the new formats; rejects others", () => {
    expect(
      parseExportSettings({ resolution: "2160", fps: 60, format: "prores" }),
    ).toMatchObject({ ok: true, value: { resolution: "2160", fps: 60, format: "prores" } });
    expect(parseExportSettings({ format: "gif" })).toMatchObject({ ok: false });
    expect(parseExportSettings({ resolution: "4k" })).toMatchObject({ ok: false });
    expect(parseExportSettings({ fps: 25 })).toMatchObject({ ok: false });
  });

  it("loudness and ducking are opt-in booleans", () => {
    expect(parseExportSettings({ loudnorm: true, duck: true })).toMatchObject({
      ok: true,
      value: { loudnorm: true, duck: true },
    });
    const off = parseExportSettings({ loudnorm: false, duck: false });
    expect(off.ok && "loudnorm" in off.value).toBe(false);
    expect(off.ok && "duck" in off.value).toBe(false);
    expect(parseExportSettings({ loudnorm: "yes" })).toMatchObject({ ok: false });
    expect(parseExportSettings({ duck: 1 })).toMatchObject({ ok: false });
  });
});

describe("export presets", () => {
  it("every preset is valid and recognised as itself", () => {
    const ids = new Set<string>();
    for (const p of EXPORT_PRESETS) {
      expect(parseExportSettings(p.settings)).toEqual({ ok: true, value: p.settings });
      expect(matchExportPreset(p.settings, p.aspect ?? null)?.id).toBe(p.id);
      ids.add(p.id);
    }
    expect(ids.size).toBe(EXPORT_PRESETS.length);
  });

  it("vertical needs the 9:16 frame; ProRes ignores quality; others are custom", () => {
    const vertical = EXPORT_PRESETS.find((p) => p.id === "vertical")!;
    expect(matchExportPreset(vertical.settings, null)).toBeNull();
    expect(
      matchExportPreset({ ...DEFAULT_EXPORT, format: "prores", quality: "small" }, null)?.id,
    ).toBe("prores");
    expect(matchExportPreset({ ...DEFAULT_EXPORT, fps: 60 }, null)).toBeNull();
  });
});

describe("presetFrame", () => {
  const by = (id: string) => EXPORT_PRESETS.find((p) => p.id === id)!;
  it("sets the preset's crop, and drops it when leaving that preset", () => {
    expect(presetFrame(by("vertical"), null, null)).toEqual({
      aspect: "9:16",
      x: 0.5,
      y: 0.5,
    });
    const v = { aspect: "9:16" as const, x: 0.3, y: 0.5 };
    expect(presetFrame(by("vertical"), by("web"), v)).toBeUndefined();
    expect(presetFrame(by("web"), by("vertical"), v)).toBeNull();
  });

  it("keeps a crop the user chose by hand", () => {
    const sq = { aspect: "1:1" as const, x: 0.5, y: 0.5 };
    expect(presetFrame(by("web"), null, sq)).toBeUndefined();
    expect(presetFrame(by("4k"), by("web"), sq)).toBeUndefined();
  });
});

describe("export encoding", () => {
  it("maps formats to codec, extension and quality", () => {
    expect(exportEncoding(DEFAULT_EXPORT)).toEqual({
      codec: "h264",
      ext: "mp4",
      preset: "slow",
      crf: 17,
    });
    expect(exportEncoding({ ...DEFAULT_EXPORT, format: "webm", quality: "small" })).toEqual({
      codec: "vp9",
      ext: "webm",
      crf: 36,
    });
    expect(exportEncoding({ ...DEFAULT_EXPORT, format: "prores" })).toEqual({
      codec: "prores",
      ext: "mov",
    });
  });

  it("gives 4K and VP9 more time", () => {
    const hd = renderTimeoutMs(10, 1920, 1080);
    expect(hd).toBe(140_000);
    expect(renderTimeoutMs(10, 3840, 2160)).toBe(380_000);
    expect(renderTimeoutMs(10, 1920, 1080, "vp9")).toBe(300_000);
    expect(renderTimeoutMs(10, 640, 360)).toBe(hd);
    expect(renderTimeoutMs(10_000, 3840, 2160, "vp9")).toBe(30 * 60_000);
  });

  const inputs: RenderInput[] = [{ path: "/w/a.mp4", in: 0, out: 2, audio: true }];
  const base = { width: 1920, height: 1080, fps: 24, withAudio: true };

  it("H.264 stays the default argv", () => {
    const a = buildRenderArgs(inputs, "/w/o.mp4", base);
    expect(a.join(" ")).toContain("-c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -c:a aac");
    expect(a.slice(-3)).toEqual(["-movflags", "+faststart", "/w/o.mp4"]);
  });

  it("ProRes is 10-bit 4:2:2 HQ with PCM sound", () => {
    const a = buildRenderArgs(inputs, "/w/o.mov", { ...base, codec: "prores" }).join(" ");
    expect(a).toContain("format=yuv422p10le");
    expect(a).toContain("-c:v prores_ks -profile:v 3");
    expect(a).toContain("-c:a pcm_s16le");
    expect(a).not.toContain("libx264");
  });

  it("VP9 uses constant quality, Opus, and no mp4 flags", () => {
    const a = buildRenderArgs(inputs, "/w/o.webm", {
      ...base,
      codec: "vp9",
      crf: 31,
      withAudio: false,
    });
    expect(a.join(" ")).toContain("-c:v libvpx-vp9 -crf 31 -b:v 0");
    expect(a).toContain("-an");
    expect(a).not.toContain("-movflags");
    expect(a.at(-1)).toBe("/w/o.webm");
  });
});

const ffmpeg = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
].find((p) => fs.existsSync(p));
const ffprobe = ffmpeg?.replace(/ffmpeg$/, "ffprobe");
const codecs = ffmpeg
  ? spawnSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? ""
  : "";
const canEncode =
  !!ffprobe && fs.existsSync(ffprobe) && codecs.includes("libvpx-vp9") && codecs.includes("prores_ks");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vedit-export-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!canEncode)("real WebM / ProRes exports", () => {
  const run = (bin: string, args: string[]) => {
    const r = spawnSync(bin, args, { encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) throw new Error(r.stderr.slice(-800));
    return r.stdout;
  };
  const probe = (p: string) => parseProbe(JSON.parse(run(ffprobe!, buildProbeArgs(p))))!;

  it("encodes both with sound at the requested frame", () => {
    const src = path.join(tmp, "src.mp4");
    run(ffmpeg!, [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", src,
    ]);
    const inp: RenderInput[] = [{ path: src, in: 0, out: 1, audio: true }];
    const opts = { width: 256, height: 144, fps: 24, withAudio: true, bt709: true };
    const webm = path.join(tmp, "o.webm");
    run(ffmpeg!, buildRenderArgs(inp, webm, { ...opts, codec: "vp9", crf: 36 }));
    expect(probe(webm)).toMatchObject({ videoCodec: "vp9", width: 256, height: 144, hasAudio: true });
    const mov = path.join(tmp, "o.mov");
    run(ffmpeg!, buildRenderArgs(inp, mov, { ...opts, codec: "prores" }));
    const pm = probe(mov);
    expect(pm).toMatchObject({ videoCodec: "prores", width: 256, hasAudio: true, fps: 24 });
    expect(pm.duration).toBeGreaterThan(0.9);
    expect(pm.duration).toBeLessThan(1.1);
  }, 60_000);
});

const S = () => useVideoEditStore.getState();
const render = (el: React.ReactElement) => {
  Object.assign(useVideoEditStore.getInitialState(), useVideoEditStore.getState());
  return renderToStaticMarkup(el);
};
const source: VideoSource = {
  url: workMediaUrl("uploads/a.mp4"),
  duration: 4,
  width: 1280,
  height: 720,
  fps: 24,
  hasAudio: true,
};

describe("export panel", () => {
  beforeEach(() => {
    S().closeProject();
    S().openProject(source, "Shot");
    S().setExportSettings({ ...DEFAULT_EXPORT });
  });

  it("shows presets, highlights the matching one, and names the format", () => {
    S().setExportSettings(EXPORT_PRESETS.find((p) => p.id === "web")!.settings);
    const box = render(<ExportSettingsBox />);
    expect(box).toContain('data-testid="video-export-presets"');
    expect(box).toMatch(/aria-pressed="true"[^>]*>Web 1080p</);
    expect(box).toContain("H.264 MP4 that plays everywhere.");
    expect(box).toMatch(/<option value="2160">4K \(2160p\)<\/option>/);

    S().setExportSettings({ format: "webm", quality: "small" });
    expect(render(<ExportSettingsBox />)).toContain("Custom settings.");
    expect(render(<VideoExportPanel />)).toContain("Export video (WebM)");

    S().setExportSettings({ format: "prores" });
    const pro = render(<ExportSettingsBox />);
    expect(pro).toMatch(/<select[^>]*disabled=""[^>]*title="ProRes 422 HQ has a fixed quality"/);
    expect(render(<VideoExportPanel />)).toContain("ProRes 422 HQ / PCM .mov");
  });
});

import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import type { ImagineRun, Workflow } from "@/types";
import { mp4VideoFps, normalizeFps } from "@/lib/videoFps";
import { VBC_NODES, buildVideoBgChangeWorkflow } from "@/lib/oj/videoBgChange";
import { submitVideoTool, withSourceFps } from "@/lib/tools/runTool";
import { defaultSettings, getActionTool } from "@/lib/tools/toolsPage";

// --- tiny ISO BMFF writer ---------------------------------------------------
const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const u64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const box = (type: string, ...payload: Uint8Array[]) => {
  const body = cat(...payload);
  return cat(u32(8 + body.length), ascii(type), body);
};
const hdlr = (handler: string) =>
  box("hdlr", u32(0), u32(0), ascii(handler), new Uint8Array(12));
const mdhd = (timescale: number, version: 0 | 1 = 0) =>
  version === 1
    ? box(
        "mdhd",
        u32(0x01000000),
        u64(0),
        u64(0),
        u32(timescale),
        u64(0),
        u32(0),
      )
    : box("mdhd", u32(0), u32(0), u32(0), u32(timescale), u32(0), u32(0));
const stts = (entries: [number, number][]) =>
  box(
    "stts",
    u32(0),
    u32(entries.length),
    ...entries.flatMap(([n, d]) => [u32(n), u32(d)]),
  );
const trak = (handler: string, md: Uint8Array, table: Uint8Array) =>
  box(
    "trak",
    box("tkhd", new Uint8Array(84)),
    box("mdia", md, hdlr(handler), box("minf", box("stbl", table))),
  );
const mp4 = (...traks: Uint8Array[]) =>
  cat(
    box("ftyp", ascii("isom"), u32(512)),
    box("mdat", new Uint8Array(32)),
    box("moov", box("mvhd", new Uint8Array(100)), ...traks),
  );

describe("mp4VideoFps", () => {
  it("reads 29.97 fps (30000/1001) from the video track, skipping audio", () => {
    const file = mp4(
      trak("soun", mdhd(48000), stts([[100, 1024]])),
      trak("vide", mdhd(30000), stts([[300, 1001]])),
    );
    expect(mp4VideoFps(file)).toBe(29.97);
    expect(mp4VideoFps(file.buffer)).toBe(29.97);
  });

  it("handles version 1 mdhd and multi-entry stts", () => {
    const file = mp4(
      trak(
        "vide",
        mdhd(12800, 1),
        stts([
          [47, 512],
          [1, 512],
        ]),
      ),
    );
    expect(mp4VideoFps(file)).toBe(25);
  });

  it("returns null for non-MP4 bytes, truncated files and no video", () => {
    expect(mp4VideoFps(ascii("\x1aE\xdf\xa3webm-ish"))).toBeNull();
    const good = mp4(trak("vide", mdhd(24), stts([[48, 1]])));
    expect(mp4VideoFps(good.slice(0, good.length - 10))).toBeNull();
    expect(
      mp4VideoFps(mp4(trak("soun", mdhd(48000), stts([[10, 1024]])))),
    ).toBeNull();
    expect(mp4VideoFps(new Uint8Array(0))).toBeNull();
  });

  it("normalizeFps rounds and range-checks", () => {
    expect(normalizeFps(23.976023976)).toBe(23.976);
    expect(normalizeFps(0.5)).toBeNull();
    expect(normalizeFps(240)).toBeNull();
    expect(normalizeFps("30")).toBeNull();
    expect(normalizeFps(Number.NaN)).toBeNull();
  });
});

// --- video_bg_change output fps --------------------------------------------
const bgGraph = (): Workflow =>
  JSON.parse(
    fs.readFileSync(
      path.join(
        process.cwd(),
        "public/workflows/packs/utility/video_bg_change.json",
      ),
      "utf8",
    ),
  );
const videoRun = (): ImagineRun =>
  ({
    run_id: "SRC",
    prompt: "",
    params: {},
    jobs: [
      {
        index: 0,
        seed: 7,
        videos: ["/api/comfy/view?filename=cj%2Fstreet.mp4&type=input"],
      },
    ],
  }) as unknown as ImagineRun;

describe("video_bg_change output fps follows the source", () => {
  const createFps = (params: Record<string, unknown>) =>
    buildVideoBgChangeWorkflow(bgGraph(), videoRun(), 0, {
      background: "blur",
      ...params,
    }).workflow[VBC_NODES.create].inputs.fps;

  it("encodes at the probed source fps", () => {
    expect(bgGraph()[VBC_NODES.create].class_type).toBe("CreateVideo");
    expect(createFps({ sourceFps: 29.97 })).toBe(29.97);
    expect(createFps({ sourceFps: 59.94 })).toBe(59.94);
  });

  it("falls back to the decoded clip's rate without a usable probe", () => {
    expect(createFps({})).toEqual(["3", 2]);
    expect(createFps({ sourceFps: "30" })).toEqual(["3", 2]);
    expect(createFps({ sourceFps: 0 })).toEqual(["3", 2]);
  });

  it("withSourceFps adds only a valid fps", () => {
    expect(withSourceFps({ a: 1 }, 24)).toEqual({ a: 1, sourceFps: 24 });
    expect(withSourceFps({ a: 1 }, null)).toEqual({ a: 1 });
    expect(withSourceFps({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it("the Tools runner sends the clip's fps with the action", async () => {
    const spec = getActionTool("video_bg_change")!;
    const settings = defaultSettings(spec);
    settings.picks = { ...settings.picks, background: "blur" };
    let actionBody: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (url === "/api/jobs/action") actionBody = body;
      const json =
        url === "/api/comfy/upload"
          ? { ok: true, ref: `cj/${body.filename} [input]` }
          : url === "/api/jobs/seed-run"
            ? { ok: true, run: { run_id: "R", jobs: [{ index: 0 }] } }
            : { ok: true, run: { run_id: "NEW", jobs: [] } };
      return { ok: true, status: 200, json: async () => json };
    });
    await submitVideoTool({
      fetchImpl,
      spec,
      settings,
      video: {
        id: "v",
        previewUrl: "blob:x",
        dataUrl: "data:video/mp4;base64,AAAA",
        label: "clip.mp4",
        duration: 4,
        width: 1280,
        height: 720,
        fps: 29.97,
      },
      face: null,
      clientId: "cid",
    });
    expect(actionBody).not.toBeNull();
    expect(
      (actionBody as unknown as { params: Record<string, unknown> }).params,
    ).toMatchObject({ background: "blur", sourceFps: 29.97 });
  });
});

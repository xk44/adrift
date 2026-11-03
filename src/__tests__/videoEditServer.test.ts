/**
 * Video editor server helpers: render lanes (429 / abort), child-process
 * cancellation, error redaction, work-dir housekeeping, encoder settings.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import {
  MAX_QUEUED,
  encodeSettings,
  inLane,
  lanePendingCount,
  redactPaths,
  runBinary,
  sweepWorkDir,
  VideoEditError,
} from "@/lib/videoEdit/server";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vedit-sweep-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe("redactPaths", () => {
  it("cuts absolute paths down to the file name", () => {
    expect(
      redactPaths(
        "exit 1 /Users/someone/data/video-edit/renders/abc.mp4: No such file",
      ),
    ).toBe("exit 1 abc.mp4: No such file");
    expect(redactPaths("C:\\Users\\x\\ComfyUI\\output\\a.mp4 failed")).toBe(
      "a.mp4 failed",
    );
    // Not paths: ratios, single segments, URLs keep their meaning.
    expect(redactPaths("fps 30000/1001 at /a")).toBe("fps 30000/1001 at /a");
  });
});

describe("render lanes", () => {
  it("runs one job per lane and refuses more than MAX_QUEUED waiting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const jobs = Array.from({ length: MAX_QUEUED + 1 }, () =>
      inLane("export", () => gate),
    );
    expect(lanePendingCount("export")).toBe(MAX_QUEUED + 1);
    await expect(inLane("export", async () => 1)).rejects.toMatchObject({
      status: 429,
    });
    // Cuts have their own lane: not blocked by exports.
    await expect(inLane("cut", async () => "cut")).resolves.toBe("cut");
    release();
    await Promise.all(jobs);
    expect(lanePendingCount("export")).toBe(0);
  });

  it("skips a queued job whose request was aborted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = inLane("cut", () => gate);
    const ac = new AbortController();
    let ran = false;
    const second = inLane(
      "cut",
      async () => {
        ran = true;
      },
      ac.signal,
    );
    ac.abort();
    release();
    await first;
    await expect(second).rejects.toBeInstanceOf(VideoEditError);
    expect(ran).toBe(false);
  });
});

describe("runBinary", () => {
  it("kills the child when the signal aborts", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runBinary(
      process.execPath,
      ["-e", "setTimeout(()=>{},10000)"],
      20_000,
      {
        signal: ac.signal,
      },
    );
    setTimeout(() => ac.abort(), 50);
    await expect(p).resolves.toEqual({ ok: false, error: "cancelled" });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("does not start when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runBinary(process.execPath, ["-e", ""], 5000, { signal: ac.signal }),
    ).resolves.toEqual({ ok: false, error: "cancelled" });
  });

  it("redacts paths in failure text", async () => {
    const r = await runBinary(
      process.execPath,
      [
        "-e",
        "console.error('/very/secret/place/file.mp4: bad'); process.exit(3)",
      ],
      10_000,
    );
    expect(r).toEqual({ ok: false, error: "exit 3 file.mp4: bad" });
  });
});

describe("sweepWorkDir", () => {
  const put = (area: string, name: string, ageH: number, bytes = 10) => {
    const dir = path.join(tmpRoot, area);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name);
    fs.writeFileSync(f, Buffer.alloc(bytes));
    const t = (Date.now() - ageH * 3_600_000) / 1000;
    fs.utimesSync(f, t, t);
    return f;
  };

  it("drops files past their area's age and keeps the rest", () => {
    const oldRender = put("renders", "a.mp4", 72);
    const newRender = put("renders", "b.mp4", 1);
    const upload = put("uploads", "c.mp4", 72); // uploads live 14 days
    const stray = path.join(tmpRoot, "keep.txt");
    fs.writeFileSync(stray, "x");
    expect(sweepWorkDir(Date.now(), tmpRoot)).toBe(1);
    expect(fs.existsSync(oldRender)).toBe(false);
    expect(fs.existsSync(newRender)).toBe(true);
    expect(fs.existsSync(upload)).toBe(true);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it("trims the oldest derived files when over the size cap", () => {
    const a = put("cache", "old.mp4", 5, 1000);
    const b = put("thumbs", "mid.jpg", 3, 1000);
    const c = put("renders", "fresh.mp4", 0.1, 1000); // under an hour: kept
    sweepWorkDir(Date.now(), tmpRoot, 1500);
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    expect(fs.existsSync(c)).toBe(true);
  });
});

describe("encodeSettings", () => {
  it("keeps tool cuts near-lossless and exports at delivery quality", () => {
    expect(encodeSettings("range")).toEqual({ preset: "fast", crf: 12 });
    expect(encodeSettings("mp4")).toEqual({ preset: "slow", crf: 17 });
    expect(encodeSettings("mp4", "balanced")).toEqual({ preset: "medium", crf: 20 });
    expect(encodeSettings("mp4", "small")).toEqual({ preset: "medium", crf: 24 });
    // Tool cuts ignore the export quality.
    expect(encodeSettings("range", "small")).toEqual({ preset: "fast", crf: 12 });
  });
});

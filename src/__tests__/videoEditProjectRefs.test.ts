/** Video editor housekeeping: uploads a saved project uses are never swept. */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepWorkDir } from "@/lib/videoEdit/server";
import {
  REF_KEEP_DAYS,
  parseRefKeepDays,
  parseRefsRequest,
  projectRefsSummary,
  refMaxAgeMs,
  referencedUploads,
  releaseStaleProjectRefs,
  writeProjectRefs,
} from "@/lib/videoEdit/projectRefs";
import { uploadFilesInEdit } from "@/lib/videoEdit/sourceRef";
import {
  installProjectRefsSync,
  projectRefsChange,
} from "@/lib/videoEdit/projectRefsSync";

const H = 3_600_000;
const D = 24 * H;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vedit-refs-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const put = (file: string, ageMs: number, bytes = 10) => {
  const abs = path.join(root, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.alloc(bytes));
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(abs, t, t);
  return abs;
};
const exists = (abs: string) => fs.existsSync(abs);

describe("sweepWorkDir: uploads", () => {
  it("never ages out uploads; derived areas still age out", () => {
    const up = put("uploads/old.mp4", 400 * D);
    const render = put("renders/r1.mp4", 3 * D);
    const cut = put("renders/cut1.mp4", 49 * H);
    const strip = put("thumbs/s1.jpg", 8 * D);
    const cache = put("cache/c1.mp4", 8 * D);
    expect(sweepWorkDir(Date.now(), root)).toBe(4);
    expect(exists(up)).toBe(true);
    for (const f of [render, cut, strip, cache]) expect(exists(f)).toBe(false);
  });

  it("over the cap: derived first, then unreferenced uploads oldest first; referenced uploads stay", () => {
    const used = put("uploads/used1.mp4", 30 * D, 1000);
    const oldFree = put("uploads/free1.mp4", 20 * D, 1000);
    const newFree = put("uploads/free2.mp4", 10 * D, 1000);
    const cache = put("cache/c1.mp4", 2 * D, 1000);
    writeProjectRefs(root, {
      projectId: "project-aaaa",
      files: ["uploads/used1.mp4"],
    });
    // 4000 bytes, cap 2500: cache goes, then the oldest unused upload.
    sweepWorkDir(Date.now(), root, 2500);
    expect(exists(cache)).toBe(false);
    expect(exists(oldFree)).toBe(false);
    expect(exists(newFree)).toBe(true);
    expect(exists(used)).toBe(true);
  });

  it("keeps referenced uploads even when that leaves the dir over the cap", () => {
    const a = put("uploads/keep1.mp4", 60 * D, 1000);
    const b = put("uploads/keep2.mp4", 50 * D, 1000);
    writeProjectRefs(root, {
      projectId: "project-bbbb",
      files: ["uploads/keep1.mp4", "uploads/keep2.mp4"],
    });
    sweepWorkDir(Date.now(), root, 100);
    expect(exists(a)).toBe(true);
    expect(exists(b)).toBe(true);
  });

  it("leaves an upload from the last hour (not registered yet)", () => {
    const fresh = put("uploads/fresh1.mp4", 10 * 60_000, 1000);
    sweepWorkDir(Date.now(), root, 100);
    expect(exists(fresh)).toBe(true);
  });

  it("by default a project never opened again keeps pinning its uploads", () => {
    const up = put("uploads/kept1.mp4", 2000 * D, 1000);
    writeProjectRefs(
      root,
      { projectId: "project-ffff", files: ["uploads/kept1.mp4"] },
      Date.now() - 1500 * D,
    );
    // No setting saved: the sweep's default is forever.
    vi.stubEnv("ADRIFT_RUNTIME_SETTINGS_FILE", path.join(root, "none.json"));
    try {
      sweepWorkDir(Date.now(), root, 100);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(exists(up)).toBe(true);
    expect(fs.existsSync(path.join(root, "projects/project-ffff.json"))).toBe(
      true,
    );
  });

  it.each(REF_KEEP_DAYS)(
    "with a %i-day limit an abandoned project stops pinning its uploads",
    (days) => {
      const gone = put("uploads/gone1.mp4", 2000 * D, 1000);
      const kept = put("uploads/kept2.mp4", 2000 * D, 1000);
      writeProjectRefs(
        root,
        { projectId: "project-cccc", files: ["uploads/gone1.mp4"] },
        Date.now() - (days + 1) * D,
      );
      writeProjectRefs(
        root,
        { projectId: "project-gggg", files: ["uploads/kept2.mp4"] },
        Date.now() - (days - 1) * D,
      );
      sweepWorkDir(Date.now(), root, 100, refMaxAgeMs(days));
      expect(exists(gone)).toBe(false);
      expect(exists(kept)).toBe(true);
      expect(
        fs.existsSync(path.join(root, "projects/project-cccc.json")),
      ).toBe(false);
    },
  );
});

describe("project refs", () => {
  it("registers, refreshes and releases a project's uploads", () => {
    writeProjectRefs(root, {
      projectId: "project-dddd",
      files: ["uploads/a1.mp4"],
    });
    writeProjectRefs(root, {
      projectId: "project-eeee",
      files: ["uploads/b1.mov"],
    });
    expect([...referencedUploads(root)].sort()).toEqual([
      "uploads/a1.mp4",
      "uploads/b1.mov",
    ]);
    writeProjectRefs(root, { projectId: "project-dddd", files: [] });
    expect([...referencedUploads(root)]).toEqual(["uploads/b1.mov"]);
  });

  it("never expires entries without a max age; expires them with one", () => {
    const now = Date.now();
    writeProjectRefs(
      root,
      { projectId: "project-old1", files: ["uploads/o1.mp4"] },
      now - 1000 * D,
    );
    expect([...referencedUploads(root, now)]).toEqual(["uploads/o1.mp4"]);
    expect([...referencedUploads(root, now, null)]).toEqual([
      "uploads/o1.mp4",
    ]);
    expect(referencedUploads(root, now, refMaxAgeMs(365)).size).toBe(0);
    expect(fs.readdirSync(path.join(root, "projects"))).toEqual([]);
  });

  it("still clears dead .tmp writes with no max age", () => {
    const tmp = put("projects/project-x.json.ab12.tmp", 2 * H);
    const fresh = put("projects/project-y.json.cd34.tmp", 60_000);
    referencedUploads(root);
    expect(exists(tmp)).toBe(false);
    expect(exists(fresh)).toBe(true);
  });

  it("keep-days parsing: only 30 / 90 / 365, anything else is forever", () => {
    for (const d of REF_KEEP_DAYS) {
      expect(parseRefKeepDays(d)).toBe(d);
      expect(refMaxAgeMs(d)).toBe(d * D);
    }
    for (const bad of [null, undefined, 0, -30, 7, 31, "90", 90.5, NaN, {}])
      expect(parseRefKeepDays(bad)).toBeNull();
    expect(refMaxAgeMs(null)).toBeNull();
    expect(refMaxAgeMs(undefined)).toBeNull();
    expect(refMaxAgeMs(0)).toBeNull();
  });

  it("summarizes and releases stale projects by hand", () => {
    const now = Date.now();
    expect(projectRefsSummary(root)).toEqual({ projects: 0, oldestAt: null });
    writeProjectRefs(
      root,
      { projectId: "project-s100", files: ["uploads/a1.mp4"] },
      now - 100 * D,
    );
    writeProjectRefs(
      root,
      { projectId: "project-s010", files: ["uploads/b1.mp4"] },
      now - 10 * D,
    );
    expect(projectRefsSummary(root)).toEqual({
      projects: 2,
      oldestAt: now - 100 * D,
    });
    expect(releaseStaleProjectRefs(root, 90 * D, now)).toBe(1);
    expect([...referencedUploads(root, now)]).toEqual(["uploads/b1.mp4"]);
    expect(releaseStaleProjectRefs(root, 90 * D, now)).toBe(0);
    expect(releaseStaleProjectRefs(root, 5 * D, now)).toBe(1);
    expect(projectRefsSummary(root).projects).toBe(0);
  });

  it("ignores junk files in the refs dir", () => {
    fs.mkdirSync(path.join(root, "projects"), { recursive: true });
    fs.writeFileSync(path.join(root, "projects/bad.json"), "{nope");
    fs.writeFileSync(
      path.join(root, "projects/odd.json"),
      JSON.stringify({ at: Date.now(), files: ["../../etc/passwd", 3] }),
    );
    expect(referencedUploads(root).size).toBe(0);
  });

  it("validates requests", () => {
    expect(
      parseRefsRequest({ projectId: "abcd1234", files: ["uploads/x1.mp4"] }),
    ).toEqual({
      ok: true,
      value: { projectId: "abcd1234", files: ["uploads/x1.mp4"] },
    });
    expect(parseRefsRequest({ projectId: "abcd1234", files: [] }).ok).toBe(
      true,
    );
    for (const bad of [
      null,
      [],
      { projectId: "../x", files: [] },
      { projectId: "short", files: [] },
      { projectId: "abcd1234", files: "uploads/x1.mp4" },
      { projectId: "abcd1234", files: ["renders/x1.mp4"] },
      { projectId: "abcd1234", files: ["uploads/../x.mp4"] },
      { projectId: "abcd1234", files: Array(300).fill("uploads/x1.mp4") },
    ])
      expect(parseRefsRequest(bad).ok).toBe(false);
  });
});

describe("uploadFilesInEdit", () => {
  const clip = (url: string) => ({
    id: url,
    src: { url, duration: 2, width: 64, height: 64, fps: 24, hasAudio: true },
    in: 0,
    out: 2,
    muted: false,
    label: "",
  });
  it("lists each referenced upload once, skipping other sources", () => {
    const edit = {
      v: 1 as const,
      clips: [
        clip("/api/video-edit/media?f=uploads%2Fa1.mp4"),
        clip("/api/video-edit/media?f=uploads/a1.mp4"),
        clip("/api/video-edit/media?f=renders/r1.mp4"),
        clip("/api/comfy/image?filename=v.mp4&type=output"),
      ],
    };
    expect(uploadFilesInEdit(edit)).toEqual(["uploads/a1.mp4"]);
    expect(uploadFilesInEdit(null)).toEqual([]);
  });
});

describe("project refs sync (browser)", () => {
  const up = (n: string) => ({
    id: n,
    src: {
      url: `/api/video-edit/media?f=uploads/${n}.mp4`,
      duration: 2,
      width: 64,
      height: 64,
      fps: 24,
      hasAudio: true,
    },
    in: 0,
    out: 2,
    muted: false,
    label: "",
  });
  const edit = (...names: string[]) => ({
    v: 1 as const,
    clips: names.map(up),
  });

  it("plans releases and registrations", () => {
    const a = { projectId: "p-aaaaaaaa", edit: edit("a1") };
    expect(projectRefsChange({ projectId: null, edit: null }, a)).toEqual({
      register: { projectId: "p-aaaaaaaa", files: ["uploads/a1.mp4"] },
    });
    // Same uploads (e.g. a trim): nothing to send.
    expect(projectRefsChange(a, { ...a, edit: edit("a1", "a1") })).toEqual({});
    expect(projectRefsChange(a, { ...a, edit: edit("a1", "b1") })).toEqual({
      register: {
        projectId: "p-aaaaaaaa",
        files: ["uploads/a1.mp4", "uploads/b1.mp4"],
      },
    });
    expect(projectRefsChange(a, { projectId: null, edit: null })).toEqual({
      release: "p-aaaaaaaa",
    });
    expect(
      projectRefsChange(a, { projectId: "p-bbbbbbbb", edit: edit("b1") }),
    ).toEqual({
      release: "p-aaaaaaaa",
      register: { projectId: "p-bbbbbbbb", files: ["uploads/b1.mp4"] },
    });
  });

  it("registers a restored project, debounces edits, releases on close", () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => {});
      let listener: ((n: Snap, p: Snap) => void) | null = null;
      type Snap = Parameters<typeof projectRefsChange>[0];
      const a: Snap = { projectId: "p-aaaaaaaa", edit: edit("a1") };
      installProjectRefsSync(
        (fn) => {
          listener = fn;
          return () => {};
        },
        a,
        send,
      );
      vi.advanceTimersByTime(2000);
      expect(send).toHaveBeenCalledWith("p-aaaaaaaa", ["uploads/a1.mp4"]);
      send.mockClear();
      const b: Snap = { ...a, edit: edit("a1", "b1") };
      const c: Snap = { ...a, edit: edit("a1", "b1", "c1") };
      listener!(b, a);
      listener!(c, b);
      vi.advanceTimersByTime(2000);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenLastCalledWith("p-aaaaaaaa", [
        "uploads/a1.mp4",
        "uploads/b1.mp4",
        "uploads/c1.mp4",
      ]);
      listener!({ projectId: null, edit: null }, c);
      expect(send).toHaveBeenLastCalledWith("p-aaaaaaaa", []);
    } finally {
      vi.useRealTimers();
    }
  });
});

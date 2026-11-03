import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCATION_MAX,
  LOCATION_STORAGE_BUDGET,
  buildLocation,
  locationImage,
  sanitizeLocations,
  upsertLocation,
  validateLocationDraft,
  type SavedLocation,
} from "@/lib/tools/cinemaLocations";
import {
  CINEMA_LOCATIONS_KEY,
  safeLocationStorage,
  useCinemaLocationStore,
} from "@/store/cinemaLocationStore";
import {
  SCENE_STITCH_PREFIX,
  profileSceneCharacter,
  sceneStitchParams,
  sceneStitchState,
  shotClip,
} from "@/lib/tools/sceneStitch";
import { compileSceneShots, defaultScene } from "@/lib/tools/cinema";
import { STITCH_CLIPS_ACTION, stitchClipsCard } from "@/lib/tools/stitchClips";
import { runStitch } from "@/lib/tools/stitchRunner";
import type { ToolImage } from "@/lib/tools/runTool";
import type { ImagineJob, ImagineRun, JobStatus } from "@/types";

const upload = (bytes = 40): ToolImage => ({
  id: "upload:1",
  source: "upload",
  previewUrl: `data:image/jpeg;base64,${"A".repeat(bytes)}`,
  dataUrl: `data:image/jpeg;base64,${"A".repeat(bytes)}`,
  label: "harbor.jpg",
  width: 768,
  height: 512,
});

const gallery: ToolImage = {
  id: "gallery:run_1:0",
  source: "gallery",
  previewUrl: "/api/comfy/image?filename=harbor_00001_.png&type=output",
  label: "Harbor",
  width: 1024,
  height: 576,
  runId: "run_1",
  jobIndex: 0,
};

const videoUrl = (name: string) =>
  `/api/comfy/image?filename=${name}&subfolder=video&type=output`;

function job(status: JobStatus, videos?: string[]): ImagineJob {
  return {
    prompt_id: "p",
    seed: 1,
    index: 0,
    status,
    progress: status === "done" ? 1 : 0,
    images: [],
    ...(videos ? { videos } : {}),
  };
}

function run(id: string, j: ImagineJob, status: JobStatus = j.status) {
  return {
    run_id: id,
    prompt: "",
    parsedPrompt: "",
    width: 0,
    height: 0,
    jobs: [j],
    createdAt: "2026-10-25T00:00:00Z",
    status,
    params: {},
  } satisfies ImagineRun;
}

// ---------------------------------------------------------------------------
// Saved locations
// ---------------------------------------------------------------------------

describe("saved locations", () => {
  it("validates name, text and a loaded upload", () => {
    expect(validateLocationDraft({ name: " ", description: "x" })).toMatch(
      /name/,
    );
    expect(
      validateLocationDraft({ name: "Harbor", description: "  " }),
    ).toMatch(/Describe/);
    expect(
      validateLocationDraft({
        name: "Harbor",
        description: "a harbor",
        ref: { ...upload(), dataUrl: undefined },
      }),
    ).toMatch(/loading/);
    expect(
      validateLocationDraft({ name: "Harbor", description: "a harbor" }),
    ).toBeNull();
  });

  it("builds a normalized location, keeping id and createdAt on update", () => {
    const a = buildLocation(
      { name: "  Harbor   at dusk ", description: "a storm-lashed\nharbor" },
      undefined,
      1000,
    );
    expect(a.name).toBe("Harbor at dusk");
    expect(a.description).toBe("a storm-lashed harbor");
    expect(a.ref).toBeUndefined();
    expect(a.id).toMatch(/^loc_/);
    const b = buildLocation(
      { name: "Harbor at dusk", description: "a calm harbor", ref: gallery },
      a,
      2000,
    );
    expect(b.id).toBe(a.id);
    expect(b.createdAt).toBe(1000);
    expect(b.updatedAt).toBe(2000);
    expect(b.ref?.runId).toBe("run_1");
    expect(() => buildLocation({ name: "", description: "x" })).toThrow();
  });

  it("stores an upload ref once and restores its preview", () => {
    const loc = buildLocation({
      name: "Lab",
      description: "a cluttered lab",
      ref: upload(),
    });
    expect(loc.ref?.previewUrl).toBe("");
    expect(loc.ref?.dataUrl).toMatch(/^data:image\//);
    expect(locationImage(loc)?.previewUrl).toBe(loc.ref?.dataUrl);
    expect(
      locationImage(buildLocation({ name: "a", description: "b" })),
    ).toBeNull();
  });

  it("upserts by id or case-insensitive name, newest first, capped", () => {
    const mk = (id: string, name: string): SavedLocation => ({
      id,
      name,
      description: name,
      createdAt: 0,
      updatedAt: 0,
    });
    let list = [mk("a", "Harbor"), mk("b", "Lab")];
    list = upsertLocation(list, mk("c", "harbor"));
    expect(list.map((l) => l.id)).toEqual(["c", "b"]);
    list = upsertLocation(list, mk("b", "Lab two"));
    expect(list.map((l) => l.id)).toEqual(["b", "c"]);
    const many = Array.from({ length: LOCATION_MAX + 5 }, (_, i) =>
      mk(`x${i}`, `Place ${i}`),
    );
    expect(upsertLocation(many, mk("new", "New"))).toHaveLength(LOCATION_MAX);
  });

  it("sanitizes persisted state", () => {
    const good = buildLocation({ name: "Roof", description: "a rooftop" });
    const out = sanitizeLocations([
      good,
      good,
      null,
      { id: "x", name: "No text", description: " " },
      { id: "y", name: "", description: "a" },
      {
        id: "z",
        name: "Bad ref",
        description: "a field",
        ref: { id: "r", label: "r", source: "upload", dataUrl: "javascript:1" },
      },
    ]);
    expect(out.map((l) => l.id)).toEqual([good.id, "z"]);
    expect(out[1].ref).toBeUndefined();
    expect(sanitizeLocations("nope")).toEqual([]);
  });
});

describe("cinema location store", () => {
  beforeEach(() => {
    useCinemaLocationStore.setState({ locations: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves, replaces by name and removes", () => {
    const st = useCinemaLocationStore.getState();
    const r1 = st.saveLocation({ name: "Harbor", description: "a harbor" });
    expect(r1.ok).toBe(true);
    const r2 = useCinemaLocationStore
      .getState()
      .saveLocation({ name: "harbor", description: "a stormy harbor" });
    expect(r2.ok && r1.ok && r2.location.id === r1.location.id).toBe(true);
    const list = useCinemaLocationStore.getState().locations;
    expect(list).toHaveLength(1);
    expect(list[0].description).toBe("a stormy harbor");
    useCinemaLocationStore.getState().removeLocation(list[0].id);
    expect(useCinemaLocationStore.getState().locations).toEqual([]);
  });

  it("replaces a long-named location instead of duplicating it", () => {
    const name = "Old harbor at dusk ".repeat(5);
    const st = useCinemaLocationStore.getState();
    const r1 = st.saveLocation({ name, description: "a harbor" });
    const r2 = useCinemaLocationStore
      .getState()
      .saveLocation({ name, description: "a stormy harbor" });
    expect(r1.ok && r2.ok && r2.location.id === r1.location.id).toBe(true);
    expect(useCinemaLocationStore.getState().locations).toHaveLength(1);
  });

  it("rejects invalid drafts and drafts over the storage budget", () => {
    const st = useCinemaLocationStore.getState();
    expect(st.saveLocation({ name: "", description: "x" }).ok).toBe(false);
    const big = st.saveLocation({
      name: "Huge",
      description: "a place",
      ref: upload(LOCATION_STORAGE_BUDGET + 10),
    });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error).toMatch(/full/);
    expect(useCinemaLocationStore.getState().locations).toEqual([]);
  });

  it("persists under its own key and survives a throwing localStorage", () => {
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
    useCinemaLocationStore
      .getState()
      .saveLocation({ name: "Roof", description: "a rooftop at night" });
    expect(mem.get(CINEMA_LOCATIONS_KEY)).toContain("a rooftop at night");

    const boom = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("localStorage", {
      getItem: boom,
      setItem: boom,
      removeItem: boom,
    });
    expect(safeLocationStorage.getItem("k")).toBeNull();
    expect(() => safeLocationStorage.setItem("k", "v")).not.toThrow();
    expect(() => safeLocationStorage.removeItem("k")).not.toThrow();
    const r = useCinemaLocationStore
      .getState()
      .saveLocation({ name: "Lab", description: "a lab" });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Saved characters in a scene
// ---------------------------------------------------------------------------

describe("scene character from a profile", () => {
  it("is the name, then the look and suffix", () => {
    const text = profileSceneCharacter({
      name: " Mara ",
      look: {},
      suffix: "silver braid, green coat",
    });
    expect(text).toBe("Mara, silver braid, green coat");
    expect(profileSceneCharacter({ name: "Pip", look: {}, suffix: "" })).toBe(
      "Pip",
    );
  });

  it("rides into every shot prompt with a saved location", () => {
    const scene = {
      ...defaultScene(2),
      character: profileSceneCharacter({
        name: "Lumen",
        look: {},
        suffix: "glowing lantern",
      }),
      location: buildLocation({ name: "Lab", description: "a cluttered lab" })
        .description,
    };
    const shots = compileSceneShots("", scene, {});
    expect(shots).toHaveLength(2);
    for (const s of shots) {
      expect(s).toContain("Lumen, glowing lantern.");
      expect(s).toContain("Location: a cluttered lab.");
    }
  });
});

// ---------------------------------------------------------------------------
// Scene -> stitch
// ---------------------------------------------------------------------------

describe("scene stitch state", () => {
  const ids = ["r1", "r2", "r3"];

  it("waits until every shot has a clip", () => {
    const st = sceneStitchState(ids, [
      run("r1", job("done", [videoUrl("s1.mp4")])),
      run("r2", job("running")),
    ]);
    expect(st.status).toBe("waiting");
    expect(st.done).toBe(1);
    expect(st.total).toBe(3);
    expect(() => sceneStitchParams(st)).toThrow(/every shot/);
  });

  it("keeps shot order regardless of store or finish order", () => {
    // Store is newest-first and shot 3 finished first.
    const runs = [
      run("r3", job("done", [videoUrl("c.mp4")])),
      run("other", job("done", [videoUrl("zzz.mp4")])),
      run("r2", job("done", [videoUrl("b.mp4")])),
      run("r1", job("done", [videoUrl("a.mp4")])),
    ];
    const st = sceneStitchState(ids, runs);
    expect(st.status).toBe("ready");
    expect(st.clips.map((c) => c.ref)).toEqual([
      "video/a.mp4 [output]",
      "video/b.mp4 [output]",
      "video/c.mp4 [output]",
    ]);
    expect(st.clips.map((c) => c.label)).toEqual([
      "Shot 1",
      "Shot 2",
      "Shot 3",
    ]);
  });

  it("flags failed shots and shots that finished without a video", () => {
    const st = sceneStitchState(ids, [
      run("r1", job("done", [videoUrl("a.mp4")])),
      run("r2", job("error"), "error"),
      run("r3", job("done", [])),
    ]);
    expect(st.status).toBe("failed");
    expect(st.failedShots).toEqual([2, 3]);
    expect(() => sceneStitchParams(st)).toThrow(/Shot 2, 3/);
  });

  it("ignores non-video outputs", () => {
    expect(
      shotClip(
        run("r1", job("done", ["/api/comfy/image?filename=x.png&type=output"])),
        1,
      ),
    ).toBeNull();
    expect(shotClip(undefined, 1)).toBeNull();
  });
});

describe("scene stitch params", () => {
  const ready = sceneStitchState(
    ["r1", "r2"],
    [
      run("r2", job("done", [videoUrl("two.mp4")])),
      run("r1", job("done", [videoUrl("one.mp4")])),
    ],
  );

  it("maps shot clips in order with the scene prefix and a hard cut", () => {
    expect(sceneStitchParams(ready)).toEqual({
      clips: [
        { video: "video/one.mp4 [output]" },
        { video: "video/two.mp4 [output]" },
      ],
      transition: "cut",
      fps: 24,
      audio: false,
      prefix: SCENE_STITCH_PREFIX,
    });
  });

  it("passes a crossfade through", () => {
    const p = sceneStitchParams(ready, {
      transition: "fade",
      fadeSeconds: 0.5,
      fps: 30,
    });
    expect(p.transition).toBe("fade");
    expect(p.fadeSeconds).toBe(0.5);
    expect(p.fps).toBe(30);
  });

  it("queues one stitch_clips action with the clips in shot order", async () => {
    const calls: { url: string; body?: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      const json = (data: unknown) =>
        ({ ok: true, status: 200, json: async () => data }) as Response;
      if (url === "/api/jobs/seed-run")
        return json({ run: { run_id: "seed", jobs: [{ index: 0 }] } });
      if (url === "/api/jobs/action")
        return json({
          run: { run_id: "stitch", jobs: [{ prompt_id: "pid", index: 0 }] },
        });
      return json({
        status: { status_str: "success" },
        videos: [
          {
            filename: "scene_00001_.mp4",
            subfolder: "video",
            type: "output",
            url: videoUrl("scene_00001_.mp4"),
          },
        ],
      });
    });
    const onRun = vi.fn();
    const res = await runStitch(
      ready.clips.map((c) => ({ ...c, seconds: 3 })),
      { prefix: SCENE_STITCH_PREFIX },
      { fetchImpl: fetchImpl as never, clientId: "c", onRun },
    );
    const act = calls.filter((c) => c.url === "/api/jobs/action");
    expect(act).toHaveLength(1);
    expect(act[0].body?.action).toBe(STITCH_CLIPS_ACTION);
    const params = act[0].body?.params as { clips: { video: string }[] };
    expect(params.clips.map((c) => c.video)).toEqual([
      "video/one.mp4 [output]",
      "video/two.mp4 [output]",
    ]);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(res.video.ref).toBe("video/scene_00001_.mp4 [output]");
    expect(stitchClipsCard().id).toBe(STITCH_CLIPS_ACTION);
  });
});

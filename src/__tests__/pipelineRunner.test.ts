import { describe, expect, it, vi } from "vitest";
import type { ImagineRun } from "@/types";

vi.mock("@/lib/tools/runTool", async (orig) => {
  const actual = await orig<typeof import("@/lib/tools/runTool")>();
  return {
    ...actual,
    submitEngineEdit: vi.fn(async (args: { prompt: string }) => {
      editPrompts.push(args.prompt);
      const n = editPrompts.length;
      return {
        run_id: `edit${n}`,
        jobs: [{ index: 0, prompt_id: `p-edit-${n}` }],
      } as unknown as ImagineRun;
    }),
  };
});
const editPrompts: string[] = [];

import {
  canRerun,
  packshotPrompt,
  plainPrompt,
  rerunStep,
  runPipeline,
  sceneImagePrompt,
  waitForOutputs,
  type PipelineInputs,
  type RunnerDeps,
} from "@/lib/tools/pipelineRunner";
import { initialState, type PipelineState } from "@/lib/tools/pipelines";
import type { EditEngine } from "@/lib/tools/templates";

const SCRIPT_JSON = JSON.stringify({
  title: "Tiny Gardens",
  music: "soft piano, warm",
  scenes: [
    {
      narration: "Moss grows where little else can.",
      visual: "macro moss on a stone",
      motion: "slow push in",
    },
    {
      narration: "It drinks fog and holds the rain.",
      visual: "droplets on moss at dawn",
      motion: "rack focus",
    },
  ],
});

interface Call {
  url: string;
  body: Record<string, unknown> | null;
}

function json(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

/** Fake Adrift server: queues runs and serves history per action. */
function server(
  opts: { failAction?: string; failOnce?: boolean; pendingPolls?: number } = {},
) {
  const calls: Call[] = [];
  const kindOf = new Map<string, string>();
  const polls = new Map<string, number>();
  let n = 0;
  let failed = false;
  const mkRun = (kind: string): ImagineRun => {
    n += 1;
    const pid = `p-${kind}-${n}`;
    kindOf.set(pid, kind);
    return {
      run_id: `${kind}${n}`,
      jobs: [{ index: 0, prompt_id: pid }],
    } as unknown as ImagineRun;
  };
  const file = (name: string, sub: string) => ({
    filename: name,
    subfolder: sub,
    type: "output",
    url: `/api/comfy/image?filename=${name}&subfolder=${sub}&type=output`,
  });
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : null;
    calls.push({ url, body });
    if (url === "/api/jobs/seed-run")
      return json({ run: { run_id: `seed${++n}`, jobs: [{ index: 0 }] } });
    if (url === "/api/jobs/imagine") return json({ runs: [mkRun("imagine")] });
    if (url === "/api/comfy/upload")
      return json({ ref: "presenter_x.mp3 [input]" });
    if (url === "/api/jobs/action")
      return json({ run: mkRun(String(body!.action)) });
    if (url.startsWith("/api/comfy/history/")) {
      const pid = decodeURIComponent(url.slice("/api/comfy/history/".length));
      const kind = kindOf.get(pid) ?? (pid.startsWith("p-edit-") ? "edit" : "");
      const seen = (polls.get(pid) ?? 0) + 1;
      polls.set(pid, seen);
      if (seen <= (opts.pendingPolls ?? 0))
        return json({ ok: false, error: "pending" }, 404);
      if (kind === opts.failAction && (!opts.failOnce || !failed)) {
        failed = true;
        return json({
          ok: true,
          status: {
            status_str: "error",
            messages: [
              [
                "execution_error",
                { node_type: "KSampler", exception_message: "out of memory" },
              ],
            ],
          },
        });
      }
      const id = pid.split("-").pop();
      switch (kind) {
        case "pipeline_script":
          return json({ ok: true, texts: [{ text: SCRIPT_JSON }] });
        case "imagine":
        case "edit":
          return json({ ok: true, images: [file(`img${id}.png`, "")] });
        case "voiceover":
          return json({ ok: true, audios: [file(`vo${id}.mp3`, "audio")] });
        case "music":
          return json({ ok: true, audios: [file(`bed${id}.mp3`, "audio")] });
        default:
          return json({
            ok: true,
            videos: [file(`${kind}${id}.mp4`, "video")],
          });
      }
    }
    return json({ error: "unexpected" }, 500);
  });
  const actions = () =>
    calls
      .filter((c) => c.url === "/api/jobs/action")
      .map((c) => c.body as Record<string, unknown>);
  return { fetchImpl, calls, actions };
}

const baseInputs = (over: Partial<PipelineInputs> = {}): PipelineInputs => ({
  kind: "shorts",
  topic: "why moss matters",
  preset: "facts",
  scenes: 2,
  voice: "af_heart",
  motion: "animate_low",
  size: "720x1280",
  captions: true,
  ...over,
});

const deps = (
  fetchImpl: RunnerDeps["fetchImpl"],
  over: Partial<RunnerDeps> = {},
): RunnerDeps => ({
  fetchImpl,
  clientId: "c1",
  onRun: vi.fn(),
  measure: async (_url, kind) => (kind === "audio" ? 2.5 : 4.04),
  toDataUrl: async () => "data:audio/mpeg;base64,AAAA",
  sleep: async () => {},
  pollMs: 1,
  ...over,
});

describe("prompt helpers", () => {
  it("strip parser syntax and add the vertical aspect", () => {
    expect(plainPrompt("a cat --ar 1:1 :: 2")).toBe("a cat ar 1:1 : 2");
    expect(sceneImagePrompt("moss", "watercolor")).toBe(
      "moss, watercolor --ar 9:16",
    );
    expect(packshotPrompt("on a desk", false)).toMatch(
      /Keep the product's shape/,
    );
    expect(packshotPrompt("on a desk", true)).toMatch(/fictional presenter/);
  });
});

describe("waitForOutputs", () => {
  it("keeps polling through 404 and surfaces execution errors", async () => {
    const { fetchImpl } = server({ pendingPolls: 2, failAction: "music" });
    const d = deps(fetchImpl);
    const run = (await (
      await fetchImpl("/api/jobs/action", {
        method: "POST",
        body: JSON.stringify({ action: "voiceover" }),
      })
    ).json()) as { run: ImagineRun };
    const out = await waitForOutputs(d, run.run.jobs[0].prompt_id!);
    expect(out.audios).toHaveLength(1);
    const bad = (await (
      await fetchImpl("/api/jobs/action", {
        method: "POST",
        body: JSON.stringify({ action: "music" }),
      })
    ).json()) as { run: ImagineRun };
    await expect(waitForOutputs(d, bad.run.jobs[0].prompt_id!)).rejects.toThrow(
      /KSampler: out of memory/,
    );
  });

  it("times out", async () => {
    const { fetchImpl } = server({ pendingPolls: 1000 });
    let t = 0;
    await expect(
      waitForOutputs(
        deps(fetchImpl, { now: () => (t += 1000), timeoutMs: 3000 }),
        "p-x-1",
      ),
    ).rejects.toThrow(/Timed out/);
  });
});

describe("runPipeline", () => {
  it("runs a full short end to end with the existing tools", async () => {
    const srv = server();
    const states: PipelineState[] = [];
    const d = deps(srv.fetchImpl);
    const end = await runPipeline(
      initialState({ kind: "shorts", music: true }),
      baseInputs({ style: "film grain" }),
      d,
      (s) => states.push(s),
    );
    expect(end.order.every((id) => end.steps[id].status === "done")).toBe(true);
    expect(end.script?.title).toBe("Tiny Gardens");
    expect(states.some((s) => s.steps["image:0"]?.status === "running")).toBe(
      true,
    );

    const acts = srv.actions();
    expect(acts.map((a) => a.action)).toEqual([
      "pipeline_script",
      "voiceover",
      "voiceover",
      "animate_low",
      "animate_low",
      "music",
      "pipeline_assemble",
    ]);
    expect(acts[0].params).toMatchObject({
      kind: "shorts",
      topic: "why moss matters",
      scenes: 2,
      preset: "facts",
    });
    expect(acts[1].params).toMatchObject({
      engine: "kokoro",
      voice: "af_heart",
      script: "Moss grows where little else can.",
    });
    expect(String((acts[3].params as { prompt: string }).prompt)).toContain(
      "slow push in",
    );
    // Clips animate the generated scene image runs.
    expect(acts[3].run_id).toBe(end.steps["image:0"].runId);
    const imagine = srv.calls.filter((c) => c.url === "/api/jobs/imagine");
    expect(imagine.map((c) => c.body!.prompt)).toEqual([
      "macro moss on a stone, film grain --ar 9:16",
      "droplets on moss at dawn, film grain --ar 9:16",
    ]);
    const music = acts[5].params as { prompt: string; duration: number };
    expect(music.prompt).toBe("instrumental, soft piano, warm");
    expect(music.duration).toBe(11); // 2 x 4.04 s scenes, +2 s, min 10
    const asm = acts[6].params as {
      scenes: Record<string, unknown>[];
      music: string;
      prefix: string;
      fps: number;
    };
    expect(asm.prefix).toBe("video/adrift_short");
    expect(asm.fps).toBe(24);
    expect(asm.music).toMatch(/^audio\/bed\d+\.mp3 \[output\]$/);
    expect(asm.scenes[0]).toMatchObject({
      video: expect.stringMatching(/^video\/animate_low\d+\.mp4 \[output\]$/),
      audio: expect.stringMatching(/^audio\/vo\d+\.mp3 \[output\]$/),
      caption: "Moss grows where little else can.",
      clipSeconds: 4.04,
      seconds: 4.04,
    });
    expect(end.steps.assemble.output?.url).toMatch(/pipeline_assemble/);
    expect(d.onRun).toHaveBeenCalled();
  });

  it("ad with a presenter: packshots via the edit engine, every clip on LTX-2.5", async () => {
    editPrompts.length = 0;
    const srv = server();
    const end = await runPipeline(
      initialState({ kind: "ad", presenter: true, music: false }),
      baseInputs({
        kind: "ad",
        topic: "a moss terrarium kit",
        preset: "ugc",
        presenter: true,
        product: {
          id: "g",
          source: "gallery",
          runId: "prod1",
          jobIndex: 0,
          previewUrl: "x",
          label: "p",
        } as never,
        engine: { id: "qwen2511" } as unknown as EditEngine,
        ctx: { catalog: [], packIds: new Set(), editLoras: null },
      }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(end.order).not.toContain("music");
    expect(end.order.every((id) => end.steps[id].status === "done")).toBe(true);
    const acts = srv.actions();
    expect(acts[0]).toMatchObject({
      action: "pipeline_script",
      run_id: "prod1",
      params: { kind: "ad", presenter: true },
    });
    expect(editPrompts).toHaveLength(2);
    expect(editPrompts[0]).toMatch(/fictional presenter/);
    expect(editPrompts[1]).not.toMatch(/presenter/);
    // No Wan talking_avatar / generic animate: every video step is LTX-2.5.
    const videoActs = acts.filter((a) =>
      /animate|avatar|i2v|video/i.test(String(a.action)),
    );
    expect(videoActs.map((a) => a.action)).toEqual([
      "ltx25_animate",
      "ltx25_animate",
    ]);
    // The presenter speaks on camera: no Kokoro voice for scene 1.
    expect(end.order).not.toContain("voice:0");
    expect(acts.filter((a) => a.action === "voiceover")).toHaveLength(1);
    const [talk, product] = videoActs;
    expect(talk.run_id).toBe(end.steps["image:0"].runId);
    const tp = talk.params as Record<string, unknown>;
    expect(tp).toMatchObject({ pack_id: "ltx25", ar: "9:16" });
    expect(tp.prompt).toMatch(
      /They say: "Moss grows where little else can\."/,
    );
    expect((Number(tp.frames) - 1) % 8).toBe(0);
    const pp = product.params as Record<string, unknown>;
    expect(pp).toMatchObject({ pack_id: "ltx25", ar: "9:16" });
    expect(pp.prompt).toMatch(/^Rack focus\. /);
    expect(pp.prompt).toMatch(/soundtrack is only natural sound design/);
    // voice 2.5 s + 0.35 s tail -> 3 s floor -> 73 frames.
    expect(pp.frames).toBe(73);
    expect(String(pp.prompt)).not.toMatch(/\n/);
    const asm = acts.find((a) => a.action === "pipeline_assemble")!.params as {
      prefix: string;
      music?: string;
      scenes: { audio?: string; clipAudioDb?: number }[];
    };
    expect(asm.prefix).toBe("video/adrift_ad");
    expect(asm.music).toBeUndefined();
    expect(asm.scenes[0].audio).toBeUndefined();
    expect(asm.scenes[0].clipAudioDb).toBe(0);
    expect(asm.scenes[1].audio).toMatch(/^audio\/vo/);
    expect(asm.scenes[1].clipAudioDb).toBe(-12);
  });

  it("a failed step blocks only its dependents and can be re-run", async () => {
    const srv = server({ failAction: "music", failOnce: true });
    const d = deps(srv.fetchImpl);
    const first = await runPipeline(
      initialState({ kind: "shorts", music: true }),
      baseInputs(),
      d,
      () => {},
    );
    expect(first.steps.music.status).toBe("error");
    expect(first.steps.music.error).toMatch(/out of memory/);
    expect(first.steps["clip:1"].status).toBe("done");
    expect(first.steps.assemble.status).toBe("idle");
    expect(canRerun(first, "music")).toBe(true);
    expect(canRerun(first, "assemble")).toBe(false);
    const before = srv.actions().length;
    const second = await runPipeline(
      rerunStep(first, "music"),
      baseInputs(),
      d,
      () => {},
    );
    expect(second.order.every((id) => second.steps[id].status === "done")).toBe(
      true,
    );
    expect(
      srv
        .actions()
        .slice(before)
        .map((a) => a.action),
    ).toEqual(["music", "pipeline_assemble"]);
  });

  it("re-running one scene image redoes only that scene's clip and the final cut", async () => {
    const srv = server();
    const d = deps(srv.fetchImpl);
    const done = await runPipeline(
      initialState({ kind: "shorts", music: true }),
      baseInputs(),
      d,
      () => {},
    );
    const before = srv.actions().length;
    const imgBefore = srv.calls.filter(
      (c) => c.url === "/api/jobs/imagine",
    ).length;
    const again = await runPipeline(
      rerunStep(done, "image:1"),
      baseInputs(),
      d,
      () => {},
    );
    expect(again.steps.assemble.status).toBe("done");
    expect(
      srv.calls.filter((c) => c.url === "/api/jobs/imagine").length - imgBefore,
    ).toBe(1);
    expect(
      srv
        .actions()
        .slice(before)
        .map((a) => a.action),
    ).toEqual(["animate_low", "pipeline_assemble"]);
  });

  it("stops when cancelled and leaves the step idle", async () => {
    const srv = server({ pendingPolls: 1000 });
    let stop = false;
    const d = deps(srv.fetchImpl, {
      isCancelled: () => stop,
      sleep: async () => {
        stop = true;
      },
    });
    const end = await runPipeline(
      initialState({ kind: "shorts" }),
      baseInputs(),
      d,
      () => {},
    );
    expect(end.steps.script.status).toBe("idle");
    expect(end.script).toBeNull();
  });

  it("reports missing inputs as a step error", async () => {
    const srv = server();
    const end = await runPipeline(
      initialState({ kind: "ad" }),
      baseInputs({ kind: "ad" }),
      deps(srv.fetchImpl),
      () => {},
    );
    expect(end.steps.script.status).toBe("error");
    expect(end.steps.script.error).toMatch(/product photo/);
  });
});

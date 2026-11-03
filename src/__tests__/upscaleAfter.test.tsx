/**
 * "Upscale after" chaining: which tools get it, the Settings default and
 * per-run override, the plan for a finished tool run, the queued request
 * (mocked fetch, nothing reaches ComfyUI) and the queue's parent link.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ImagineJob, ImagineRun } from "@/types";
import {
  CHAIN_MAX_AGE_MS,
  IMAGE_TOOLS,
  VIDEO_TOOLS,
  OUTPUT_GRACE_MS,
  UPSCALE_AFTER_SKIP,
  UPSCALE_GRAPH_PARAM,
  defaultUpscaleAfter,
  effectiveUpscaleAfter,
  graphUpscales,
  planUpscaleChain,
  pruneChains,
  upscaleAfterFactors,
  upscaleAfterMedia,
  type UpscaleChain,
} from "@/lib/upscale/upscaleAfter";
import { queueUpscaleSteps } from "@/lib/upscale/upscaleAfterRunner";
import {
  mergeUpscalerPref,
  sanitizeUpscalerPref,
  upscalerPatchError,
} from "@/lib/upscale/upscalerPref";
import editToolRegistry from "@/lib/tools/editToolRegistry.json";
import { ACTION_TOOLS, getActionTool, type ActionToolId } from "@/lib/tools/toolsPage";
import { buildQueueSnapshot } from "@/lib/queue/queueEntries";
import { queueStatusText } from "@/components/QueueDrawer";
import { UpscaleAfterToggle } from "@/components/upscale/UpscaleAfterToggle";

const NOW = 1_800_000_000_000;

function job(over: Partial<ImagineJob> = {}): ImagineJob {
  return { seed: 1, index: 0, status: "done", progress: 100, images: [], ...over };
}

function run(id: string, over: Partial<ImagineRun> = {}): ImagineRun {
  return {
    run_id: id,
    prompt: "",
    parsedPrompt: "",
    width: 1024,
    height: 1024,
    jobs: [job()],
    createdAt: new Date(NOW).toISOString(),
    status: "done",
    params: {},
    ...over,
  };
}

function chain(over: Partial<UpscaleChain> = {}): UpscaleChain {
  return {
    parentRunId: "r1",
    parentLabel: "Relight",
    cardKey: "action:relight",
    factor: 2,
    createdAt: NOW,
    status: "waiting",
    children: [],
    ...over,
  };
}

describe("which tools get Upscale after", () => {
  it("offers stills and clips, never tools that already upscale", () => {
    expect(upscaleAfterMedia("action:relight")).toBe("image");
    expect(upscaleAfterMedia("action:animate")).toBe("video");
    expect(upscaleAfterMedia("catalog:some-edit")).toBe("image");
    for (const key of Object.keys(UPSCALE_AFTER_SKIP))
      expect(upscaleAfterMedia(key), key).toBeNull();
    expect(upscaleAfterMedia("action:describe")).toBeNull();
    expect(upscaleAfterMedia("action:nope")).toBeNull();
    expect(upscaleAfterMedia("relight")).toBeNull();
  });

  it("names only real action tools", () => {
    const ids = new Set<string>(ACTION_TOOLS.map((t) => t.id));
    for (const id of [...IMAGE_TOOLS, ...VIDEO_TOOLS])
      expect(ids.has(id), id).toBe(true);
    const offered = [...ids].filter((id) => upscaleAfterMedia(`action:${id}`));
    expect(offered.length).toBeGreaterThan(20);
    const catalog = new Set(
      (editToolRegistry as { tools: { id: string }[] }).tools.map((t) => t.id),
    );
    for (const key of Object.keys(UPSCALE_AFTER_SKIP)) {
      if (key.startsWith("action:"))
        expect(ids.has(key.slice(7)), key).toBe(true);
      else expect(catalog.has(key.slice(8)), key).toBe(true);
    }
    // Nothing the Upscale tools themselves would see.
    expect(offered).not.toContain("upscale");
    expect(offered).not.toContain("upscale_video");
  });

  it("detects upscale nodes in a queued graph", () => {
    expect(graphUpscales(null)).toBe(false);
    expect(
      graphUpscales({ "1": { class_type: "KSampler" }, "2": { class_type: "ImageScale" } }),
    ).toBe(false);
    for (const cls of [
      "UpscaleModelLoader",
      "ImageUpscaleWithModel",
      "UltimateSDUpscale",
      "SeedVR2VideoUpscaler",
      "LatentUpscaleBy",
      "LTXVLatentUpsampler",
    ])
      expect(graphUpscales({ "9": { class_type: cls } }), cls).toBe(true);
  });
});

describe("Settings default and per-run override", () => {
  it("stores after only when on", () => {
    expect(sanitizeUpscalerPref({ after: true })).toEqual({ after: true });
    expect(sanitizeUpscalerPref({ after: "yes" })).toBeNull();
    const on = mergeUpscalerPref(null, { after: true });
    expect(on?.after).toBe(true);
    expect(mergeUpscalerPref(on, { after: false })?.after).toBeUndefined();
    expect(upscalerPatchError({ after: "1" })).toMatch(/after/);
    expect(upscalerPatchError({ after: false })).toBe("");
  });

  it("follows the Faithful size, clamped per media", () => {
    expect(defaultUpscaleAfter(null, "image")).toEqual({ on: false, factor: 2 });
    expect(defaultUpscaleAfter({ after: true, scale: 4 }, "image")).toEqual({
      on: true,
      factor: 4,
    });
    expect(defaultUpscaleAfter({ after: true, scale: 4 }, "video")).toEqual({
      on: true,
      factor: 2,
    });
    expect(upscaleAfterFactors("video")).toEqual([2]);
    expect(effectiveUpscaleAfter({ on: true }, null, "image")).toEqual({
      on: true,
      factor: 2,
    });
    expect(
      effectiveUpscaleAfter({ on: false }, { after: true }, "image").on,
    ).toBe(false);
    expect(effectiveUpscaleAfter({ factor: 4 }, null, "video").factor).toBe(2);
  });
});

describe("planUpscaleChain", () => {
  it("waits while the tool runs or its files land", () => {
    expect(planUpscaleChain(chain(), undefined, NOW)).toEqual({ kind: "wait" });
    expect(
      planUpscaleChain(chain(), run("r1", { jobs: [job({ status: "running" })] }), NOW),
    ).toEqual({ kind: "wait" });
    expect(
      planUpscaleChain(chain(), run("r1", { jobs: [job({ completedAt: NOW })] }), NOW + 1000),
    ).toEqual({ kind: "wait" });
    expect(
      planUpscaleChain(chain({ status: "queued" }), run("r1", { jobs: [job({ images: ["a.png"] })] }), NOW),
    ).toEqual({ kind: "wait" });
  });

  it("queues Upscale for stills at the chosen size", () => {
    const r = run("r1", {
      jobs: [
        job({ index: 0, images: ["a.png"] }),
        job({ index: 1, status: "error" }),
        job({ index: 2, images: ["c.png"] }),
      ],
    });
    expect(planUpscaleChain(chain({ factor: 4 }), r, NOW)).toEqual({
      kind: "queue",
      steps: [
        { jobIndex: 0, toolId: "upscale", picks: { mode: "upscale_subtle", size: "4x" } },
        { jobIndex: 2, toolId: "upscale", picks: { mode: "upscale_subtle", size: "4x" } },
      ],
    });
  });

  it("queues Upscale video (Fast, 2x) for clips", () => {
    const r = run("r1", { jobs: [job({ videos: ["a.mp4"], images: ["poster.png"] })] });
    expect(planUpscaleChain(chain({ cardKey: "action:animate" }), r, NOW)).toEqual({
      kind: "queue",
      steps: [{ jobIndex: 0, toolId: "upscale_video", picks: { engine: "fast", scale: "2x" } }],
    });
  });

  it("uses picks the Upscale tools actually offer", () => {
    const ids = (tool: ActionToolId, key: string) =>
      getActionTool(tool)?.pickers?.find((p) => p.key === key)?.options.map((o) => o.id) ?? [];
    expect(ids("upscale", "mode")).toContain("upscale_subtle");
    expect(ids("upscale", "size")).toEqual(expect.arrayContaining(["2x", "4x"]));
    expect(ids("upscale_video", "engine")).toContain("fast");
    expect(ids("upscale_video", "scale")).toContain("2x");
  });

  it("skips runs that upscaled or failed, fails empty or lost ones", () => {
    const done = [job({ images: ["a.png"] })];
    expect(
      planUpscaleChain(chain(), run("r1", { jobs: done, params: { [UPSCALE_GRAPH_PARAM]: true } }), NOW),
    ).toEqual({ kind: "skip", note: "Relight already upscales." });
    expect(planUpscaleChain(chain(), run("r1", { jobs: [job({ status: "error" })] }), NOW).kind).toBe("skip");
    expect(planUpscaleChain(chain(), run("r1", { jobs: [job({ status: "cancelled" })] }), NOW)).toEqual({
      kind: "skip",
      note: "Relight was cancelled.",
    });
    expect(
      planUpscaleChain(chain(), run("r1", { jobs: [job({ completedAt: NOW })] }), NOW + OUTPUT_GRACE_MS + 1).kind,
    ).toBe("fail");
    expect(planUpscaleChain(chain(), undefined, NOW + CHAIN_MAX_AGE_MS + 1).kind).toBe("fail");
  });
});

describe("chain bookkeeping", () => {
  it("prunes old finished chains", () => {
    const chains = {
      r1: chain({ status: "queued", children: ["u1"] }),
      r2: chain({ parentRunId: "r2", createdAt: NOW - 1 }),
      old: chain({ parentRunId: "old", status: "queued", createdAt: NOW - CHAIN_MAX_AGE_MS * 5 }),
    };
    expect(Object.keys(pruneChains(chains, NOW)).sort()).toEqual(["r1", "r2"]);
    expect(Object.keys(pruneChains(chains, NOW, 0))).toEqual(["r2"]);
  });

  it("queues each step through /api/jobs/action on the parent's job", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      return new Response(JSON.stringify({ run: run(`u${calls.length}`, { status: "queued" }) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const seen: string[] = [];
    const out = await queueUpscaleSteps(
      "r1",
      [
        { jobIndex: 0, toolId: "upscale", picks: { mode: "upscale_subtle", size: "4x" } },
        { jobIndex: 1, toolId: "upscale_video", picks: { engine: "fast", scale: "2x" } },
      ],
      { fetchImpl: fetchImpl as never, clientId: "c1", onRun: (r) => seen.push(r.run_id) },
    );
    expect(out.map((r) => r.run_id)).toEqual(["u1", "u2"]);
    expect(seen).toEqual(["u1", "u2"]);
    expect(calls.every((c) => c.url === "/api/jobs/action")).toBe(true);
    expect(calls[0].body).toMatchObject({ run_id: "r1", job_index: 0, client_id: "c1" });
    expect(calls[1].body).toMatchObject({ run_id: "r1", job_index: 1 });
    // No model named: the server applies the user's default upscaler.
    expect(JSON.stringify(calls.map((c) => c.body))).not.toMatch(/upscale_model/);
  });
});

describe("queue link", () => {
  it("labels the child with its parent and lists waiting chains last", () => {
    const parent = run("r1", { jobs: [job({ status: "running", prompt_id: "p1" })], status: "running" });
    const child = run("u1", { jobs: [job({ status: "queued", prompt_id: "p2" })], status: "queued" });
    const chains = {
      r0: chain({ parentRunId: "r0", status: "queued", children: ["u1"], parentLabel: "Edit photo" }),
      r1: chain({ cardKey: "action:animate", parentLabel: "Animate" }),
    };
    const { active } = buildQueueSnapshot([parent, child], new Set(), 8, chains);
    expect(active.map((e) => e.key)).toEqual(["r1:0", "u1:0", "chain:r1"]);
    expect(active[1].after).toBe("Edit photo");
    const waiting = active[2];
    expect(waiting).toMatchObject({ label: "Upscale video 2×", waiting: true, mediaKind: "video" });
    expect(queueStatusText(waiting)).toBe("Waits for Animate");
    expect(buildQueueSnapshot([parent]).active).toHaveLength(1);
  });
});

describe("UpscaleAfterToggle", () => {
  it("renders a switch and, for stills, a size choice", () => {
    const html = renderToStaticMarkup(
      <UpscaleAfterToggle media="image" value={{ on: true, factor: 4 }} onChange={() => {}} overridden onReset={() => {}} />,
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("Upscale after");
    expect(html).toContain('aria-label="Upscale after size"');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>4×/);
    expect(html).toContain("Use default");
  });

  it("shows clips' fixed 2x without a choice", () => {
    const html = renderToStaticMarkup(
      <UpscaleAfterToggle media="video" value={{ on: true, factor: 2 }} onChange={() => {}} />,
    );
    expect(html).not.toContain("radiogroup");
    expect(html).toContain("2×");
  });
});

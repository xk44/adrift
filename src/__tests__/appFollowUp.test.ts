import { describe, it, expect } from "vitest";
import rawApps from "@/lib/tools/appTemplates.json";
import {
  getApp,
  validateAppTemplates,
  type AppTemplate,
} from "@/lib/tools/apps";
import {
  APP_CUTOUT_TOOL,
  BULLET_TIME_PARAMS,
  MATCH_CUT_ENGINES,
  compileFollowUpPrompt,
  followUpRequests,
  submitAppFollowUp,
  viewUrlRef,
} from "@/lib/tools/appFollowUp";
import { COMMERCIAL_FACE_PRESETS } from "@/lib/tools/lookCatalogs";
import type { ToolImage } from "@/lib/tools/runTool";

const STEP1_URL =
  "/api/comfy/view?filename=sticker_0001.png&subfolder=cj&type=output";
const STEP1_REF = "cj/sticker_0001.png [output]";

function app(id: string): AppTemplate {
  const a = getApp(id);
  if (!a) throw new Error(`missing app ${id}`);
  return a;
}

const base = {
  id: "x_app",
  name: "X",
  category: "Scenes & FX",
  description: "d",
  prompt: "a long enough edit instruction for the test",
};

describe("app follow-up templates", () => {
  it("ships the sticker match cut and bullet-time plate apps", () => {
    expect(validateAppTemplates(rawApps)).toEqual([]);
    const sticker = app("sticker_swap_cut");
    expect(sticker.followUp).toMatchObject({ kind: "match_cut", cutout: true });
    const orbit = app("frozen_orbit");
    expect(orbit.followUp?.kind).toBe("bullet_time");
    // The plate prompt removes the subject; the orbit runs on the photo.
    expect(orbit.prompt).toMatch(/remove the main subject/i);
    expect(orbit.prompt).toMatch(/background plate/i);
    for (const a of [sticker, orbit]) {
      expect(a.motion).toBeUndefined();
      expect(a.sound).toBeUndefined();
    }
  });

  it("validates followUp shape", () => {
    const check = (followUp: unknown, extra: object = {}) =>
      validateAppTemplates({ apps: [{ ...base, ...extra, followUp }] });
    expect(
      check({ kind: "match_cut", label: "Step 2", prompt: "go", cutout: true }),
    ).toEqual([]);
    expect(check({ kind: "spin", label: "L", prompt: "p" })[0]).toMatch(
      /unknown followUp kind/,
    );
    expect(check({ kind: "bullet_time", label: "", prompt: "p" })[0]).toMatch(
      /label/,
    );
    expect(
      check({ kind: "bullet_time", label: "L", prompt: "p", cutout: true })[0],
    ).toMatch(/cutout is only for match_cut/);
    expect(
      check(
        { kind: "bullet_time", label: "L", prompt: "p" },
        { motion: "slow push" },
      )[0],
    ).toMatch(/replaces motion/);
  });
});

describe("viewUrlRef", () => {
  it("turns a job image URL into an annotated ref", () => {
    expect(viewUrlRef(STEP1_URL)).toBe(STEP1_REF);
    expect(viewUrlRef("/api/comfy/view?filename=a.png&type=temp")).toBe(
      "a.png [temp]",
    );
  });

  it("rejects unsafe or non-view URLs", () => {
    expect(viewUrlRef(undefined)).toBeNull();
    expect(viewUrlRef("/api/comfy/image?filename=a.png")).toBeNull();
    expect(
      viewUrlRef("/api/comfy/view?filename=a.png&subfolder=../x&type=output"),
    ).toBeNull();
    expect(viewUrlRef("/api/comfy/view?filename=a.txt&type=output")).toBeNull();
  });
});

describe("followUpRequests", () => {
  const source = { runId: "src", jobIndex: 0 };

  it("sticker match cut: cut-out first, then an LTX-2.5 transition", () => {
    const reqs = followUpRequests(app("sticker_swap_cut"), {
      source,
      step1Ref: STEP1_REF,
      clientId: "c1",
    });
    expect(reqs.map((r) => r.url)).toEqual([
      "/api/jobs/tool",
      "/api/jobs/action",
    ]);
    expect(reqs[0].body).toEqual({
      toolId: APP_CUTOUT_TOOL,
      images: [STEP1_REF],
      options: {},
      client_id: "c1",
    });
    expect(APP_CUTOUT_TOOL).toBe("qwen21-remove-bg");
    expect(reqs[1].body).toMatchObject({
      run_id: "src",
      job_index: 0,
      action: "ltx25_transition",
      params: {
        pack_id: "ltx25",
        secondRefImage: STEP1_REF,
        duration: "5",
        prompt: app("sticker_swap_cut").followUp!.prompt,
      },
    });
  });

  it("H3 is opt-in, never the default", () => {
    expect(MATCH_CUT_ENGINES[0].id).toBe("ltx25");
    const reqs = followUpRequests(app("sticker_swap_cut"), {
      source,
      step1Ref: STEP1_REF,
      clientId: "c1",
      engine: "h3",
      prompt: "  whip cut  ",
    });
    expect(reqs[1].body).toMatchObject({
      action: "transition",
      params: {
        pack_id: "minimax",
        secondRefImage: STEP1_REF,
        prompt: "whip cut",
      },
    });
    expect(reqs[1].body.params as object).not.toHaveProperty("duration");
    // Unknown engine id falls back to the default.
    const fallback = followUpRequests(app("sticker_swap_cut"), {
      source,
      step1Ref: STEP1_REF,
      clientId: "c1",
      engine: "nope",
    });
    expect(fallback[1].body.action).toBe("ltx25_transition");
  });

  it("bullet time: one wan_motion orbit on the original photo", () => {
    const reqs = followUpRequests(app("frozen_orbit"), {
      source,
      step1Ref: STEP1_REF,
      clientId: "c1",
      prompt: "a dancer mid-leap",
    });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].body).toEqual({
      run_id: "src",
      job_index: 0,
      client_id: "c1",
      action: "wan_motion",
      params: { ...BULLET_TIME_PARAMS, prompt: "a dancer mid-leap" },
    });
  });

  it("plain apps have no follow-up", () => {
    expect(
      followUpRequests(app("figurine"), {
        source,
        step1Ref: STEP1_REF,
        clientId: "c1",
      }),
    ).toEqual([]);
    expect(compileFollowUpPrompt(app("frozen_orbit"), "")).toBe("the subject");
  });
});

describe("submitAppFollowUp", () => {
  function mockFetch() {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    let n = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url, body });
      const json =
        url === "/api/comfy/upload"
          ? { ref: "cj_tool_1.png [input]" }
          : url === "/api/jobs/seed-run"
            ? { run: { run_id: "seeded", jobs: [{ index: 0 }] } }
            : { run: { run_id: `r${++n}`, jobs: [{ prompt_id: `p${n}` }] } };
      return { ok: true, status: 200, json: async () => json };
    };
    return { calls, fetchImpl };
  }

  const gallery: ToolImage = {
    id: "g",
    source: "gallery",
    previewUrl: "",
    label: "photo",
    width: 1024,
    height: 1024,
    runId: "orig",
    jobIndex: 2,
  };

  it("gallery photo: reuses its run, queues cut-out then clip", async () => {
    const { calls, fetchImpl } = mockFetch();
    const seen: string[] = [];
    const runs = await submitAppFollowUp({
      fetchImpl,
      app: app("sticker_swap_cut"),
      image: gallery,
      step1Url: STEP1_URL,
      clientId: "c1",
      onRun: (_r, label) => seen.push(label),
    });
    expect(runs.map((r) => r.run_id)).toEqual(["r1", "r2"]);
    expect(seen).toEqual(["Sticker cut-out", "Match-cut clip"]);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/jobs/tool",
      "/api/jobs/action",
    ]);
    expect(calls[1].body).toMatchObject({ run_id: "orig", job_index: 2 });
  });

  it("uploaded photo: seeds a source run first", async () => {
    const { calls, fetchImpl } = mockFetch();
    await submitAppFollowUp({
      fetchImpl,
      app: app("frozen_orbit"),
      image: {
        ...gallery,
        source: "upload",
        runId: undefined,
        dataUrl: "data:image/png;base64,AAAA",
      },
      step1Url: STEP1_URL,
      clientId: "c1",
    });
    expect(calls.map((c) => c.url)).toEqual([
      "/api/comfy/upload",
      "/api/jobs/seed-run",
      "/api/jobs/action",
    ]);
    expect(calls[2].body).toMatchObject({
      run_id: "seeded",
      action: "wan_motion",
    });
  });

  it("refuses without a usable step-1 image", async () => {
    const { calls, fetchImpl } = mockFetch();
    await expect(
      submitAppFollowUp({
        fetchImpl,
        app: app("frozen_orbit"),
        image: gallery,
        step1Url: undefined,
        clientId: "c1",
      }),
    ).rejects.toThrow(/Step 1/);
    expect(calls).toEqual([]);
  });

  it("surfaces a server error with the step label", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: "pack ltx25 not installed" }),
    });
    await expect(
      submitAppFollowUp({
        fetchImpl,
        app: app("sticker_swap_cut"),
        image: gallery,
        step1Url: STEP1_URL,
        clientId: "c1",
      }),
    ).rejects.toThrow("Sticker cut-out: pack ltx25 not installed");
  });
});

describe("Commercial Faces studio setups", () => {
  it("adds identity-neutral studio lighting presets", () => {
    const studio = COMMERCIAL_FACE_PRESETS.filter((p) => p.group === "Studio");
    expect(studio.length).toBeGreaterThanOrEqual(6);
    for (const p of studio) {
      // Setups describe light and backdrop only: no age, ethnicity or gender.
      expect(p.prompt).not.toMatch(
        /\b(young|old|elderly|teen|male|female|man|woman|asian|black person|white person|latin|african|european)\b/i,
      );
      expect(p.prompt).toMatch(/Keep their face, identity and body type/);
    }
  });
});

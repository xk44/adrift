/**
 * Train audio LoRA: pure rules (presets, validation, graph), the upload
 * subfolder allowlist, the client upload/status helpers and both routes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  AUDIO_LORA_MAX_CLIPS,
  AUDIO_LORA_NODE,
  AUDIO_LORA_PRESETS,
  audioLoraStageText,
  buildAudioLoraGraph,
  clipUploadName,
  defaultCaption,
  historyErrorMessage,
  parseAudioLoraOutputs,
  presetSettings,
  sanitizeLoraName,
  validateAudioLoraInput,
  type AudioLoraInput,
} from "@/lib/training/audioLora";
import { safeUploadName, safeUploadSubfolder } from "@/lib/comfy/uploadName";
import {
  cancelAudioLoraTraining,
  getAudioLoraStatus,
  startAudioLoraTraining,
  uploadAudioLoraClips,
} from "@/lib/training/audioLoraSubmit";
import {
  trainAudioLoraCards,
  TRAIN_AUDIO_LORA_KEY,
} from "@/lib/tools/audioLoraCard";

vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/comfy/http", () => {
  class ComfyAPIError extends Error {
    constructor(
      message: string,
      public statusCode?: number,
    ) {
      super(message);
    }
  }
  return {
    ComfyAPIError,
    queuePrompt: vi.fn(),
    fetchHistory: vi.fn(),
    uploadImageToComfy: vi.fn(),
  };
});
vi.mock("@/lib/comfy/comfyFetch", () => ({ comfyFetch: vi.fn() }));
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  getObjectInfoCached: vi.fn(),
}));

import {
  fetchHistory,
  queuePrompt,
  uploadImageToComfy,
} from "@/lib/comfy/http";
import { comfyFetch } from "@/lib/comfy/comfyFetch";
import { getObjectInfoCached } from "@/lib/comfy/objectInfoCache";
import { BRAND_LEAK } from "./brandLeak";

const clip = (i: number, over: Partial<AudioLoraInput["clips"][0]> = {}) => ({
  filename: `clip${i}.wav`,
  size: 1000,
  caption: "warm pad",
  ...over,
});

const okInput = (over: Partial<AudioLoraInput> = {}): AudioLoraInput => ({
  name: "drums",
  base: "medium-base",
  adapter: "lora",
  ...presetSettings("balanced"),
  clips: [0, 1, 2, 3, 4].map((i) => clip(i)),
  ...over,
});

describe("audio LoRA presets", () => {
  it("has quick/balanced/detailed with growing steps and rank and a hint each", () => {
    expect(AUDIO_LORA_PRESETS.map((p) => p.id)).toEqual([
      "quick",
      "balanced",
      "detailed",
    ]);
    const [q, b, d] = AUDIO_LORA_PRESETS.map((p) => p.settings);
    expect(q.steps).toBeLessThan(b.steps);
    expect(b.steps).toBeLessThan(d.steps);
    expect(q.rank).toBeLessThan(d.rank);
    for (const p of AUDIO_LORA_PRESETS) {
      expect(p.hint.length).toBeGreaterThan(10);
      expect(validateAudioLoraInput(okInput(p.settings))).toBeNull();
    }
  });

  it("presetSettings returns a copy", () => {
    const s = presetSettings("quick");
    s.steps = 1;
    expect(presetSettings("quick").steps).toBe(500);
  });
});

describe("names and captions", () => {
  it("sanitizes names like the node", () => {
    expect(sanitizeLoraName("  My Drums v2 ")).toBe("My_Drums_v2");
    expect(sanitizeLoraName("../evil")).toBe("evil");
    expect(sanitizeLoraName("é")).toBe("");
    expect(sanitizeLoraName("x".repeat(80))).toHaveLength(64);
  });

  it("derives captions from filenames (same rule as the node)", () => {
    expect(defaultCaption("03_Warm-Rhodes_loop.wav")).toBe("warm rhodes loop");
    expect(defaultCaption("kickDrum.mp3")).toBe("kick drum");
    expect(defaultCaption("___.wav")).toBe("audio clip");
  });

  it("upload names are unique, indexed and survive safeUploadName", () => {
    const a = clipUploadName(0, "My Kick (final).WAV");
    expect(a).toBe("01_My_Kick_final.wav");
    expect(safeUploadName(a)).toBe(a);
    expect(clipUploadName(11, "../../x.flac")).toBe("12_x.flac");
    expect(clipUploadName(2, "é.mp3")).toBe("03_clip.mp3");
    expect(defaultCaption(a)).toBe("my kick final");
  });
});

describe("validateAudioLoraInput", () => {
  it("accepts a good job", () => {
    expect(validateAudioLoraInput(okInput())).toBeNull();
  });

  it.each([
    [{ name: "" }, /name/i],
    [{ name: "bad name" }, /letters/i],
    [{ clips: [clip(0)] }, /at least 5/],
    [
      {
        clips: Array.from({ length: AUDIO_LORA_MAX_CLIPS + 1 }, (_, i) =>
          clip(i),
        ),
      },
      /at most/,
    ],
    [
      {
        clips: [0, 1, 2, 3]
          .map((i) => clip(i))
          .concat(clip(9, { filename: "x.m4a" })),
      },
      /WAV, MP3 or FLAC/,
    ],
    [
      {
        clips: [0, 1, 2, 3]
          .map((i) => clip(i))
          .concat(clip(9, { size: 40 * 1024 * 1024 })),
      },
      /32 MB/,
    ],
    [
      { clips: [0, 1, 2, 3].map((i) => clip(i)).concat(clip(9, { size: 0 })) },
      /empty/,
    ],
    [{ rank: 0 }, /Rank/],
    [{ rank: 8.5 }, /Rank/],
    [{ steps: 5 }, /Steps/],
    [{ lr: 0.5 }, /Learning rate/],
    [{ lr: Number.NaN }, /Learning rate/],
  ] as [Partial<AudioLoraInput>, RegExp][])("rejects %o", (over, re) => {
    expect(validateAudioLoraInput(okInput(over))).toMatch(re);
  });
});

describe("buildAudioLoraGraph", () => {
  it("is one CJSA3TrainAudioLoRA node pointed at sa3_train/<name>", () => {
    const g = buildAudioLoraGraph({
      name: "drums",
      base: "small-sfx-base",
      adapter: "dora-rows",
      rank: 32,
      lr: 1e-4,
      steps: 1500,
      captions: { "01_kick.wav": "kick", "02_snare.wav": "" },
    });
    expect(Object.keys(g)).toEqual(["1"]);
    const n = g["1"];
    expect(n.class_type).toBe(AUDIO_LORA_NODE);
    expect(n.inputs).toMatchObject({
      name: "drums",
      dataset: "sa3_train/drums",
      base: "small-sfx-base",
      adapter_type: "dora-rows",
      rank: 32,
      alpha: 0,
      steps: 1500,
      lr: 1e-4,
      batch_size: 1,
      duration: 30,
      seed: 42,
    });
    expect(JSON.parse(n.inputs.captions as string)).toEqual({
      "01_kick.wav": "kick",
      "02_snare.wav": "",
    });
  });
});

describe("history parsing", () => {
  it("finds the LoRA report in outputs", () => {
    expect(
      parseAudioLoraOutputs({
        "1": {
          text: ["Saved loras/audio/d.safetensors: 5 clips"],
          cj_sa3_lora: [{ lora: "audio/d.safetensors" }],
        },
      }),
    ).toEqual({
      lora: "audio/d.safetensors",
      summary: "Saved loras/audio/d.safetensors: 5 clips",
    });
    expect(parseAudioLoraOutputs({ "1": { text: ["x"] } })).toBeNull();
    expect(parseAudioLoraOutputs(null)).toBeNull();
  });

  it("reads execution errors and interrupts", () => {
    expect(historyErrorMessage({ status_str: "success" })).toBeNull();
    expect(
      historyErrorMessage({
        status_str: "error",
        messages: [
          [
            "execution_error",
            { exception_message: "need at least 5 audio clips, found 3" },
          ],
        ],
      }),
    ).toBe("need at least 5 audio clips, found 3");
    expect(
      historyErrorMessage({
        status_str: "error",
        messages: [["execution_interrupted", {}]],
      }),
    ).toBe("Training was stopped.");
    expect(historyErrorMessage({ status_str: "error" })).toMatch(/failed/);
  });

  it("stage text", () => {
    expect(audioLoraStageText({ phase: "uploading", done: 3, total: 10 })).toBe(
      "Uploading clips (3/10)...",
    );
    expect(
      audioLoraStageText({ phase: "training", done: 150, total: 1500 }),
    ).toBe("Training: step 150/1500 (10%)");
    expect(audioLoraStageText({ phase: "queued" })).toMatch(/Waiting/);
  });
});

describe("safeUploadSubfolder", () => {
  it("allows only sa3_train/<name>", () => {
    expect(safeUploadSubfolder(undefined)).toBe("");
    expect(safeUploadSubfolder("")).toBe("");
    expect(safeUploadSubfolder("sa3_train/drums_v2")).toBe(
      "sa3_train/drums_v2",
    );
    for (const bad of [
      "sa3_train",
      "sa3_train/../x",
      "../sa3_train/x",
      "other/x",
      "sa3_train/a/b",
      "/sa3_train/x",
      5,
    ]) {
      expect(safeUploadSubfolder(bad)).toBeNull();
    }
  });
});

describe("hub card", () => {
  it("is an always-available Audio special card", () => {
    const [c] = trainAudioLoraCards();
    expect(c.key).toBe(TRAIN_AUDIO_LORA_KEY);
    expect(c.hubCategory).toBe("Audio");
    expect(c.kind).toBe("special");
    expect(c.aliases).toContain("audio lora");
    expect(`${c.title} ${c.subtitle}`).not.toMatch(
      BRAND_LEAK,
    );
  });
});

function jsonRes(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("uploadAudioLoraClips", () => {
  it("uploads into sa3_train/<name> and waits on 429", async () => {
    const calls: Record<string, unknown>[] = [];
    let first429 = true;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 2 && first429) {
        first429 = false;
        return jsonRes({ ok: false, error: "Too many requests" }, 429, {
          "Retry-After": "60",
        });
      }
      return jsonRes({ ok: true, ref: "x [input]" });
    });
    const sleep = vi.fn(async () => {});
    const progress: [number, number, boolean][] = [];
    await uploadAudioLoraClips(
      "drums",
      [
        { blob: new Blob(["a"]), uploadName: "01_a.wav" },
        { blob: new Blob(["b"]), uploadName: "02_b.wav" },
      ],
      {
        fetchImpl,
        toDataUrl: async () => "data:audio/wav;base64,AA==",
        sleep,
        onProgress: (d, t, w) => progress.push([d, t, w]),
      },
    );
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      filename: "01_a.wav",
      subfolder: "sa3_train/drums",
    });
    expect(calls[2]).toMatchObject({ filename: "02_b.wav" });
    expect(sleep).toHaveBeenCalledWith(60_000);
    expect(progress).toContainEqual([1, 2, true]);
    expect(progress.at(-1)).toEqual([2, 2, false]);
  });

  it("throws with the file name on a hard failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ ok: false, error: "subfolder not allowed" }, 400),
    );
    await expect(
      uploadAudioLoraClips(
        "d",
        [{ blob: new Blob(["a"]), uploadName: "01_a.wav" }],
        {
          fetchImpl,
          toDataUrl: async () => "data:,",
        },
      ),
    ).rejects.toThrow("01_a.wav: subfolder not allowed");
  });
});

describe("client start/status", () => {
  it("startAudioLoraTraining returns prompt and client ids", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRes({ ok: true, prompt_id: "p1", client_id: "c1" }),
    );
    await expect(
      startAudioLoraTraining(
        {
          name: "d",
          base: "medium-base",
          adapter: "lora",
          rank: 16,
          lr: 1e-4,
          steps: 500,
          captions: {},
        },
        fetchImpl,
      ),
    ).resolves.toEqual({ promptId: "p1", clientId: "c1" });
  });

  it("getAudioLoraStatus normalizes state", async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ ok: true, state: "weird" }));
    await expect(getAudioLoraStatus("p1", fetchImpl)).resolves.toMatchObject({
      state: "unknown",
    });
  });

  it("cancel confirms the global interrupt on old ComfyUI", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonRes(
        bodies.length === 1
          ? { ok: true, action: "confirm-global-interrupt" }
          : { ok: true, action: "interrupt" },
      );
    });
    await cancelAudioLoraTraining("p1", fetchImpl);
    expect(bodies).toEqual([
      { prompt_id: "p1" },
      { prompt_id: "p1", confirm_global: true },
    ]);
    bodies.length = 0;
    fetchImpl.mockImplementation(async (_u: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonRes({ ok: true, action: "interrupt" });
    });
    await cancelAudioLoraTraining("p1", fetchImpl);
    expect(bodies).toHaveLength(1);
  });
});

const req = (path: string, init?: { method?: string; body?: unknown }) =>
  new NextRequest(`http://localhost:3000${path}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });

describe("POST /api/comfy/upload subfolder", () => {
  beforeEach(() => {
    vi.mocked(uploadImageToComfy).mockReset();
  });

  it("passes an allowed subfolder through", async () => {
    vi.mocked(uploadImageToComfy).mockResolvedValue(
      "sa3_train/d/01_a.wav [input]",
    );
    const { POST } = await import("@/app/api/comfy/upload/route");
    const res = await POST(
      req("/api/comfy/upload", {
        method: "POST",
        body: {
          image: "data:audio/wav;base64,AAAA",
          filename: "01_a.wav",
          subfolder: "sa3_train/d",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(uploadImageToComfy).mock.calls[0][1]).toBe("01_a.wav");
    expect(vi.mocked(uploadImageToComfy).mock.calls[0][2]).toBe("sa3_train/d");
  });

  it("keeps the input root when no subfolder is given", async () => {
    vi.mocked(uploadImageToComfy).mockResolvedValue("a.png [input]");
    const { POST } = await import("@/app/api/comfy/upload/route");
    await POST(
      req("/api/comfy/upload", {
        method: "POST",
        body: { image: "data:image/png;base64,AAAA" },
      }),
    );
    expect(vi.mocked(uploadImageToComfy).mock.calls[0][2]).toBe("");
  });

  it("rejects other subfolders", async () => {
    const { POST } = await import("@/app/api/comfy/upload/route");
    const res = await POST(
      req("/api/comfy/upload", {
        method: "POST",
        body: {
          image: "data:audio/wav;base64,AAAA",
          filename: "a.wav",
          subfolder: "../models",
        },
      }),
    );
    expect(res.status).toBe(400);
    expect(uploadImageToComfy).not.toHaveBeenCalled();
  });
});

describe("/api/tools/audio-lora", () => {
  const caps = Object.fromEntries(
    [1, 2, 3, 4, 5].map((i) => [`0${i}_clip.wav`, "pad"]),
  );
  const body = {
    name: "drums",
    base: "medium-base",
    adapter: "lora",
    rank: 16,
    lr: 1e-4,
    steps: 500,
    captions: caps,
  };

  beforeEach(() => {
    vi.mocked(queuePrompt).mockReset();
    vi.mocked(fetchHistory).mockReset();
    vi.mocked(comfyFetch).mockReset();
    vi.mocked(getObjectInfoCached).mockReset();
  });

  it("GET reports availability from object_info", async () => {
    const { GET } = await import("@/app/api/tools/audio-lora/route");
    vi.mocked(getObjectInfoCached).mockResolvedValue({ [AUDIO_LORA_NODE]: {} });
    expect(
      await (await GET(req("/api/tools/audio-lora"))).json(),
    ).toMatchObject({ ok: true, available: true });
    vi.mocked(getObjectInfoCached).mockResolvedValue({});
    const off = await (await GET(req("/api/tools/audio-lora"))).json();
    expect(off.available).toBe(false);
    expect(off.reason).toMatch(/not installed/);
    vi.mocked(getObjectInfoCached).mockResolvedValue(null);
    expect(
      (await (await GET(req("/api/tools/audio-lora"))).json()).available,
    ).toBe(false);
  });

  it("POST builds the graph server-side with its own client id", async () => {
    vi.mocked(queuePrompt).mockResolvedValue({ prompt_id: "pid-123456" });
    const { POST } = await import("@/app/api/tools/audio-lora/route");
    const res = await POST(
      req("/api/tools/audio-lora", {
        method: "POST",
        body: { ...body, extra: "ignored" },
      }),
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.prompt_id).toBe("pid-123456");
    expect(data.client_id).toMatch(/^cj_sa3train_/);
    const [graph, clientId] = vi.mocked(queuePrompt).mock.calls[0];
    expect(clientId).toBe(data.client_id);
    expect(graph).toEqual(
      buildAudioLoraGraph({
        name: "drums",
        base: "medium-base",
        adapter: "lora",
        rank: 16,
        lr: 1e-4,
        steps: 500,
        captions: caps,
      }),
    );
  });

  it.each([
    { name: "../x" },
    { base: "huge" },
    { rank: 0 },
    { lr: 1 },
    { steps: 1 },
    { captions: { "01_a.wav": "x" } },
    { captions: { ...caps, "../evil.wav": "x" } },
    { captions: { ...caps, "06_x.m4a": "x" } },
  ])("POST rejects %o", async (over) => {
    const { POST } = await import("@/app/api/tools/audio-lora/route");
    const res = await POST(
      req("/api/tools/audio-lora", {
        method: "POST",
        body: { ...body, ...over },
      }),
    );
    expect(res.status).toBe(400);
    expect(queuePrompt).not.toHaveBeenCalled();
  });

  it("GET ?prompt_id reports queue state, result and errors", async () => {
    const { GET } = await import("@/app/api/tools/audio-lora/route");
    const pid = "abcd-1234-ef";
    vi.mocked(comfyFetch).mockResolvedValue(
      jsonRes({ queue_running: [[0, pid, {}]], queue_pending: [] }) as never,
    );
    expect(
      (await (await GET(req(`/api/tools/audio-lora?prompt_id=${pid}`))).json())
        .state,
    ).toBe("running");

    vi.mocked(comfyFetch).mockResolvedValue(
      jsonRes({ queue_running: [], queue_pending: [] }) as never,
    );
    vi.mocked(fetchHistory).mockResolvedValue({
      outputs: {
        "1": {
          text: ["Saved"],
          cj_sa3_lora: [{ lora: "audio/drums.safetensors" }],
        },
      },
      status: { status_str: "success" },
    } as never);
    expect(
      await (await GET(req(`/api/tools/audio-lora?prompt_id=${pid}`))).json(),
    ).toMatchObject({
      state: "done",
      lora: "audio/drums.safetensors",
      summary: "Saved",
    });

    vi.mocked(fetchHistory).mockResolvedValue({
      outputs: {},
      status: {
        status_str: "error",
        messages: [["execution_error", { exception_message: "boom" }]],
      },
    } as never);
    expect(
      await (await GET(req(`/api/tools/audio-lora?prompt_id=${pid}`))).json(),
    ).toMatchObject({
      state: "error",
      error: "boom",
    });

    vi.mocked(fetchHistory).mockResolvedValue(null);
    expect(
      (await (await GET(req(`/api/tools/audio-lora?prompt_id=${pid}`))).json())
        .state,
    ).toBe("unknown");

    expect(
      (await GET(req("/api/tools/audio-lora?prompt_id=../x"))).status,
    ).toBe(400);
  });
});

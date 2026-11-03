/**
 * App templates slice: Fashion Factory outfit sets, Talking Avatar presets +
 * delivery, ASMR sound presets and the App step-3 add_sound chain.
 */
import { describe, expect, it, vi } from "vitest";
import type { ImagineRun } from "@/types";
import { TEMPLATES, getTemplate, templateSetIds } from "@/lib/tools/templates";
import { FASHION_SETS, WARDROBE_PRESETS } from "@/lib/tools/lookCatalogs";
import {
  AVATAR_GESTURES,
  AVATAR_PRESETS,
  avatarImagePrompt,
  composeAvatarScene,
  getAvatarPreset,
} from "@/lib/tools/avatarPresets";
import { generateAvatar } from "@/lib/tools/avatarGenerate";
import { ASMR_SOUNDS, composeAsmrPrompt } from "@/lib/tools/asmrPresets";
import {
  buildActionRequest,
  defaultSettings,
  getActionTool,
} from "@/lib/tools/toolsPage";
import {
  appSoundParams,
  compileSoundPrompt,
  getApp,
  shouldAutoSound,
  validateAppTemplates,
} from "@/lib/tools/apps";
import { submitAddSound } from "@/lib/tools/runTool";
import { buildHubCards } from "@/lib/tools/hub";

// Brand words the public export gate rejects (built from parts on purpose).
const BANNED = new RegExp(
  ["mid" + "journey", "\\bM" + "J\\b", "higgs" + "field"].join("|"),
  "i",
);

const json = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

describe("Fashion Factory", () => {
  const ff = getTemplate("fashion_factory")!;

  it("is a multi-look Portraits & Fashion template over the wardrobe catalog", () => {
    expect(ff).toBeDefined();
    expect(ff.hubCategory).toBe("Portraits");
    expect(ff.multi?.max).toBe(8);
    expect(ff.presets).toBe(WARDROBE_PRESETS);
    expect(TEMPLATES.filter((t) => t.id === "fashion_factory")).toHaveLength(1);
  });

  it("every set names real, unique wardrobe looks, at most 8", () => {
    const known = new Set(WARDROBE_PRESETS.map((p) => p.id));
    expect(FASHION_SETS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(FASHION_SETS.map((s) => s.id)).size).toBe(
      FASHION_SETS.length,
    );
    for (const s of FASHION_SETS) {
      expect(s.presetIds.length, s.id).toBeGreaterThanOrEqual(3);
      expect(s.presetIds.length, s.id).toBeLessThanOrEqual(8);
      expect(new Set(s.presetIds).size, s.id).toBe(s.presetIds.length);
      for (const id of s.presetIds)
        expect(known.has(id), `${s.id}/${id}`).toBe(true);
      expect(s.label, s.id).not.toMatch(BANNED);
    }
  });

  it("templateSetIds expands a set, drops unknown/dupes, caps at max", () => {
    const first = FASHION_SETS[0];
    expect(templateSetIds(ff, first.id)).toEqual(first.presetIds);
    expect(templateSetIds(ff, "nope")).toEqual([]);
    const real = WARDROBE_PRESETS.map((p) => p.id);
    const t = {
      ...ff,
      multi: { max: 3, defaultCount: 0 },
      sets: [
        {
          id: "x",
          label: "X",
          presetIds: [real[0], "ghost", real[0], real[1], real[2], real[3]],
        },
      ],
    };
    expect(templateSetIds(t, "x")).toEqual([real[0], real[1], real[2]]);
  });

  it("shows up as a hub card", () => {
    const keys = buildHubCards({
      toolCards: [],
      ctx: {
        catalog: [],
        packIds: new Set(),
        editLoras: { families: {}, loras: [] },
      },
    }).map((c) => c.key);
    expect(keys.some((k) => k.endsWith(":fashion_factory"))).toBe(true);
  });
});

describe("Talking Avatar presets", () => {
  it("has 20 original, unique, grouped presets", () => {
    expect(AVATAR_PRESETS).toHaveLength(20);
    expect(new Set(AVATAR_PRESETS.map((p) => p.id)).size).toBe(20);
    for (const p of AVATAR_PRESETS) {
      expect(p.group, p.id).toBeTruthy();
      expect(p.description.length, p.id).toBeGreaterThan(20);
      expect(p.scene.length, p.id).toBeGreaterThan(10);
      expect(`${p.label} ${p.description} ${p.scene}`, p.id).not.toMatch(
        BANNED,
      );
    }
    expect(
      new Set(AVATAR_PRESETS.map((p) => p.group)).size,
    ).toBeGreaterThanOrEqual(3);
  });

  it("builds a front-facing fictional portrait prompt", () => {
    const p = AVATAR_PRESETS[0];
    const prompt = avatarImagePrompt(p, "  red scarf ");
    expect(prompt.startsWith(`Portrait of ${p.description}`)).toBe(true);
    expect(prompt).toContain("red scarf");
    expect(prompt).toContain("original fictional person");
    expect(prompt).toMatch(/--ar 9:16$/);
    expect(avatarImagePrompt(p)).not.toContain(", ,");
    expect(avatarImagePrompt(p, "x".repeat(400)).length).toBeLessThan(
      avatarImagePrompt(p).length + 170,
    );
    expect(getAvatarPreset(p.id)).toBe(p);
    expect(getAvatarPreset("nope")).toBeUndefined();
  });

  it("gestures: first is neutral; scene composes text + phrase", () => {
    expect(AVATAR_GESTURES[0].phrase).toBe("");
    expect(new Set(AVATAR_GESTURES.map((g) => g.id)).size).toBe(
      AVATAR_GESTURES.length,
    );
    const g = AVATAR_GESTURES[1];
    expect(composeAvatarScene(" a host ", g.id)).toBe(`a host, ${g.phrase}`);
    expect(composeAvatarScene("", g.id)).toBe(g.phrase);
    expect(composeAvatarScene("a host", "none")).toBe("a host");
    expect(composeAvatarScene("", "none")).toBe("");
  });

  it("talking_avatar request carries the delivery phrase", () => {
    const spec = getActionTool("talking_avatar")!;
    expect(spec.pickers?.some((p) => p.key === "gesture")).toBe(true);
    const g = AVATAR_GESTURES[1];
    const s = {
      ...defaultSettings(spec),
      text: "a host",
      picks: { mode: "fast", gesture: g.id },
    };
    expect(
      buildActionRequest(spec, s, null, undefined, { ref: "a.wav [input]" })
        .params,
    ).toMatchObject({ prompt: `a host, ${g.phrase}`, mode: "fast" });
    const bare = buildActionRequest(
      spec,
      defaultSettings(spec),
      null,
      undefined,
      {
        ref: "a.wav [input]",
      },
    ).params;
    expect(bare).not.toHaveProperty("prompt");
  });

  it("generateAvatar queues text-to-image and returns a gallery source", async () => {
    const run = {
      run_id: "av1",
      jobs: [
        {
          index: 0,
          seed: 1,
          status: "queued",
          progress: 0,
          images: [],
          prompt_id: "p1",
        },
      ],
    } as unknown as ImagineRun;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/jobs/imagine") {
        const body = JSON.parse(String(init?.body));
        expect(body.prompt).toContain("original fictional person");
        expect(body.client_id).toBe("c");
        return json({ runs: [run] });
      }
      expect(url).toBe("/api/comfy/history/p1");
      return json({
        status: { status_str: "success" },
        images: [{ filename: "a.png", url: "/api/comfy/view?filename=a.png" }],
      });
    });
    const onRun = vi.fn();
    const img = await generateAvatar(
      {
        fetchImpl: fetchImpl as never,
        clientId: "c",
        onRun,
        sleep: async () => {},
        pollMs: 1,
        timeoutMs: 1000,
      } as never,
      AVATAR_PRESETS[0],
    );
    expect(onRun).toHaveBeenCalledWith(run);
    expect(img).toMatchObject({ source: "gallery", runId: "av1", jobIndex: 0 });
    expect(img.previewUrl).toContain("a.png");
  });

  it("generateAvatar surfaces server errors", async () => {
    const fetchImpl = vi.fn(async () => json({ error: "busy" }, false, 503));
    await expect(
      generateAvatar(
        { fetchImpl: fetchImpl as never, clientId: "c" } as never,
        AVATAR_PRESETS[0],
      ),
    ).rejects.toThrow("busy");
  });
});

describe("ASMR presets", () => {
  it("catalog: neutral first, unique ids, grouped, clean copy", () => {
    expect(ASMR_SOUNDS[0]).toMatchObject({ id: "none", phrase: "" });
    expect(new Set(ASMR_SOUNDS.map((s) => s.id)).size).toBe(ASMR_SOUNDS.length);
    expect(ASMR_SOUNDS.length).toBeGreaterThanOrEqual(12);
    for (const s of ASMR_SOUNDS.slice(1)) {
      expect(s.group, s.id).toBeTruthy();
      expect(s.phrase.length, s.id).toBeGreaterThan(10);
      expect(`${s.label} ${s.phrase}`, s.id).not.toMatch(BANNED);
    }
  });

  it("composeAsmrPrompt: preset phrase then user words", () => {
    const s = ASMR_SOUNDS[1];
    expect(composeAsmrPrompt(s.id, " on glass ")).toBe(`${s.phrase}, on glass`);
    expect(composeAsmrPrompt(s.id, "")).toBe(s.phrase);
    expect(composeAsmrPrompt("none", "rain")).toBe("rain");
    expect(composeAsmrPrompt("none", "")).toBe("");
  });

  it("add_sound request uses the preset", () => {
    const spec = getActionTool("add_sound")!;
    expect(spec.pickers?.some((p) => p.key === "asmr")).toBe(true);
    const s = ASMR_SOUNDS[1];
    expect(
      buildActionRequest(
        spec,
        { ...defaultSettings(spec), text: "close", picks: { asmr: s.id } },
        null,
      ).params,
    ).toEqual({ pack_id: "audio", prompt: `${s.phrase}, close` });
    expect(
      buildActionRequest(spec, defaultSettings(spec), null).params,
    ).toEqual({
      pack_id: "audio",
    });
  });
});

describe("App step 3: add sound", () => {
  const ids = ["asmr_classic", "asmr_addon", "asmr_host"];

  it("ASMR apps animate and sound automatically, with original copy", () => {
    for (const id of ids) {
      const a = getApp(id)!;
      expect(a, id).toBeDefined();
      expect(a.autoAnimate, id).toBe(true);
      expect(a.motion, id).toBeTruthy();
      expect(a.sound, id).toBeTruthy();
      expect(
        `${a.name} ${a.description} ${a.prompt} ${a.sound}`,
        id,
      ).not.toMatch(BANNED);
    }
  });

  it("validator: sound must be non-empty and needs a motion", () => {
    const base = {
      id: "t",
      name: "T",
      category: "Scenes & FX",
      description: "d",
      prompt: "A long enough edit instruction for the test app.",
    };
    expect(
      validateAppTemplates({ apps: [{ ...base, motion: "m", sound: "s" }] }),
    ).toEqual([]);
    expect(
      validateAppTemplates({ apps: [{ ...base, sound: "s" }] }).join(),
    ).toMatch(/sound needs a motion/);
    expect(
      validateAppTemplates({
        apps: [{ ...base, motion: "m", sound: " " }],
      }).join(),
    ).toMatch(/sound must be a non-empty string/);
  });

  it("sound params: custom text overrides; speech/music avoided", () => {
    const a = getApp("asmr_classic")!;
    expect(compileSoundPrompt(a)).toBe(a.sound);
    expect(compileSoundPrompt(a, "  rain  ")).toBe("rain");
    expect(appSoundParams(a)).toEqual({
      pack_id: "audio",
      prompt: a.sound,
      negative_prompt: "music, speech, voice, talking",
    });
    const plain = { ...a, sound: undefined };
    expect(appSoundParams(plain)).not.toHaveProperty("prompt");
  });

  it("shouldAutoSound fires once per finished clip", () => {
    const s = {
      enabled: true,
      clipRunId: "c1",
      clipDone: true,
      soundedRunId: null,
    };
    expect(shouldAutoSound(s)).toBe(true);
    expect(shouldAutoSound({ ...s, enabled: false })).toBe(false);
    expect(shouldAutoSound({ ...s, clipDone: false })).toBe(false);
    expect(shouldAutoSound({ ...s, clipRunId: null })).toBe(false);
    expect(shouldAutoSound({ ...s, soundedRunId: "c1" })).toBe(false);
    expect(shouldAutoSound({ ...s, soundedRunId: "c0" })).toBe(true);
  });

  it("submitAddSound posts add_sound on the clip run", async () => {
    const run = { run_id: "s1", jobs: [] } as unknown as ImagineRun;
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({ run }),
    );
    const out = await submitAddSound({
      fetchImpl: fetchImpl as never,
      runId: "clip",
      jobIndex: 0,
      params: { pack_id: "audio", prompt: "tap" },
      clientId: "c",
    });
    expect(out).toBe(run);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/jobs/action");
    expect(JSON.parse(String(init?.body))).toEqual({
      run_id: "clip",
      job_index: 0,
      action: "add_sound",
      client_id: "c",
      params: { pack_id: "audio", prompt: "tap" },
    });
  });
});

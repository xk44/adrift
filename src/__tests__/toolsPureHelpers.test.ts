/**
 * Focused tests for small pure helpers in src/lib/tools that the larger
 * feature suites never call directly: prompt compilers, step-id parsing,
 * picker fallbacks, graph rewiring and runner response parsing.
 */
import { describe, expect, it } from "vitest";
import type { ImagineRun } from "@/types";
import { cleanNotes, fillTemplate, withNotes } from "@/lib/tools/templates";
import { cleanToolPrompt } from "@/lib/tools/editTools";
import {
  CLIPCUT_STYLES,
  ccCanRerun,
  ccDependents,
  ccProgress,
  ccStepId,
  ccUpdateStep,
  clipCutStyle,
  clipMotionPrompt,
  initialClipCut,
  parseCcStepId,
} from "@/lib/tools/clipCut";
import { outputOf, promptIdOf, seedText } from "@/lib/tools/pipelineRunner";
import type { RunnerDeps } from "@/lib/tools/pipelineRunner";
import { rewireLinks } from "@/lib/tools/smartTrack";
import {
  GROUNDED_FAMILY,
  categoryRank,
  defaultSettings,
  editFamilies,
  editLorasIn,
  missingModelsReason,
  pickEditLora,
  pickValue,
  replacePersonPrompt,
  type ActionPicker,
  type ActionToolSpec,
  type EditLoraListResponse,
} from "@/lib/tools/toolsPage";
import {
  DUB_AUDIO_MAX_SECONDS,
  DUB_LIPSYNC_MAX_SECONDS,
  DUB_MAX_CHARS,
  dubLanguage,
  dubMaxSeconds,
  dubVoiceScript,
} from "@/lib/tools/dubVideo";

describe("templates prompt helpers", () => {
  it("cleanNotes collapses whitespace, trims and caps", () => {
    expect(cleanNotes(undefined)).toBe("");
    expect(cleanNotes("  a \n\t b  ")).toBe("a b");
    expect(cleanNotes("x".repeat(500))).toHaveLength(300);
    expect(cleanNotes("abcdef", 3)).toBe("abc");
  });

  it("withNotes appends a sentence, keeping existing end punctuation", () => {
    expect(withNotes("Make it red.", "")).toBe("Make it red.");
    expect(withNotes("Make it red.", "   ")).toBe("Make it red.");
    expect(withNotes("Make it red. ", "add rain")).toBe(
      "Make it red. add rain.",
    );
    expect(withNotes("Make it red.", "add rain!")).toBe(
      "Make it red. add rain!",
    );
    expect(withNotes("Make it red.", "really?")).toBe("Make it red. really?");
  });

  it("fillTemplate fills known keys, blanks unknown ones and tidies spacing", () => {
    expect(
      fillTemplate("A {who} at the {place}.", { who: "cat", place: "beach" }),
    ).toBe("A cat at the beach.");
    expect(
      fillTemplate("A photo of {who} {extra} , today .", { who: "a dog" }),
    ).toBe("A photo of a dog, today.");
    expect(fillTemplate("{a}  {b}", { a: " x ", b: "\ny\n" })).toBe("x y");
  });

  it("fillTemplate does not re-expand placeholders or $ patterns in values", () => {
    expect(fillTemplate("say {a}", { a: "{b} $& $1", b: "nope" })).toBe(
      "say {b} $& $1",
    );
  });

  it("fillTemplate caps each value like cleanNotes", () => {
    const out = fillTemplate("{a}", { a: "y".repeat(1000) });
    expect(out).toHaveLength(300);
  });
});

describe("cleanToolPrompt", () => {
  it("strips C0/C1 control characters but keeps tabs and newlines", () => {
    expect(cleanToolPrompt("  a\u0000b\u0007c\u001Fd\u007Fe\u009Ff  ")).toBe(
      "abcdef",
    );
    expect(cleanToolPrompt("line1\nline2\tx\r")).toBe("line1\nline2\tx");
  });

  it("keeps ordinary unicode", () => {
    expect(cleanToolPrompt("café — 東京 🙂")).toBe("café — 東京 🙂");
  });
});

describe("clipCut step ids and progress", () => {
  it("ccStepId and parseCcStepId round-trip", () => {
    expect(ccStepId("music")).toBe("music");
    expect(ccStepId("look", 0)).toBe("look:0");
    expect(ccStepId("clip", 3)).toBe("clip:3");
    for (const id of ["music", "beats", "assemble", "look:0", "clip:7"]) {
      const { kind, scene } = parseCcStepId(id);
      expect(ccStepId(kind, scene)).toBe(id);
    }
    expect(parseCcStepId("clip:2")).toEqual({ kind: "clip", scene: 2 });
    expect(parseCcStepId("beats")).toEqual({ kind: "beats" });
  });

  it("clipCutStyle falls back to the first style for unknown ids", () => {
    expect(clipCutStyle(CLIPCUT_STYLES[1].id)).toBe(CLIPCUT_STYLES[1]);
    expect(clipCutStyle("nope")).toBe(CLIPCUT_STYLES[0]);
  });

  it("clipMotionPrompt keeps the motion and never leaks -- params", () => {
    const style = { ...CLIPCUT_STYLES[0], motion: "spin  --ar 1:1 :: twirl" };
    const p = clipMotionPrompt(style);
    expect(p).not.toContain("--");
    expect(p).not.toContain("::");
    expect(p).toContain("spin");
    expect(p).toMatch(/same outfit and face throughout$/);
  });

  it("ccDependents walks downstream transitively", () => {
    const s = initialClipCut(2);
    expect(ccDependents("look:0", s.order)).toEqual(["clip:0", "assemble"]);
    expect(ccDependents("music", s.order)).toEqual(["beats", "assemble"]);
    expect(ccDependents("assemble", s.order)).toEqual([]);
  });

  it("ccCanRerun requires every dependency done; ccProgress counts done", () => {
    let s = initialClipCut(2);
    expect(ccProgress(s)).toEqual({ done: 0, total: s.order.length });
    expect(ccCanRerun(s, "look:0")).toBe(true);
    expect(ccCanRerun(s, "clip:0")).toBe(false);
    s = ccUpdateStep(s, "look:0", { status: "done" });
    expect(ccCanRerun(s, "clip:0")).toBe(true);
    expect(ccCanRerun(s, "clip:1")).toBe(false);
    s = ccUpdateStep(s, "music", { status: "error" });
    expect(ccCanRerun(s, "beats")).toBe(false);
    expect(ccProgress(s)).toEqual({ done: 1, total: s.order.length });
  });
});

describe("pipelineRunner response parsing", () => {
  it("promptIdOf returns the first job's prompt id or throws", () => {
    expect(
      promptIdOf({
        run_id: "r",
        jobs: [{ index: 0, prompt_id: "p1" }],
      } as unknown as ImagineRun),
    ).toBe("p1");
    expect(() =>
      promptIdOf({ run_id: "r", jobs: [] } as unknown as ImagineRun),
    ).toThrow(/no prompt id/);
    expect(() => promptIdOf({ run_id: "r" } as unknown as ImagineRun)).toThrow(
      /no prompt id/,
    );
  });

  it("outputOf builds a safe file ref and rejects missing / unsafe files", () => {
    expect(
      outputOf(
        {
          url: "/v.mp4",
          filename: "v_00001_.mp4",
          subfolder: "video",
          type: "output",
        },
        "video",
      ),
    ).toEqual({ url: "/v.mp4", ref: "video/v_00001_.mp4 [output]" });
    expect(() => outputOf(undefined, "video")).toThrow(
      "The job produced no video",
    );
    expect(() =>
      outputOf(
        { url: "/x", filename: "x.mp4", subfolder: "../etc", type: "output" },
        "video",
      ),
    ).toThrow(/Unexpected video file name/);
    expect(() =>
      outputOf(
        { url: "/x", filename: "x.exe", subfolder: "", type: "output" },
        "audio",
      ),
    ).toThrow(/Unexpected audio/);
  });

  function depsFor(reply: unknown, status = 200) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const deps: RunnerDeps = {
      clientId: "c",
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init?.body)) });
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => reply,
        };
      },
    };
    return { deps, calls };
  }

  it("seedText posts a capped text-only seed and returns the run/job pair", async () => {
    const { deps, calls } = depsFor({
      run: { run_id: "r1", jobs: [{ index: 2 }] },
    });
    await expect(seedText(deps, "z".repeat(1000))).resolves.toEqual({
      runId: "r1",
      jobIndex: 2,
    });
    expect(calls[0].url).toBe("/api/jobs/seed-run");
    expect(calls[0].body.text_only).toBe(true);
    expect(String(calls[0].body.prompt)).toHaveLength(400);
  });

  it("seedText falls back to a placeholder prompt and job 0", async () => {
    const { deps, calls } = depsFor({ run: { run_id: "r2" } });
    await expect(seedText(deps, "")).resolves.toEqual({
      runId: "r2",
      jobIndex: 0,
    });
    expect(calls[0].body.prompt).toBe("pipeline");
  });

  it("seedText surfaces server errors and missing runs", async () => {
    await expect(
      seedText(depsFor({ error: "busy" }, 503).deps, "x"),
    ).rejects.toThrow("busy");
    await expect(seedText(depsFor({ ok: true }).deps, "x")).rejects.toThrow(
      /Could not start/,
    );
  });
});

describe("smartTrack rewireLinks", () => {
  it("repoints only exact (node, output) links and counts them", () => {
    const wf = {
      "1": { class_type: "A", inputs: { x: 1 } },
      "2": { class_type: "B", inputs: { m: ["1", 0], n: ["1", 1], s: "1" } },
      "3": { class_type: "C", inputs: { a: ["1", 0], b: ["2", 0] } },
    };
    const n = rewireLinks(wf as never, ["1", 0], ["9", 2]);
    expect(n).toBe(2);
    expect(wf["2"].inputs).toEqual({ m: ["9", 2], n: ["1", 1], s: "1" });
    expect(wf["3"].inputs).toEqual({ a: ["9", 2], b: ["2", 0] });
  });

  it("writes a fresh array per input (no shared references)", () => {
    const wf = {
      "2": { class_type: "B", inputs: { m: ["1", 0] } },
      "3": { class_type: "C", inputs: { a: ["1", 0] } },
    };
    const to: [string, number] = ["9", 0];
    rewireLinks(wf as never, ["1", 0], to);
    expect(wf["2"].inputs.m).not.toBe(to);
    expect(wf["2"].inputs.m).not.toBe(wf["3"].inputs.a);
  });
});

describe("toolsPage pickers and edit LoRAs", () => {
  const picker: ActionPicker = {
    key: "mode",
    title: "Mode",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  } as ActionPicker;

  it("pickValue honors a valid choice and falls back to the first option", () => {
    const s = defaultSettings();
    expect(pickValue(picker, s)).toBe("a");
    expect(pickValue(picker, { ...s, picks: { mode: "b" } })).toBe("b");
    expect(pickValue(picker, { ...s, picks: { mode: "gone" } })).toBe("a");
    expect(pickValue({ ...picker, options: [] }, s)).toBe("");
  });

  const lora = (id: string, family: string, installed = true) => ({
    id,
    name: id.toUpperCase(),
    file: `${id}.safetensors`,
    family,
    base: "krea2",
    defaultStrength: 1,
    installed,
  });
  const resp: EditLoraListResponse = {
    families: {
      [GROUNDED_FAMILY]: { label: "Grounded" },
      ostris: { label: "Ostris" },
      empty: { label: "Empty" },
    },
    loras: [
      lora("o1", "ostris"),
      lora("g1", GROUNDED_FAMILY),
      lora("g2", GROUNDED_FAMILY),
      lora("e1", "empty", false),
      lora("x1", "unlisted"),
    ] as EditLoraListResponse["loras"],
  };

  it("editFamilies lists installed families, grounded first, then by label", () => {
    expect(editFamilies(null)).toEqual([]);
    expect(editFamilies(resp)).toEqual([
      { id: GROUNDED_FAMILY, label: "Grounded" },
      { id: "ostris", label: "Ostris" },
      { id: "unlisted", label: "unlisted" },
    ]);
  });

  it("editLorasIn keeps installed LoRAs of one family", () => {
    expect(editLorasIn(resp, GROUNDED_FAMILY).map((l) => l.id)).toEqual([
      "g1",
      "g2",
    ]);
    expect(editLorasIn(resp, "empty")).toEqual([]);
    expect(editLorasIn(null, GROUNDED_FAMILY)).toEqual([]);
  });

  it("pickEditLora uses the chosen LoRA, else the first in the family", () => {
    const family = {
      usesEditLora: true,
      picksEditFamily: true,
    } as ActionToolSpec;
    const fixed = { usesEditLora: true } as ActionToolSpec;
    const s = defaultSettings();
    expect(pickEditLora(family, s, resp)?.id).toBe("g1");
    expect(pickEditLora(family, { ...s, editFamily: "ostris" }, resp)?.id).toBe(
      "o1",
    );
    expect(pickEditLora(family, { ...s, editLoraId: "g2" }, resp)?.id).toBe(
      "g2",
    );
    expect(pickEditLora(family, { ...s, editLoraId: "o1" }, resp)?.id).toBe(
      "g1",
    );
    // fixed-family tools always use the grounded family
    expect(pickEditLora(fixed, { ...s, editFamily: "ostris" }, resp)?.id).toBe(
      "g1",
    );
    expect(pickEditLora(family, s, null)).toBeNull();
  });

  it("missingModelsReason shows basenames, at most three", () => {
    expect(missingModelsReason(["loras/a.safetensors"])).toBe(
      "Model not installed: a.safetensors. Download it into ComfyUI/models first.",
    );
    expect(missingModelsReason(["a", "b/c", "d", "e/f/g", "h"])).toBe(
      "Model not installed: a, c, d (+2 more). Download it into ComfyUI/models first.",
    );
  });

  it("replacePersonPrompt names the target or defaults to the person", () => {
    expect(replacePersonPrompt("  ")).toMatch(/^Replace the person in image 1/);
    expect(replacePersonPrompt(" the man on the left ")).toMatch(
      /^Replace the man on the left in image 1 with the person from image 2\./,
    );
  });

  it("categoryRank sorts unknown categories last", () => {
    expect(categoryRank("definitely-not-a-category")).toBeGreaterThan(
      categoryRank("Edit"),
    );
  });
});

describe("dubVideo helpers", () => {
  it("dubLanguage looks up by id", () => {
    expect(dubLanguage("es")?.label).toBe("Spanish");
    expect(dubLanguage("xx")).toBeUndefined();
  });

  it("dubMaxSeconds caps lip-sync shorter than audio-only", () => {
    expect(dubMaxSeconds("lipsync")).toBe(DUB_LIPSYNC_MAX_SECONDS);
    expect(dubMaxSeconds("audio")).toBe(DUB_AUDIO_MAX_SECONDS);
    expect(DUB_LIPSYNC_MAX_SECONDS).toBeLessThan(DUB_AUDIO_MAX_SECONDS);
  });

  it("dubVoiceScript flattens to one capped line", () => {
    expect(dubVoiceScript("  Hola\n\n  mundo \t ")).toBe("Hola mundo");
    expect(dubVoiceScript("w ".repeat(DUB_MAX_CHARS))).toHaveLength(
      DUB_MAX_CHARS - 1,
    );
  });
});

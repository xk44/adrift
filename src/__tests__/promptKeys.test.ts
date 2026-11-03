import { describe, expect, it } from "vitest";
import {
  EXAMPLE_PROMPTS,
  HISTORY_RECALL_IDLE,
  normalizeSmartDashes,
  recallPromptHistory,
} from "@/lib/ui/promptKeys";
import { parseImagineInput } from "@/lib/oj/parser";
import {
  dragHasFiles,
  imageFilesToAttachments,
  pickImageFiles,
} from "@/lib/ui/imageDrop";

describe("normalizeSmartDashes", () => {
  it("turns a phone keyboard's em/en dash flag back into --", () => {
    expect(normalizeSmartDashes("a cat —ar 16:9", 14)).toEqual({
      value: "a cat --ar 16:9",
      caret: 15,
    });
    expect(normalizeSmartDashes("–no people", 0).value).toBe(
      "--no people",
    );
  });

  it("leaves prose dashes and plain text alone", () => {
    const prose = "dusk — a lighthouse";
    expect(normalizeSmartDashes(prose, 3)).toEqual({ value: prose, caret: 3 });
    expect(normalizeSmartDashes("well—known", 2).value).toBe(
      "well—known",
    );
    expect(normalizeSmartDashes("a cat --ar 1:1", 5).value).toBe(
      "a cat --ar 1:1",
    );
  });

  it("only shifts the caret for replacements before it", () => {
    expect(normalizeSmartDashes("x —ar 1:1 —s 50", 1).caret).toBe(1);
    expect(normalizeSmartDashes("x —ar 1:1 —s 50", 15).caret).toBe(17);
  });
});

describe("recallPromptHistory", () => {
  const history = ["newest", "older", "oldest"];

  it("steps back with Up from an empty prompt and forward with Down", () => {
    let state = HISTORY_RECALL_IDLE;
    const up1 = recallPromptHistory({
      direction: "up",
      history,
      state,
      value: "",
      caret: 0,
    });
    expect(up1?.value).toBe("newest");
    state = up1!.state;
    const up2 = recallPromptHistory({
      direction: "up",
      history,
      state,
      value: "newest",
      caret: 6,
    });
    expect(up2?.value).toBe("older");
    state = up2!.state;
    const down = recallPromptHistory({
      direction: "down",
      history,
      state,
      value: "older",
      caret: 5,
    });
    expect(down?.value).toBe("newest");
    const back = recallPromptHistory({
      direction: "down",
      history,
      state: down!.state,
      value: "newest",
      caret: 6,
    });
    expect(back).toEqual({ state: HISTORY_RECALL_IDLE, value: "" });
  });

  it("never clobbers a half-written prompt or hijacks multi-line editing", () => {
    expect(
      recallPromptHistory({
        direction: "up",
        history,
        state: HISTORY_RECALL_IDLE,
        value: "a cat",
        caret: 0,
      }),
    ).toBeNull();
    expect(
      recallPromptHistory({
        direction: "up",
        history,
        state: { index: 0, draft: "" },
        value: "line one\nline two",
        caret: 12,
      }),
    ).toBeNull();
    expect(
      recallPromptHistory({
        direction: "down",
        history,
        state: HISTORY_RECALL_IDLE,
        value: "",
        caret: 0,
      }),
    ).toBeNull();
  });

  it("stops at the oldest entry and does nothing without history", () => {
    expect(
      recallPromptHistory({
        direction: "up",
        history,
        state: { index: 2, draft: "" },
        value: "oldest",
        caret: 0,
      }),
    ).toBeNull();
    expect(
      recallPromptHistory({
        direction: "up",
        history: [],
        state: HISTORY_RECALL_IDLE,
        value: "",
        caret: 0,
      }),
    ).toBeNull();
  });
});

describe("EXAMPLE_PROMPTS", () => {
  it("starts on the plain placeholder (server markup stays stable)", () => {
    expect(EXAMPLE_PROMPTS[0]).toBe("What will you imagine?");
  });

  it("only teaches parameters the parser accepts", () => {
    for (const example of EXAMPLE_PROMPTS.slice(1)) {
      // The last line is a how-to hint, not a prompt.
      if (!example.includes(" --") || example.startsWith("Type ")) continue;
      const parsed = parseImagineInput(example);
      expect(parsed.unknownFlags, example).toEqual([]);
      expect(parsed.errors, example).toEqual([]);
    }
  });

  it("stays short enough to read as a placeholder", () => {
    for (const example of EXAMPLE_PROMPTS) {
      expect(example.length).toBeLessThanOrEqual(60);
    }
  });
});

describe("image drop / paste helpers", () => {
  it("only reacts to drags that carry files", () => {
    expect(dragHasFiles(["Files"])).toBe(true);
    expect(dragHasFiles(["text/plain"])).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });

  it("keeps image files and builds attachments in the drop column's mode", () => {
    const png = new File(["x"], "a.png", { type: "image/png" });
    const json = new File(["{}"], "wf.json", { type: "application/json" });
    const images = pickImageFiles([png, json]);
    expect(images).toEqual([png]);
    const [attachment] = imageFilesToAttachments(images, "style_ref", {
      makeUrl: () => "blob:test",
      makeId: () => "id-1",
    });
    expect(attachment).toEqual({
      id: "id-1",
      url: "blob:test",
      file: png,
      filename: "a.png",
      mode: "style_ref",
      weight: 1,
    });
  });
});

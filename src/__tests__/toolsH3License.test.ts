import { describe, it, expect } from "vitest";
import {
  H3_ATTRIBUTION,
  H3_LEGAL_PATH,
  LIKENESS_TOOL_KEYS,
  abuseReportUrl,
  consentStorageKey,
  isH3Model,
  needsLikenessConsent,
  readConsent,
  writeConsent,
} from "@/lib/tools/h3License";
import { CARD_OVERRIDES, buildHubCards } from "@/lib/tools/hub";
import { buildToolCards, getActionTool } from "@/lib/tools/toolsPage";

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("quota");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("H3 attribution", () => {
  it("names MiniMax H3 prominently", () => {
    expect(H3_ATTRIBUTION).toBe("Powered by MiniMax H3");
  });

  it("detects H3-backed models", () => {
    expect(isH3Model("MiniMax H3")).toBe(true);
    expect(isH3Model("MiniMax H3 + Character Swap LoRA")).toBe(true);
    expect(isH3Model("LTX-Video")).toBe(false);
    expect(isH3Model(null)).toBe(false);
  });

  it("every H3 hub override is an action card that resolves", () => {
    const h3Keys = Object.entries(CARD_OVERRIDES)
      .filter(([, o]) => isH3Model(o.model))
      .map(([k]) => k);
    expect(h3Keys).toEqual(
      expect.arrayContaining([
        "action:face_swap",
        "action:character_swap",
        "action:orbit_360",
        "action:camera_move",
        "action:transition",
      ]),
    );
  });
});

describe("likeness consent", () => {
  it("is required for the swap-into-video and reference-cast tools only", () => {
    expect(needsLikenessConsent("action:character_swap")).toBe(true);
    expect(needsLikenessConsent("action:face_swap")).toBe(true);
    expect(needsLikenessConsent("action:ref_video")).toBe(true);
    expect(needsLikenessConsent("action:multiframe_ref")).toBe(true);
    expect(needsLikenessConsent("action:h3_charsheet")).toBe(true);
    expect(needsLikenessConsent("action:camera_move")).toBe(false);
    expect(needsLikenessConsent("special:music_video")).toBe(true);
    for (const k of LIKENESS_TOOL_KEYS) {
      // special: runners (Music Video) render their own consent box.
      if (!k.startsWith("action:")) continue;
      const spec = getActionTool(k.replace("action:", ""));
      // A person photo goes into a video: a swap into a source clip, or
      // reference photos cast into a new shot (ref_video / multiframe_ref,
      // image-in) or onto a character sheet (h3_charsheet).
      expect(
        spec?.videoInput ||
          spec?.id === "ref_video" ||
          spec?.id === "multiframe_ref" ||
          spec?.id === "h3_charsheet",
        k,
      ).toBeTruthy();
      expect(spec?.secondImage, k).toBeTruthy();
    }
  });

  it("persists per tool", () => {
    const s = memStorage();
    expect(readConsent(s, "action:face_swap")).toBe(false);
    writeConsent(s, "action:face_swap", true);
    expect(readConsent(s, "action:face_swap")).toBe(true);
    expect(readConsent(s, "action:character_swap")).toBe(false);
    expect(s.m.get(consentStorageKey("action:face_swap"))).toBe("1");
    writeConsent(s, "action:face_swap", false);
    expect(readConsent(s, "action:face_swap")).toBe(false);
  });

  it("never throws when storage is missing or blocked", () => {
    expect(readConsent(null, "x")).toBe(false);
    expect(() => writeConsent(null, "x", true)).not.toThrow();
    expect(readConsent(throwing, "x")).toBe(false);
    expect(() => writeConsent(throwing, "x", true)).not.toThrow();
  });
});

describe("abuseReportUrl", () => {
  it("defaults to the legal page report section", () => {
    expect(abuseReportUrl("")).toBe(`${H3_LEGAL_PATH}#report`);
    expect(abuseReportUrl("   ")).toBe(`${H3_LEGAL_PATH}#report`);
  });

  it("accepts http(s), mailto and site paths", () => {
    expect(abuseReportUrl(" https://example.com/abuse ")).toBe(
      "https://example.com/abuse",
    );
    expect(abuseReportUrl("mailto:abuse@example.com")).toBe(
      "mailto:abuse@example.com",
    );
    expect(abuseReportUrl("/report")).toBe("/report");
  });

  it("rejects script and protocol-relative URLs", () => {
    expect(abuseReportUrl("javascript:alert(1)")).toBe(
      `${H3_LEGAL_PATH}#report`,
    );
    expect(abuseReportUrl("//evil.example")).toBe(`${H3_LEGAL_PATH}#report`);
    expect(abuseReportUrl("not a url")).toBe(`${H3_LEGAL_PATH}#report`);
  });
});

describe("Character Swap card", () => {
  it("is a plainly named video character swap with video + photo inputs", () => {
    const cards = buildHubCards({
      toolCards: buildToolCards({
        catalog: [],
        packIds: new Set(["minimax"]),
        editLoras: null,
        modelStatus: { tools: {} },
      }),
      ctx: { catalog: [], packIds: new Set(["minimax"]), editLoras: null },
    });
    const card = cards.find((c) => c.key === "action:character_swap")!;
    expect(card.title).toBe("Character Swap");
    expect(card.hubCategory).toBe("Identity");
    expect(card.subtitle.toLowerCase()).toContain(
      "swap a character in a video",
    );
    expect(isH3Model(card.model)).toBe(true);
    const spec = getActionTool("character_swap")!;
    expect(spec.videoInput).toMatch(/video/i);
    expect(spec.secondImage).toMatch(/photo/i);
  });
});

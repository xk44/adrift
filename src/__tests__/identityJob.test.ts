import { describe, expect, it } from "vitest";
import {
  IDENTITY_MAX_PHOTOS,
  IDENTITY_MIN_PHOTOS,
  buildIdentityJob,
  deriveTriggerWord,
  findIdentityLora,
  identityCaption,
  identityPrompt,
  identitySteps,
  isUploadedPhotoUrl,
  triggerWordError,
  validateIdentityInput,
} from "@/lib/training/identityJob";
import { parseProfileSeeds } from "@/lib/training/identityProfiles";

describe("identity trigger words", () => {
  it("derives a rare zx-prefixed token from the name", () => {
    expect(deriveTriggerWord("Ana Lima")).toBe("zxanalima");
    expect(deriveTriggerWord("José")).toBe("zxjose");
    expect(deriveTriggerWord("A very long display name")).toBe("zxaverylongd");
    expect(deriveTriggerWord("!!!")).toBe("zxsubject");
  });

  it("rejects malformed custom triggers", () => {
    expect(triggerWordError("ohwx")).toBeNull();
    expect(triggerWordError("ab")).not.toBeNull();
    expect(triggerWordError("Has Space")).not.toBeNull();
    expect(triggerWordError("a".repeat(41))).not.toBeNull();
  });
});

describe("identitySteps", () => {
  it("scales with photo count inside the preset window, rounded to 50", () => {
    expect(identitySteps(10, "balanced")).toBe(1500); // floor
    expect(identitySteps(20, "balanced")).toBe(2000);
    expect(identitySteps(30, "balanced")).toBe(2500); // ceiling
    expect(identitySteps(10, "quick")).toBe(800);
    expect(identitySteps(30, "quick")).toBe(1400);
    expect(identitySteps(25, "detailed")).toBe(3000);
    expect(identitySteps(30, "detailed")).toBe(3200);
  });

  it("falls back to the balanced preset for unknown ids", () => {
    expect(identitySteps(20, "bogus" as never)).toBe(2000);
  });
});

describe("validateIdentityInput", () => {
  const ok = { name: "Ana", photoCount: 12 };
  it("accepts a named 10-30 photo set", () => {
    expect(validateIdentityInput(ok)).toBeNull();
    expect(
      validateIdentityInput({ ...ok, photoCount: IDENTITY_MIN_PHOTOS }),
    ).toBeNull();
    expect(
      validateIdentityInput({ ...ok, photoCount: IDENTITY_MAX_PHOTOS }),
    ).toBeNull();
  });
  it("names the problem", () => {
    expect(validateIdentityInput({ ...ok, name: "  " })).toMatch(/name/);
    expect(validateIdentityInput({ ...ok, photoCount: 9 })).toMatch(
      /at least 10/,
    );
    expect(validateIdentityInput({ ...ok, photoCount: 31 })).toMatch(
      /at most 30/,
    );
    expect(validateIdentityInput({ ...ok, triggerWord: "Bad Word" })).toMatch(
      /Trigger word/,
    );
    expect(validateIdentityInput({ ...ok, name: "x".repeat(61) })).toMatch(
      /under 60/,
    );
  });
});

describe("buildIdentityJob", () => {
  it("builds a Krea 2 request sized for a 24 GB card by default", () => {
    const spec = buildIdentityJob({ name: "Ana Lima", photoCount: 20 });
    expect(spec.boardName).toBe("Identity: Ana Lima");
    expect(spec.triggerWord).toBe("zxanalima");
    expect(spec.family).toBe("krea2");
    expect(spec.preset).toBe("balanced");
    expect(spec.activation).toBe("zxanalima person");
    expect(spec.request).toEqual({
      model_family: "krea2",
      trigger_word: "zxanalima",
      steps: 2000,
      lr: 5e-5,
      rank: 16,
      resolution: 1024,
      blocks_to_swap: 20,
      exclude_shared: true,
      auto_caption: false,
      caption_ext: "txt",
    });
    // Every photo gets a trigger-first caption in the default mode.
    expect(spec.captions).toHaveLength(20);
    expect(new Set(spec.captions)).toEqual(new Set(["zxanalima person"]));
  });

  it("keeps rank <= 32 and resolution <= 1024 on every preset", () => {
    for (const preset of ["quick", "balanced", "detailed"] as const) {
      const { request } = buildIdentityJob({
        name: "Ana",
        photoCount: 30,
        preset,
      });
      expect(request.rank).toBeLessThanOrEqual(32);
      expect(request.resolution).toBeLessThanOrEqual(1024);
      expect(request.blocks_to_swap).toBeGreaterThan(0);
    }
  });

  it("uses a custom trigger, subject and per-photo notes", () => {
    const spec = buildIdentityJob({
      name: "Rin",
      triggerWord: "rinchar",
      subject: "character",
      photoCount: 10,
      notes: ["  side   profile, outdoors ", null, ""],
    });
    expect(spec.triggerWord).toBe("rinchar");
    expect(spec.request.trigger_word).toBe("rinchar");
    expect(spec.captions[0]).toBe("rinchar character, side profile, outdoors");
    expect(spec.captions[1]).toBe("rinchar character");
    expect(spec.activation).toBe("rinchar character");
  });

  it("auto mode leaves un-noted photos to the trainer's captioner", () => {
    const spec = buildIdentityJob({
      name: "Ana",
      photoCount: 10,
      captionMode: "auto",
      notes: ["smiling"],
    });
    expect(spec.request.auto_caption).toBe(true);
    expect(spec.captions[0]).toBe("zxana person, smiling");
    expect(spec.captions.slice(1).every((c) => c === "")).toBe(true);
  });

  it("maps the experimental family to its own learning rate", () => {
    const spec = buildIdentityJob({
      name: "Ana",
      photoCount: 10,
      family: "moss_image",
    });
    expect(spec.request.model_family).toBe("moss_image");
    expect(spec.request.lr).toBe(1e-4);
  });

  it("throws on invalid input", () => {
    expect(() => buildIdentityJob({ name: "Ana", photoCount: 3 })).toThrow(
      /at least 10/,
    );
  });

  it("caps long board names at 100 characters", () => {
    const spec = buildIdentityJob({ name: "n".repeat(60), photoCount: 10 });
    expect(spec.boardName.length).toBeLessThanOrEqual(100);
  });
});

describe("identity helpers", () => {
  it("captions keep the trigger first and clip long notes", () => {
    expect(identityCaption("zxana", "woman")).toBe("zxana woman");
    const long = identityCaption("zxana", "person", "a".repeat(500));
    expect(long.startsWith("zxana person, ")).toBe(true);
    expect(long.length).toBe("zxana person, ".length + 200);
  });

  it("builds a Create prompt with the deployed shortcode", () => {
    expect(identityPrompt({ activation: "zxana person" }, " ana ")).toBe(
      "zxana person, portrait photo, natural light --lora ana",
    );
    expect(identityPrompt({ activation: "zxana person" }, "ana", "")).toBe(
      "zxana person --lora ana",
    );
  });

  it("accepts only moodboard upload URLs as dataset photos", () => {
    expect(isUploadedPhotoUrl("/api/moodboards/upload?file=ab-12.png")).toBe(
      true,
    );
    expect(isUploadedPhotoUrl("/api/moodboards/upload?file=../x.png")).toBe(
      false,
    );
    expect(isUploadedPhotoUrl("/api/moodboards/upload?file=a/b.png")).toBe(
      false,
    );
    expect(isUploadedPhotoUrl("https://example.com/a.png")).toBe(false);
    expect(isUploadedPhotoUrl("/etc/passwd")).toBe(false);
  });

  it("finds the deployed LoRA by trigger word", () => {
    const entries = [
      { shortcode: "other", triggers: ["x"] },
      { shortcode: "ana-v1", triggers: [" ZXANA "] },
    ];
    expect(findIdentityLora(entries, "zxana")).toBe("ana-v1");
    expect(findIdentityLora(entries, "nobody")).toBeNull();
    expect(findIdentityLora(entries, "")).toBeNull();
  });
});

describe("parseProfileSeeds", () => {
  it("reads profile refs from the persisted store payload", () => {
    const raw = JSON.stringify({
      state: {
        profiles: [
          {
            id: "p1",
            name: "Ana",
            refs: [
              { dataUrl: "data:image/jpeg;base64,AAAA", previewUrl: "x" },
              { previewUrl: "/api/images/run/1.png" },
              { previewUrl: "https://evil.example/a.png" },
              { previewUrl: "//evil.example/a.png" },
            ],
          },
          { id: "p2", name: "Empty", refs: [] },
          { id: 3, name: "bad id", refs: [] },
        ],
      },
      version: 1,
    });
    expect(parseProfileSeeds(raw)).toEqual([
      {
        id: "p1",
        name: "Ana",
        photos: ["data:image/jpeg;base64,AAAA", "/api/images/run/1.png"],
      },
    ]);
  });

  it("returns [] for missing or malformed storage", () => {
    expect(parseProfileSeeds(null)).toEqual([]);
    expect(parseProfileSeeds("{not json")).toEqual([]);
    expect(parseProfileSeeds(JSON.stringify({ state: {} }))).toEqual([]);
  });
});

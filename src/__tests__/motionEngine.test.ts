import { describe, expect, it } from "vitest";
import {
  EASE_NAMES,
  EASINGS,
  cubicBezier,
  ease,
  lerp,
  progress,
  rand,
  stagger,
} from "@/lib/motion/easing";
import {
  counterValue,
  elementState,
  formatNumber,
  frameTimes,
  locate,
  narrationCues,
  sceneSpans,
  totalDuration,
  transitionLength,
  typewriterCount,
} from "@/lib/motion/timeline";
import {
  LIMITS,
  defaultElement,
  parseSpecText,
  validateSpec,
  type MotionScene,
  type MotionSpec,
} from "@/lib/motion/spec";
import { buildTemplate } from "@/lib/motion/templates";

describe("easing", () => {
  it.each(EASE_NAMES)("%s hits exact endpoints", (name) => {
    expect(ease(name, 0)).toBe(0);
    expect(ease(name, 1)).toBe(1);
    expect(ease(name, -3)).toBe(0);
    expect(ease(name, 7)).toBe(1);
  });

  it.each([
    "linear",
    "inQuad",
    "outQuad",
    "inOutCubic",
    "outQuart",
    "inOutSine",
    "outExpo",
    "smooth",
    "snap",
  ])("%s is monotonic", (name) => {
    let prev = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const v = ease(name, i / 200);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  it("overshooting curves overshoot but settle", () => {
    const peak = Math.max(
      ...Array.from({ length: 101 }, (_, i) => EASINGS.outBack(i / 100)),
    );
    expect(peak).toBeGreaterThan(1.05);
    expect(ease("spring", 1)).toBe(1);
  });

  it("unknown ease names fall back to smooth", () => {
    expect(ease("nope", 0.3)).toBeCloseTo(EASINGS.smooth(0.3), 9);
    expect(ease(undefined, 0.3)).toBeCloseTo(EASINGS.smooth(0.3), 9);
  });

  it("cubicBezier matches the linear and ease-in-out reference points", () => {
    const lin = cubicBezier(0, 0, 1, 1);
    for (const t of [0.1, 0.37, 0.5, 0.9]) expect(lin(t)).toBeCloseTo(t, 4);
    const css = cubicBezier(0.42, 0, 0.58, 1); // CSS ease-in-out: symmetric
    expect(css(0.5)).toBeCloseTo(0.5, 4);
    expect(css(0.25) + css(0.75)).toBeCloseTo(1, 4);
  });

  it("progress / lerp / stagger", () => {
    expect(progress(1, 1, 2)).toBe(0);
    expect(progress(2, 1, 2)).toBe(0.5);
    expect(progress(9, 1, 2)).toBe(1);
    expect(progress(1, 1, 0)).toBe(1);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
    // First item starts at 0, last item finishes exactly at 1.
    expect(stagger(0, 0, 5)).toBe(0);
    expect(stagger(1, 4, 5)).toBe(1);
    expect(stagger(0.1, 4, 5)).toBe(0);
    expect(stagger(0.5, 0, 5)).toBeGreaterThan(stagger(0.5, 3, 5));
    expect(stagger(0.4, 0, 1)).toBe(0.4);
  });

  it("rand is deterministic and in [0,1)", () => {
    expect(rand(42)).toBe(rand(42));
    expect(rand(1)).not.toBe(rand(2));
    for (let i = 0; i < 50; i++) {
      const v = rand(i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

function scene(
  duration: number,
  extra: Partial<MotionScene> = {},
): MotionScene {
  return {
    duration,
    transition: "fade",
    transitionDur: 0.6,
    background: "",
    narration: "",
    elements: [],
    ...extra,
  } as MotionScene;
}

function specOf(scenes: MotionScene[]): MotionSpec {
  const base = buildTemplate("title_intro");
  return { ...base, scenes };
}

describe("timeline", () => {
  const spec = specOf([
    scene(3),
    scene(4, { transition: "cut" }),
    scene(2, { transitionDur: 5 }),
  ]);

  it("spans, totals and frame times", () => {
    expect(sceneSpans(spec)).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 7 },
      { start: 7, end: 9 },
    ]);
    expect(totalDuration(spec)).toBe(9);
    const frames = frameTimes(spec, 30);
    expect(frames).toHaveLength(270);
    expect(frames[1]).toBeCloseTo(1 / 30, 9);
  });

  it("transition length: none on first/cut scenes, capped at 60% of neighbours", () => {
    expect(transitionLength(spec, 0)).toBe(0);
    expect(transitionLength(spec, 1)).toBe(0);
    expect(transitionLength(spec, 2)).toBeCloseTo(1.2, 9); // 60% of 2s
  });

  it("locate finds the scene, local time and transition", () => {
    expect(locate(spec, 0)).toMatchObject({
      index: 0,
      local: 0,
      transition: 1,
      prev: null,
    });
    expect(locate(spec, 3.5)).toMatchObject({
      index: 1,
      transition: 1,
      prev: null,
    });
    const mid = locate(spec, 7.6);
    expect(mid.index).toBe(2);
    expect(mid.transition).toBeCloseTo(0.5, 6);
    expect(mid.prev?.index).toBe(1);
    expect(mid.prev?.local).toBeCloseTo(4.6, 6);
    // Clamps outside the timeline.
    expect(locate(spec, -5).index).toBe(0);
    expect(locate(spec, 99).index).toBe(2);
    expect(locate(spec, Number.NaN).index).toBe(0);
  });

  it("elementState: hidden before start, enters, exits before scene end", () => {
    const sc = scene(4);
    const el = defaultElement("text", {
      start: 1,
      inDur: 1,
      out: "fade",
      ease: "linear",
    });
    expect(elementState(el, sc, 0.5).visible).toBe(false);
    const half = elementState(el, sc, 1.5);
    expect(half.visible).toBe(true);
    expect(half.enter).toBeCloseTo(0.5, 6);
    expect(elementState(el, sc, 3).exit).toBe(0);
    expect(elementState(el, sc, 3.8).exit).toBeGreaterThan(0);
    expect(elementState(el, sc, 4.2).visible).toBe(false);
  });

  it("elementState: explicit end without exit anim just disappears", () => {
    const sc = scene(5);
    const el = defaultElement("icon", { start: 0, end: 2, out: "none" });
    expect(elementState(el, sc, 1.9).visible).toBe(true);
    expect(elementState(el, sc, 2.1).visible).toBe(false);
  });

  it("narration cues sit just after each scene start", () => {
    const s = specOf([
      scene(3, { narration: " Hello " }),
      scene(4),
      scene(0.8, { narration: "Bye" }),
    ]);
    expect(narrationCues(s)).toEqual([
      { scene: 0, at: 0.25, text: "Hello" },
      { scene: 2, at: 7.2, text: "Bye" },
    ]);
  });

  it("typewriter / counter / number formatting", () => {
    expect(typewriterCount("héllo", 0.5)).toBe(3);
    expect(typewriterCount("abc", 2)).toBe(3);
    expect(counterValue(0, 100, 0.333, 0)).toBe(33);
    expect(counterValue(0, 1, 0.5, 2)).toBe(0.5);
    expect(counterValue(10, 20, -1, 0)).toBe(10);
    expect(formatNumber(1234567.891, 1)).toBe("1,234,567.9");
    expect(formatNumber(-1000, 0)).toBe("-1,000");
    expect(formatNumber(42, 0)).toBe("42");
  });
});

describe("spec validation", () => {
  const good = () =>
    JSON.parse(JSON.stringify(buildTemplate("explainer"))) as Record<
      string,
      unknown
    >;

  it("round-trips a compiled spec in strict mode", () => {
    const r = validateSpec(good(), "strict");
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.spec).toEqual(good());
  });

  it("rejects non-objects and missing scenes", () => {
    expect(validateSpec(null).ok).toBe(false);
    expect(validateSpec([]).ok).toBe(false);
    const raw = good();
    delete raw.scenes;
    expect(validateSpec(raw).errors.some((e) => e.path === "scenes")).toBe(
      true,
    );
    expect(validateSpec({ ...good(), scenes: [] }).ok).toBe(false);
  });

  it("strict reports fixable problems that lenient repairs", () => {
    const raw = good();
    const scenes = raw.scenes as Record<string, unknown>[];
    scenes[0].duration = 99; // > max
    scenes[0].bogus = 1; // unknown key
    (scenes[0].elements as Record<string, unknown>[])[0].ease = "OUTCUBIC"; // wrong case
    const strict = validateSpec(raw, "strict");
    expect(strict.ok).toBe(false);
    const paths = strict.errors.map((e) => e.path);
    expect(paths).toContain("scenes[0].duration");
    expect(paths).toContain("scenes[0].bogus");
    expect(paths).toContain("scenes[0].elements[0].ease");

    const lenient = validateSpec(raw, "lenient");
    expect(lenient.ok).toBe(true);
    expect(lenient.warnings.length).toBeGreaterThanOrEqual(3);
    expect(lenient.spec!.scenes[0].duration).toBe(LIMITS.sceneSeconds.max);
    expect(lenient.spec!.scenes[0].elements[0].ease).toBe("outCubic");
    expect("bogus" in lenient.spec!.scenes[0]).toBe(false);
  });

  it("drops unknown element types leniently, errors strictly", () => {
    const raw = good();
    (raw.scenes as Record<string, unknown>[])[0].elements = [
      { type: "laser" },
      { type: "text", text: "ok" },
    ];
    expect(validateSpec(raw, "strict").ok).toBe(false);
    const r = validateSpec(raw, "lenient");
    expect(r.ok).toBe(true);
    expect(r.spec!.scenes[0].elements).toHaveLength(1);
  });

  it("required text and bad colors", () => {
    const raw = good();
    (raw.scenes as Record<string, unknown>[])[0].elements = [{ type: "text" }];
    expect(validateSpec(raw, "lenient").spec!.scenes[0].elements).toHaveLength(
      0,
    );
    (raw.scenes as Record<string, unknown>[])[0].elements = [
      { type: "text", text: "x", color: "red" },
    ];
    expect(validateSpec(raw, "strict").errors[0].message).toMatch(/hex/);
    expect(validateSpec(raw, "lenient").spec!.scenes[0].elements[0].color).toBe(
      "",
    );
  });

  it("enforces the scene, element and total length limits", () => {
    const raw = good();
    const one = (raw.scenes as unknown[])[0];
    raw.scenes = Array.from({ length: LIMITS.scenes + 3 }, () => one);
    expect(validateSpec(raw, "strict").ok).toBe(false);
    const r = validateSpec(raw, "lenient");
    expect(r.spec!.scenes.length).toBeLessThanOrEqual(LIMITS.scenes);

    const long = good();
    long.scenes = Array.from({ length: 10 }, () => ({
      ...(one as object),
      duration: 15,
    }));
    const lr = validateSpec(long, "lenient");
    expect(totalDuration(lr.spec!)).toBeLessThanOrEqual(LIMITS.totalSeconds);

    const many = good();
    (many.scenes as Record<string, unknown>[])[0].elements = Array.from(
      { length: 30 },
      () => ({ type: "shape" }),
    );
    expect(validateSpec(many, "lenient").spec!.scenes[0].elements).toHaveLength(
      LIMITS.elements,
    );
  });

  it("strips control characters and caps text length", () => {
    const raw = good();
    (raw.scenes as Record<string, unknown>[])[0].elements = [
      { type: "text", text: "a\u0007b\nc" + "x".repeat(400) },
    ];
    const r = validateSpec(raw, "lenient");
    const t = (r.spec!.scenes[0].elements[0] as { text: string }).text;
    expect(t.startsWith("ab\nc")).toBe(true);
    expect(t.length).toBe(LIMITS.text);
  });

  it("parseSpecText reports JSON syntax errors", () => {
    const r = parseSpecText("{ nope");
    expect(r.ok).toBe(false);
    expect(r.errors[0].message).toMatch(/Invalid JSON/);
    expect(parseSpecText(JSON.stringify(good())).ok).toBe(true);
  });

  it("defaultElement fills every field for every type", () => {
    for (const type of [
      "text",
      "lowerThird",
      "shape",
      "icon",
      "figure",
      "chart",
      "counter",
      "list",
      "arrow",
    ] as const) {
      const el = defaultElement(type);
      expect(el.type).toBe(type);
      const r = validateSpec(
        { ...good(), scenes: [{ ...scene(3), elements: [el] }] },
        "strict",
      );
      expect(r.errors).toEqual([]);
    }
  });
});

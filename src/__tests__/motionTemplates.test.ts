import { describe, expect, it } from "vitest";
import {
  ASPECTS,
  ICON_NAMES,
  LIMITS,
  validateSpec,
  type Aspect,
} from "@/lib/motion/spec";
import {
  LAYOUTS,
  MOTION_TEMPLATES,
  THEMES,
  autoEmphasis,
  buildTemplate,
  compileOutline,
  iconFor,
  normalizeOutline,
  readSeconds,
  templateById,
  themeById,
} from "@/lib/motion/templates";
import {
  iconStrokes,
  parsePath,
  partialStrokes,
  penPosition,
  polylineLength,
} from "@/lib/motion/icons";
import {
  layoutText,
  parseRich,
  renderFrame,
  hexToRgb,
  luminance,
} from "@/lib/motion/render";
import { sceneSpans, totalDuration } from "@/lib/motion/timeline";

const ASPECT_KEYS = Object.keys(ASPECTS) as Aspect[];

describe("templates", () => {
  it("ships 8 templates incl. the required set", () => {
    expect(MOTION_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    expect(MOTION_TEMPLATES.length).toBeLessThanOrEqual(10);
    const ids = MOTION_TEMPLATES.map((t) => t.id);
    for (const id of [
      "explainer",
      "kinetic_quote",
      "feature_callouts",
      "stat_reveal",
      "whiteboard_steps",
      "title_intro",
      "lower_third",
    ])
      expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const t of MOTION_TEMPLATES) {
    it.each(ASPECT_KEYS)(
      `${t.id} builds a strict-valid spec at %s`,
      (aspect) => {
        const spec = buildTemplate(t.id, {}, { aspect });
        const r = validateSpec(JSON.parse(JSON.stringify(spec)), "strict");
        expect(r.errors).toEqual([]);
        expect(spec.aspect).toBe(aspect);
        expect(spec.scenes.length).toBeGreaterThan(0);
        expect(totalDuration(spec)).toBeLessThanOrEqual(LIMITS.totalSeconds);
      },
    );
  }

  it("every theme builds every template", () => {
    for (const th of THEMES)
      for (const t of MOTION_TEMPLATES) {
        const spec = buildTemplate(t.id, {}, { theme: th.id });
        expect(validateSpec(spec, "strict").ok).toBe(true);
        expect(spec.theme).toEqual(th.theme);
      }
  });

  it("form input flows into the spec", () => {
    const spec = buildTemplate("title_intro", {
      title: "Hello Orbit",
      subtitle: "A tiny demo",
    });
    expect(JSON.stringify(spec)).toContain("Orbit");
    expect(spec.title).toBe("Hello Orbit");
    const stat = buildTemplate("stat_reveal", { value: 73, unit: "%" });
    expect(JSON.stringify(stat)).toMatch(/"to":73/);
  });

  it("lower third needs footage and uses the video background", () => {
    const t = templateById("lower_third");
    expect(t.needsVideo).toBe(true);
    const spec = buildTemplate("lower_third");
    const usesVideo =
      spec.background === "video" ||
      spec.scenes.some((s) => s.background === "video");
    expect(usesVideo).toBe(true);
    expect(
      spec.scenes.some((s) => s.elements.some((e) => e.type === "lowerThird")),
    ).toBe(true);
  });

  it("whiteboard template draws strokes in the hand font", () => {
    const spec = buildTemplate("whiteboard_steps");
    expect(spec.theme.font).toBe("hand");
    const anims = spec.scenes
      .flatMap((s) => s.elements)
      .map((e) => (e as { anim?: string }).anim);
    expect(anims).toContain("draw");
  });

  it("pace multiplies scene lengths (higher = slower)", () => {
    const slow = totalDuration(buildTemplate("explainer", {}, { pace: 0.7 }));
    const fast = totalDuration(buildTemplate("explainer", {}, { pace: 1.5 }));
    expect(fast).toBeGreaterThan(slow);
  });

  it("templateById / themeById fall back safely", () => {
    expect(templateById("nope").id).toBe(MOTION_TEMPLATES[0].id);
    expect(themeById("nope").id).toBe(THEMES[0].id);
  });
});

describe("outline compiler", () => {
  it("normalizes LLM-ish output: aliases, numbers, icons, junk", () => {
    const o = normalizeOutline(
      {
        title: "Tides",
        scenes: [
          { type: "intro", title: "How tides work" },
          {
            layout: "metric",
            heading: "Twice a day",
            value: "2x",
            suffix: "x",
          },
          {
            layout: "process",
            heading: "Steps",
            points: ["Moon pulls", "Water bulges", "", "Earth spins"],
          },
          {
            layout: "graph",
            heading: "Height",
            data: [
              { label: "Mon", value: "3" },
              { label: "bad", value: "x" },
            ],
          },
          {
            layout: "whatever",
            heading: "Fallback",
            icon: "BOLT",
            seconds: 99,
          },
          "junk",
          {},
        ],
      },
      "fallback",
    );
    expect(o.title).toBe("Tides");
    expect(o.scenes.map((s) => s.layout)).toEqual([
      "title",
      "stat",
      "steps",
      "chart",
      "statement",
    ]);
    expect(o.scenes[1].value).toBe(2);
    expect(o.scenes[2].items).toEqual([
      "Moon pulls",
      "Water bulges",
      "Earth spins",
    ]);
    expect(o.scenes[3].data).toEqual([{ label: "Mon", value: 3 }]);
    expect(o.scenes[4].icon).toBe("bolt");
    expect(o.scenes[4].seconds).toBe(LIMITS.sceneSeconds.max);
    expect(normalizeOutline(null, "x").title).toBe("x");
  });

  it.each(LAYOUTS)(
    "layout %s compiles to a strict-valid spec at every aspect",
    (layout) => {
      const outline = normalizeOutline({
        title: "T",
        scenes: [
          {
            layout,
            heading: "A clear *headline* here",
            body: "Supporting line",
            items: ["One", "Two", "Three"],
            value: 42,
            unit: "%",
            data: [
              { label: "A", value: 1 },
              { label: "B", value: 4 },
            ],
            narration: "Narration line.",
          },
        ],
      });
      for (const aspect of ASPECT_KEYS) {
        const spec = compileOutline(outline, { aspect, theme: "midnight" });
        expect(
          validateSpec(JSON.parse(JSON.stringify(spec)), "strict").errors,
        ).toEqual([]);
        expect(spec.scenes[0].narration).toBe("Narration line.");
      }
    },
  );

  it("helpers: icon keywords, reading time, emphasis", () => {
    expect(iconFor("Ship it faster")).toBe("bolt");
    expect(iconFor("Protect your files")).toBe("lock");
    expect(ICON_NAMES).toContain(iconFor("zzz", 3));
    expect(
      readSeconds("one two three four five six seven eight nine"),
    ).toBeGreaterThan(readSeconds("hi"));
    expect(autoEmphasis("Save *ten* hours")).toBe("Save *ten* hours");
    expect(autoEmphasis("Save ten hours every week")).toMatch(/\*/);
  });
});

describe("icons", () => {
  it("parses the mini path language", () => {
    const lines = parsePath("M0 0 L10 0 L10 10 M20 20 L30 20");
    expect(lines).toHaveLength(2);
    expect(polylineLength(lines[0])).toBeCloseTo(20, 6);
  });

  it.each(ICON_NAMES)("%s has drawable strokes", (name) => {
    const s = iconStrokes(name);
    expect(s.length).toBeGreaterThan(0);
    for (const line of s)
      for (const [x, y] of line) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
      }
  });

  it("partial strokes grow with progress; pen follows", () => {
    const s = iconStrokes("rocket");
    const total = (ls: typeof s) =>
      ls.reduce((a, l) => a + polylineLength(l), 0);
    expect(partialStrokes(s, 0)).toEqual([]);
    expect(total(partialStrokes(s, 1))).toBeCloseTo(total(s), 4);
    const a = total(partialStrokes(s, 0.3));
    const b = total(partialStrokes(s, 0.6));
    expect(b).toBeGreaterThan(a);
    expect(a / total(s)).toBeCloseTo(0.3, 1);
    expect(penPosition(s, 0.5)).not.toBeNull();
  });
});

/** Canvas 2D stand-in: records calls, measures text at 10px/char. */
function mockCtx(width: number, height: number) {
  const calls: string[] = [];
  const grad = { addColorStop: () => undefined };
  const target: Record<string | symbol, unknown> = {
    canvas: { width, height },
    measureText: (s: string) => ({
      width: s.length * 10,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
    }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createConicGradient: () => grad,
    createPattern: () => null,
    getLineDash: () => [],
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  };
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "string") {
        return (...args: unknown[]) => {
          calls.push(k);
          for (const a of args)
            if (typeof a === "number" && !Number.isFinite(a))
              throw new Error(`${k} got non-finite arg`);
        };
      }
      return undefined;
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("renderer", () => {
  for (const t of MOTION_TEMPLATES) {
    it(`renders ${t.id} across its timeline with finite geometry`, () => {
      for (const aspect of ["16:9", "9:16"] as Aspect[]) {
        const spec = buildTemplate(t.id, {}, { aspect });
        const { width, height } = ASPECTS[aspect];
        const { ctx, calls } = mockCtx(width / 2, height / 2);
        const total = totalDuration(spec);
        const times = [
          0,
          0.1,
          0.5,
          1,
          ...sceneSpans(spec).flatMap((s) => [
            s.start + 0.2,
            (s.start + s.end) / 2,
            s.end - 0.05,
          ]),
          total,
        ];
        for (const time of times) renderFrame(ctx, spec, time);
        expect(calls).toContain("fillRect");
        expect(calls.filter((c) => c === "fillText").length).toBeGreaterThan(0);
        expect(calls.filter((c) => c === "save").length).toBe(
          calls.filter((c) => c === "restore").length,
        );
      }
    });
  }

  it("renders a video background from a provided clip", () => {
    const spec = buildTemplate("lower_third");
    const { ctx, calls } = mockCtx(640, 360);
    renderFrame(ctx, spec, 1, {
      video: {
        videoWidth: 1920,
        videoHeight: 1080,
      } as unknown as HTMLVideoElement,
    });
    expect(calls).toContain("drawImage");
  });

  it("parseRich marks *accent* runs", () => {
    expect(parseRich("make it *really fast* now")[0]).toEqual([
      { text: "make", accent: false },
      { text: "it", accent: false },
      { text: "really", accent: true },
      { text: "fast", accent: true },
      { text: "now", accent: false },
    ]);
    expect(parseRich("a\nb")).toHaveLength(2);
  });

  it("layoutText wraps greedily at maxWidth", () => {
    const m = (s: string) => s.length * 10;
    const l = layoutText(m, "aaaa bbbb cccc", 95, 20);
    expect(l.words.map((w) => w.line)).toEqual([0, 0, 1]);
    expect(l.lineWidths).toEqual([90, 40]);
    expect(l.height).toBe(40);
    expect(l.width).toBe(90);
    expect(layoutText(m, "x\ny", 1000, 10).words.map((w) => w.line)).toEqual([
      0, 1,
    ]);
  });

  it("color helpers", () => {
    expect(hexToRgb("#ff8000")).toEqual([255, 128, 0]);
    expect(hexToRgb("#fff")).toEqual([255, 255, 255]);
    expect(luminance("#ffffff")).toBeGreaterThan(luminance("#101010"));
  });
});

import { describe, it, expect } from "vitest";
import {
  CINEMA_KNOBS,
  CINEMA_KNOB_KEYS,
  CINEMA_TOOL_OMIT,
  appendCinema,
  cinemaCount,
  cinemaKnobsFor,
  cinemaOption,
  cinemaSupported,
  compileCinema,
  compileSceneShots,
  defaultScene,
  groupCinemaOptions,
  resizeScene,
  sceneActive,
  sceneShotSettings,
  SCENE_MAX_SHOTS,
  SCENE_MIN_SHOTS,
  type CinemaScene,
} from "@/lib/tools/cinema";

describe("cinema knobs data", () => {
  it("has unique keys and unique option ids per knob", () => {
    expect(new Set(CINEMA_KNOB_KEYS).size).toBe(CINEMA_KNOBS.length);
    for (const k of CINEMA_KNOBS) {
      const ids = k.options.map((o) => o.id);
      expect(new Set(ids).size, k.key).toBe(ids.length);
      for (const o of k.options) {
        expect(o.text.trim(), `${k.key}.${o.id}`).toBe(o.text);
        expect(o.text.length).toBeGreaterThan(0);
        // Phrases are joined with ", " and closed with ".": keep them clean.
        expect(o.text).not.toMatch(/[,.;]$/);
      }
    }
  });

  it("covers the requested knobs and movements", () => {
    expect(CINEMA_KNOB_KEYS).toEqual([
      "shot",
      "movement",
      "speed",
      "camera",
      "lens",
      "aperture",
      "look",
      "lighting",
      "era",
      "genre",
      "palette",
      "emotion",
      "pacing",
    ]);
    const moves = CINEMA_KNOBS.find((k) => k.key === "movement")!.options.map(
      (o) => o.id,
    );
    for (const m of [
      "dolly_in",
      "dolly_out",
      "crane_up",
      "orbit",
      "whip_pan",
      "handheld",
      "fpv",
      "crash_zoom",
      "rack_focus",
      "snorricam",
      "robo_arm",
      "through_object",
      "hyperlapse",
      "wiggle",
    ])
      expect(moves).toContain(m);
    const shots = CINEMA_KNOBS.find((k) => k.key === "shot")!.options;
    expect(shots.map((o) => o.id)).toContain("dutch_angle");
  });

  it("has Cinema Studio 4.0-style story knobs (era, genre, palette, emotion, pacing)", () => {
    const count = (key: string) =>
      CINEMA_KNOBS.find((k) => k.key === key)!.options.length;
    expect(count("era")).toBeGreaterThanOrEqual(5);
    expect(count("genre")).toBeGreaterThanOrEqual(6);
    expect(count("palette")).toBeGreaterThanOrEqual(48);
    expect(count("emotion")).toBeGreaterThanOrEqual(6);
    expect(count("pacing")).toBe(4);
    expect(compileCinema({ genre: "noir", pacing: "calm", shot: "wide" })).toBe(
      [
        cinemaOption("shot", "wide")!.text,
        cinemaOption("genre", "noir")!.text,
        cinemaOption("pacing", "calm")!.text,
      ].join(", "),
    );
  });

  it("uses no Higgsfield branding", () => {
    const all = JSON.stringify(CINEMA_KNOBS).toLowerCase();
    expect(all).not.toContain("higgsfield");
  });
});

describe("compileCinema", () => {
  it("returns empty for no choices", () => {
    expect(compileCinema({})).toBe("");
    expect(cinemaCount({})).toBe(0);
  });

  it("joins chosen phrases in knob order, not insertion order", () => {
    const out = compileCinema({
      lighting: "golden_hour",
      shot: "wide",
      lens: "anamorphic",
    });
    expect(out).toBe(
      [
        cinemaOption("shot", "wide")!.text,
        cinemaOption("lens", "anamorphic")!.text,
        cinemaOption("lighting", "golden_hour")!.text,
      ].join(", "),
    );
  });

  it("ignores unknown ids and omitted keys", () => {
    expect(compileCinema({ lens: "nope", look: "" })).toBe("");
    expect(compileCinema({ movement: "orbit", look: "bw" }, ["movement"])).toBe(
      cinemaOption("look", "bw")!.text,
    );
    expect(cinemaCount({ movement: "orbit", look: "bw" }, ["movement"])).toBe(
      1,
    );
  });
});

describe("appendCinema", () => {
  it("leaves the prompt alone when there is no suffix", () => {
    expect(appendCinema("  a cat  walks ", "")).toBe("a cat walks");
  });

  it("adds the suffix as its own sentence", () => {
    expect(appendCinema("a cat walks", "wide shot")).toBe(
      "a cat walks. wide shot.",
    );
    expect(appendCinema("a cat walks!", "wide shot")).toBe(
      "a cat walks! wide shot.",
    );
  });

  it("uses the suffix alone for an empty prompt", () => {
    expect(appendCinema("   ", "wide shot")).toBe("wide shot.");
  });
});

describe("tool support", () => {
  it("is offered on the video tools only", () => {
    for (const id of ["camera_move", "orbit_360", "transition", "animate"])
      expect(cinemaSupported(id)).toBe(true);
    for (const id of ["character_swap", "face_swap", "edit_photo", undefined])
      expect(cinemaSupported(id)).toBe(false);
  });

  it("hides knobs a tool already fixes", () => {
    const cam = cinemaKnobsFor("camera_move").map((k) => k.key);
    expect(cam).not.toContain("movement");
    expect(cam).toContain("lens");
    const orbit = cinemaKnobsFor("orbit_360").map((k) => k.key);
    expect(orbit).not.toContain("movement");
    expect(orbit).not.toContain("speed");
    expect(cinemaKnobsFor("transition")).toHaveLength(CINEMA_KNOBS.length);
    expect(cinemaKnobsFor()).toHaveLength(CINEMA_KNOBS.length);
    expect(Object.keys(CINEMA_TOOL_OMIT)).toContain("animate");
  });
});

describe("named palettes", () => {
  const palette = CINEMA_KNOBS.find((k) => k.key === "palette")!;

  it("are all grouped, with each group contiguous", () => {
    for (const o of palette.options) expect(o.group, o.id).toBeTruthy();
    const groups = groupCinemaOptions(palette.options);
    expect(groups.length).toBeGreaterThanOrEqual(6);
    expect(groups.reduce((n, g) => n + g.options.length, 0)).toBe(
      palette.options.length,
    );
    // Contiguous: the flattened groups equal the original order.
    expect(groups.flatMap((g) => g.options.map((o) => o.id))).toEqual(
      palette.options.map((o) => o.id),
    );
    for (const g of groups) expect(g.options.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps the earlier palette ids (saved settings still resolve)", () => {
    for (const id of [
      "bleached_noon",
      "violet_dusk",
      "deep_emerald",
      "earthy_ochre",
      "chalky_terracotta",
      "steel_rust",
      "plush_pink",
      "neon_wet_street",
      "turquoise_sand",
      "crimson_gold",
      "sodium_night",
      "candy_pastel",
      "glowing_teal",
      "dusty_amber",
      "cool_grey",
      "mustard_yellow",
    ])
      expect(cinemaOption("palette", id), id).toBeDefined();
  });

  it("has unique labels and compiles a named look", () => {
    const labels = palette.options.map((o) => o.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
    expect(compileCinema({ palette: "teal_orange_blockbuster" })).toContain(
      "teal",
    );
    expect(compileCinema({ palette: "sodium_night" })).toContain("sodium");
    expect(compileCinema({ palette: "silver_retention" })).toContain(
      "silver",
    );
  });

  it("leaves ungrouped knobs as one unnamed group", () => {
    const shot = CINEMA_KNOBS.find((k) => k.key === "shot")!;
    const g = groupCinemaOptions(shot.options);
    expect(g).toHaveLength(1);
    expect(g[0].group).toBe("");
  });
});

describe("multi-shot scene", () => {
  const scene: CinemaScene = {
    character: "an old sea captain in a yellow raincoat",
    location: "a storm-lashed harbor at dusk",
    shots: [
      { shot: "wide", movement: "dolly_in", action: "he walks to the pier" },
      { shot: "close", lens: "portrait" },
    ],
  };

  it("is active only with 2-4 shots", () => {
    expect(sceneActive(null)).toBe(false);
    expect(sceneActive({ ...scene, shots: [scene.shots[0]] })).toBe(false);
    expect(sceneActive(scene)).toBe(true);
    expect(sceneActive(defaultScene(SCENE_MAX_SHOTS))).toBe(true);
    expect(
      sceneActive({ ...scene, shots: Array(SCENE_MAX_SHOTS + 1).fill({}) }),
    ).toBe(false);
  });

  it("defaults and resizes within bounds, keeping edited shots", () => {
    expect(defaultScene().shots).toHaveLength(3);
    expect(defaultScene(1).shots).toHaveLength(SCENE_MIN_SHOTS);
    expect(defaultScene(9).shots).toHaveLength(SCENE_MAX_SHOTS);
    const grown = resizeScene(scene, 4);
    expect(grown.shots).toHaveLength(4);
    expect(grown.shots[0]).toEqual(scene.shots[0]);
    expect(grown.character).toBe(scene.character);
    expect(resizeScene(grown, 2).shots).toEqual(scene.shots);
    // Defaults reference real options.
    for (const s of defaultScene(4).shots) {
      expect(cinemaOption("shot", s.shot)).toBeDefined();
      expect(cinemaOption("movement", s.movement)).toBeDefined();
    }
  });

  it("shot overrides beat the panel, other knobs are shared", () => {
    const base = { shot: "medium", palette: "sodium_night", lens: "wide" };
    expect(sceneShotSettings(base, { shot: "close" })).toEqual({
      shot: "close",
      palette: "sodium_night",
      lens: "wide",
    });
    expect(sceneShotSettings(base, {})).toEqual(base);
  });

  it("compiles one prompt per shot with shared character and location", () => {
    const out = compileSceneShots("rain pours", scene, {
      palette: "sodium_night",
    });
    expect(out).toHaveLength(2);
    for (const p of out) {
      expect(p.startsWith("rain pours. an old sea captain")).toBe(true);
      expect(p).toContain("Location: a storm-lashed harbor at dusk.");
      expect(p).toContain(cinemaOption("palette", "sodium_night")!.text);
      expect(p.endsWith(".")).toBe(true);
    }
    expect(out[0]).toContain("he walks to the pier.");
    expect(out[0]).toContain(cinemaOption("shot", "wide")!.text);
    expect(out[0]).toContain(cinemaOption("movement", "dolly_in")!.text);
    expect(out[1]).toContain(cinemaOption("shot", "close")!.text);
    expect(out[1]).toContain(cinemaOption("lens", "portrait")!.text);
    expect(out[1]).not.toContain("pier");
  });

  it("drops knobs the tool fixes and survives empty text", () => {
    const out = compileSceneShots(
      "",
      { character: "", location: "", shots: scene.shots },
      {},
      CINEMA_TOOL_OMIT.camera_move,
    );
    expect(out[0]).not.toContain(cinemaOption("movement", "dolly_in")!.text);
    expect(out[0]).toBe(
      `he walks to the pier. ${cinemaOption("shot", "wide")!.text}.`,
    );
    expect(out[1]).toBe(
      `${[cinemaOption("shot", "close")!.text, cinemaOption("lens", "portrait")!.text].join(", ")}.`,
    );
  });
});

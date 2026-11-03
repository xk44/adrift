import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  ACCENTS,
  ADRIFT_DARK,
  ADRIFT_LIGHT,
  DEFAULT_THEME_PREFS,
  SEMANTIC_KEYS,
  THEME_PRESETS,
  buildThemeBootScript,
  buildThemeCss,
  deriveAccent,
  hexToChannels,
  resolveThemeAttrs,
  sanitizeThemePrefs,
} from "@/lib/theme/themes";
import { DARK_SCALE_KEYS, LIGHT_SCALE_KEYS } from "@/lib/theme/tokens";
import { LEGACY_STORAGE_KEYS, STORAGE_KEYS } from "@/lib/storageKeys";

const LEGACY_UI_KEY = LEGACY_STORAGE_KEYS[STORAGE_KEYS.ui] as string;

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The hardcoded values tailwind.config.ts and globals.css carried before
// themes. The default look must stay pixel-identical.
const OLD_TAILWIND = {
  light: {
    50: "#fafafa",
    100: "#f4f4f5",
    200: "#e4e4e7",
    300: "#d4d4d8",
    400: "#a1a1aa",
    500: "#63636b",
    600: "#52525b",
    700: "#3f3f46",
    bg: "#ffffff",
    input: "#f4f4f5",
    primary: "#09090b",
  },
  dark: {
    200: "#3f3f46",
    300: "#52525b",
    400: "#8e8e97",
    500: "#a1a1aa",
    600: "#d4d4d8",
    700: "#e4e4e7",
    750: "#2a2a2e",
    800: "#1e1e22",
    850: "#19191d",
    900: "#141417",
    bg: "#0d0e12",
    input: "#1a1b21",
    primary: "#f4f4f5",
  },
  splash: "#f2330d",
};

const OLD_CSS_DARK = {
  "--bg-primary": "#0d0e12",
  "--bg-secondary": "#1e1f25",
  "--bg-tertiary": "#16181d",
  "--bg-hover": "#292c32",
  "--bg-active": "#292c32",
  "--border-primary": "#292c32",
  "--border-secondary": "#434651",
  "--border-accent": "#434651",
  "--text-primary": "#ebecef",
  "--text-secondary": "#a3a6af",
  "--text-tertiary": "#8f929c",
  "--text-muted": "#858892",
  "--accent-primary": "#f2330d",
  "--accent-secondary": "#f55c3d",
  "--accent-hover": "#c2290a",
  "--scrollbar-thumb": "rgba(255, 255, 255, 0.12)",
  "--scrollbar-thumb-hover": "rgba(255, 255, 255, 0.22)",
  "--focus-ring": "#c9cbd1",
};

const OLD_CSS_LIGHT = {
  "--bg-primary": "#ffffff",
  "--bg-secondary": "#f5f5f5",
  "--bg-tertiary": "#ebebeb",
  "--bg-hover": "#e0e0e0",
  "--bg-active": "#d5d5d5",
  "--border-primary": "#e0e0e0",
  "--border-secondary": "#d0d0d0",
  "--border-accent": "#c0c0c0",
  "--text-primary": "#0d0d0d",
  "--text-secondary": "#525252",
  "--text-tertiary": "#5f5f5f",
  "--text-muted": "#696969",
  "--focus-ring": "#3d3f45",
  "--scrollbar-thumb": "rgba(0, 0, 0, 0.14)",
  "--scrollbar-thumb-hover": "rgba(0, 0, 0, 0.26)",
};

const themeCss = buildThemeCss();

function cssBlock(selector: string): Record<string, string> {
  const start = themeCss.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`missing ${selector} block`);
  const body = themeCss.slice(start, themeCss.indexOf("}", start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2];
  return vars;
}

describe("theme presets: table completeness", () => {
  it("has unique ids and names, and the requested presets", () => {
    const ids = THEME_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(THEME_PRESETS.map((p) => p.name)).size).toBe(ids.length);
    expect(ids).toEqual([
      "adrift-dark",
      "adrift-light",
      "oled",
      "midnight",
      "frost",
      "dusk",
      "paper",
      "contrast",
    ]);
  });

  for (const preset of THEME_PRESETS) {
    it(`${preset.id} defines every ${preset.mode} scale step and semantic token`, () => {
      const keys: readonly string[] =
        preset.mode === "dark" ? DARK_SCALE_KEYS : LIGHT_SCALE_KEYS;
      expect(Object.keys(preset.scale).sort()).toEqual([...keys].sort());
      for (const k of keys) {
        expect((preset.scale as Record<string, string>)[k], k).toMatch(
          /^#[0-9a-f]{6}$/,
        );
      }
      expect(Object.keys(preset.semantic).sort()).toEqual(
        [...SEMANTIC_KEYS].sort(),
      );
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    });
  }

  it("OLED Black uses true #000 surfaces", () => {
    const oled = THEME_PRESETS.find((p) => p.id === "oled")!;
    expect(oled.scale.bg).toBe("#000000");
    expect(oled.semantic["--bg-primary"]).toBe("#000000");
  });
});

describe("theme presets: default look is unchanged", () => {
  it("Adrift scales equal the old Tailwind hex", () => {
    expect(ADRIFT_DARK.scale).toEqual(
      Object.fromEntries(
        Object.entries(OLD_TAILWIND.dark).map(([k, v]) => [String(k), v]),
      ),
    );
    expect(ADRIFT_LIGHT.scale).toEqual(
      Object.fromEntries(
        Object.entries(OLD_TAILWIND.light).map(([k, v]) => [String(k), v]),
      ),
    );
  });

  it("the generated :root channels equal the old Tailwind hex", () => {
    const root = cssBlock(":root");
    for (const scale of ["dark", "light"] as const) {
      for (const [k, hex] of Object.entries(OLD_TAILWIND[scale])) {
        expect(root[`--c-${scale}-${k}`], `${scale}-${k}`).toBe(
          hexToChannels(hex),
        );
      }
    }
    expect(root["--c-splash"]).toBe("242 51 13");
  });

  it("the generated :root / light blocks equal the old globals.css tokens", () => {
    const root = cssBlock(":root");
    for (const [k, v] of Object.entries(OLD_CSS_DARK))
      expect(root[k], k).toBe(v);
    const light = cssBlock('[data-theme="light"]');
    for (const [k, v] of Object.entries(OLD_CSS_LIGHT))
      expect(light[k], k).toBe(v);
  });

  it("scopes every non-default preset to its own mode", () => {
    for (const p of THEME_PRESETS.slice(2)) {
      const block = cssBlock(
        `[data-theme="${p.mode}"][data-palette="${p.id}"]`,
      );
      expect(block[`--c-${p.mode}-bg`]).toBe(hexToChannels(p.scale.bg));
      expect(block["--bg-primary"]).toBe(p.semantic["--bg-primary"]);
      const other = p.mode === "dark" ? "light" : "dark";
      expect(
        Object.keys(block).some((k) => k.startsWith(`--c-${other}-`)),
      ).toBe(false);
    }
  });
});

describe("accent", () => {
  it("derives the original Adrift secondary/hover exactly", () => {
    expect(deriveAccent("#f2330d")).toEqual({
      primary: "#f2330d",
      secondary: "#f55c3d",
      hover: "#c2290a",
    });
  });

  it("derives a lighter secondary and darker hover for every swatch", () => {
    const lum = (h: string) => contrast(h, "#000000");
    for (const a of ACCENTS) {
      const d = deriveAccent(a.hex);
      expect(lum(d.secondary), a.id).toBeGreaterThan(lum(d.primary));
      expect(lum(d.hover), a.id).toBeLessThan(lum(d.primary));
    }
  });

  it("offers Adrift plus six swatches with distinct ids", () => {
    expect(ACCENTS[0]).toEqual({
      id: "adrift",
      name: "Adrift",
      hex: "#f2330d",
    });
    expect(ACCENTS).toHaveLength(7);
    expect(new Set(ACCENTS.map((a) => a.id)).size).toBe(7);
  });

  it("keeps >= 3:1 against white labels and every preset background", () => {
    for (const a of ACCENTS) {
      expect(
        contrast(a.hex, "#ffffff"),
        `${a.id} on white`,
      ).toBeGreaterThanOrEqual(3);
      for (const p of THEME_PRESETS) {
        expect(
          contrast(a.hex, p.semantic["--bg-primary"]),
          `${a.id} on ${p.id}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("emits a data-accent block per non-default swatch", () => {
    for (const a of ACCENTS.slice(1)) {
      const block = cssBlock(`[data-accent="${a.id}"]`);
      expect(block["--accent-primary"]).toBe(a.hex);
      expect(block["--c-splash"]).toBe(hexToChannels(a.hex));
    }
  });
});

describe("persisted prefs migration", () => {
  it("old builds (theme only) keep their mode and get the defaults", () => {
    expect(sanitizeThemePrefs({ theme: "light" })).toEqual({
      ...DEFAULT_THEME_PREFS,
      theme: "light",
    });
    expect(sanitizeThemePrefs({ theme: "dark" })).toEqual(DEFAULT_THEME_PREFS);
    expect(sanitizeThemePrefs(undefined)).toEqual(DEFAULT_THEME_PREFS);
  });

  it("drops unknown ids and palettes stored under the wrong mode", () => {
    expect(
      sanitizeThemePrefs({
        theme: "sepia",
        darkPalette: "paper",
        lightPalette: "nope",
        accent: "chartreuse",
        followSystem: "yes",
      }),
    ).toEqual(DEFAULT_THEME_PREFS);
  });

  it("keeps valid choices", () => {
    const prefs = {
      theme: "light" as const,
      followSystem: true,
      darkPalette: "oled",
      lightPalette: "paper",
      accent: "teal",
    };
    expect(sanitizeThemePrefs(prefs)).toEqual(prefs);
  });

  it("resolves the active palette from the mode (and the system when followed)", () => {
    const prefs = {
      ...DEFAULT_THEME_PREFS,
      darkPalette: "midnight",
      lightPalette: "paper",
    };
    expect(resolveThemeAttrs(prefs).palette).toBe("midnight");
    expect(resolveThemeAttrs({ ...prefs, theme: "light" }).palette).toBe(
      "paper",
    );
    const sys = resolveThemeAttrs({ ...prefs, followSystem: true }, true);
    expect(sys).toMatchObject({ mode: "light", palette: "paper" });
    expect(sys.themeColor).toBe("#faf8f5");
  });
});

describe("boot script (no flash of the wrong theme)", () => {
  function run(stored: Record<string, string>, prefersLight = false) {
    const attrs: Record<string, string> = {};
    const meta = {
      content: "",
      setAttribute: (_: string, v: string) => (meta.content = v),
    };
    const sandbox = {
      localStorage: { getItem: (k: string) => stored[k] ?? null },
      window: { matchMedia: () => ({ matches: prefersLight }) },
      document: {
        documentElement: {
          setAttribute: (k: string, v: string) => (attrs[k] = v),
        },
        querySelector: () => meta,
      },
    };
    runInNewContext(
      buildThemeBootScript([STORAGE_KEYS.ui, LEGACY_UI_KEY]),
      sandbox,
    );
    return { attrs, themeColor: meta.content };
  }

  const persisted = (state: object) => JSON.stringify({ state, version: 0 });

  it("applies the persisted palette, accent and chrome color", () => {
    const r = run({
      "adrift.ui": persisted({
        theme: "dark",
        darkPalette: "oled",
        accent: "blue",
      }),
    });
    expect(r.attrs).toEqual({
      "data-theme": "dark",
      "data-palette": "oled",
      "data-accent": "blue",
    });
    expect(r.themeColor).toBe("#000000");
  });

  it("reads the pre-rename key and old theme-only state", () => {
    const r = run({ [LEGACY_UI_KEY]: persisted({ theme: "light" }) });
    expect(r.attrs).toEqual({
      "data-theme": "light",
      "data-palette": "adrift-light",
      "data-accent": "adrift",
    });
    expect(r.themeColor).toBe("#ffffff");
  });

  it("falls back to defaults on garbage and follows the system when asked", () => {
    expect(run({ "adrift.ui": "{not json" }).attrs["data-palette"]).toBe(
      "adrift-dark",
    );
    const r = run(
      {
        "adrift.ui": persisted({
          theme: "dark",
          followSystem: true,
          lightPalette: "paper",
          darkPalette: "paper",
        }),
      },
      true,
    );
    expect(r.attrs["data-theme"]).toBe("light");
    expect(r.attrs["data-palette"]).toBe("paper");
  });
});

describe("uiStore theme actions", () => {
  it("setPalette stores the preset for its mode and switches mode; toggle keeps both picks", async () => {
    const { useUIStore } = await import("@/store");
    const s = useUIStore.getState();
    s.setFollowSystem(true);
    s.setPalette("paper");
    let st = useUIStore.getState();
    expect(st).toMatchObject({ theme: "light", lightPalette: "paper", followSystem: false });
    st.setPalette("midnight");
    st = useUIStore.getState();
    expect(st).toMatchObject({ theme: "dark", darkPalette: "midnight", lightPalette: "paper" });
    st.toggleTheme();
    expect(useUIStore.getState().theme).toBe("light");
    st.setPalette("not-a-theme");
    st.setAccent("not-an-accent");
    st.setAccent("violet");
    expect(useUIStore.getState()).toMatchObject({ lightPalette: "paper", accent: "violet" });
  });
});

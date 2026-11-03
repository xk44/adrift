import { describe, expect, it } from "vitest";
import editToolRegistry from "@/lib/tools/editToolRegistry.json";
import {
  catalogNameKey,
  catalogToolTitle,
  EXPAND_KEY,
  TOOL_NAMES,
  toolAliases,
  toolName,
  toolTitle,
} from "@/lib/tools/toolNames";
import {
  ACTION_TOOLS,
  buildToolCards,
  type CatalogTool,
} from "@/lib/tools/toolsPage";
import { buildHubCards, CARD_OVERRIDES, filterHubCards } from "@/lib/tools/hub";
import {
  INLINE_TOOL_NAME_KEY,
  INLINE_TOOLS,
  buildLightboxTools,
  filterLightboxTools,
} from "@/lib/ui/lightboxTools";
import { actionLabel, runProvenance, toolLabel } from "@/lib/runProvenance";
import { QUICK_EDIT_MODES } from "@/lib/quickEdit";
import { EDIT_MODES } from "@/lib/krea2/editModes";
import editLoraRegistry from "@/lib/krea2/editLoraRegistry.json";

const editLoraFamilies = (
  editLoraRegistry as { families: Record<string, { label: string }> }
).families;

type RegistryTool = { id: string; label: string; outpaint?: unknown };
const REGISTRY = (editToolRegistry as { tools: RegistryTool[] }).tools;

/** Every registry tool as an installed catalog entry (the live GET /api/tools). */
const CATALOG = REGISTRY.map(
  (t) =>
    ({
      ...t,
      installed: true,
      packAvailable: true,
      available: true,
    }) as unknown as CatalogTool,
);

const ctx = { catalog: CATALOG, packIds: null, editLoras: null };
const HUB = buildHubCards({ toolCards: buildToolCards(ctx), ctx });
const NAMED = HUB.filter((c) => c.kind === "action" || c.kind === "catalog");
const LIGHTBOX = buildLightboxTools(CATALOG);

const lc = (s: string) => s.toLowerCase();
const isNameOf = (key: string, name: string) => {
  const n = toolName(key);
  return (
    !!n &&
    (lc(n.title) === lc(name) || n.aliases.some((a) => lc(a) === lc(name)))
  );
};

describe("toolNames: one canonical name per tool", () => {
  it("has a title and case-unique aliases for every key", () => {
    for (const [key, n] of Object.entries(TOOL_NAMES)) {
      expect(n.title.trim(), key).not.toBe("");
      const seen = n.aliases.map(lc);
      expect(new Set(seen).size, key).toBe(seen.length);
      expect(seen, key).not.toContain(lc(n.title));
    }
  });

  it("names only real tools (Tools-page cards or lightbox operations)", () => {
    const hubKeys = new Set(HUB.map((c) => c.key));
    for (const key of Object.keys(TOOL_NAMES)) {
      if (key.startsWith("inline:") || key.startsWith("lightbox:")) continue;
      // Hidden (retired/stub) tools keep their names for old runs.
      if (ACTION_TOOLS.some((s) => s.hidden && `action:${s.id}` === key))
        continue;
      // Outpaint backends fold into the one Expand card (their runs read
      // "Expand"); their per-backend names stay for the backend picker.
      const folded =
        key.startsWith("catalog:") &&
        catalogNameKey(key.slice("catalog:".length)) === EXPAND_KEY;
      expect(hubKeys.has(key) || folded, key).toBe(true);
    }
  });

  it("covers every action card, and canonical titles are not reused", () => {
    for (const spec of ACTION_TOOLS) {
      expect(toolName(`action:${spec.id}`), spec.id).toBeDefined();
    }
    const byTitle = new Map<string, string>();
    for (const [key, n] of Object.entries(TOOL_NAMES)) {
      const prev = byTitle.get(lc(n.title));
      expect(prev, `${key} reuses "${n.title}"`).toBeUndefined();
      byTitle.set(lc(n.title), key);
    }
  });
});

describe("Tools page reads the map", () => {
  it("every action/catalog card title is the canonical name", () => {
    expect(NAMED.length).toBeGreaterThan(ACTION_TOOLS.length);
    for (const card of NAMED) {
      const n = toolName(card.key);
      if (n) expect(card.title, card.key).toBe(n.title);
    }
    expect(HUB.find((c) => c.key === EXPAND_KEY)?.title).toBe("Expand");
  });

  it("CARD_OVERRIDES titles/aliases are the map's", () => {
    for (const [key, o] of Object.entries(CARD_OVERRIDES)) {
      expect(o.title, key).toBe(toolTitle(key));
      expect(o.aliases, key).toEqual([...toolAliases(key)]);
    }
  });

  it("old action-spec titles and registry labels are canonical or aliases", () => {
    for (const spec of ACTION_TOOLS) {
      expect(isNameOf(`action:${spec.id}`, spec.title), spec.id).toBe(true);
    }
    for (const t of REGISTRY) {
      const key = catalogNameKey(t.id);
      if (!toolName(key)) continue;
      expect(isNameOf(key, t.label), `${t.id} "${t.label}"`).toBe(true);
    }
  });

  it("searching any alias finds its card", () => {
    for (const card of NAMED) {
      for (const alias of toolAliases(card.key)) {
        expect(
          filterHubCards(HUB, alias).map((c) => c.key),
          `${alias} → ${card.key}`,
        ).toContain(card.key);
      }
    }
  });

  it.each([
    ["outpaint", EXPAND_KEY],
    ["zoom out", EXPAND_KEY],
    ["pan", EXPAND_KEY],
    ["head swap", "catalog:qwen21-head-swap"],
    ["remove object", "action:remove_object"],
    ["adetailer", "action:enhance_faces"],
    ["animate image", "action:animate"],
  ])("legacy name %j finds %s on the Tools page", (query, key) => {
    expect(filterHubCards(HUB, query).map((c) => c.key)).toContain(key);
  });
});

describe("lightbox Tools panel reads the map", () => {
  it("inline row titles lead with the canonical name", () => {
    for (const t of INLINE_TOOLS) {
      const nameKey = INLINE_TOOL_NAME_KEY[t.key];
      expect(nameKey, t.key).toBeDefined();
      expect(t.title.startsWith(toolTitle(nameKey)), t.key).toBe(true);
    }
    const title = (k: string) => INLINE_TOOLS.find((t) => t.key === k)?.title;
    expect(title("inline:zoom")).toBe("Expand (zoom out)");
    expect(title("inline:pan")).toBe("Expand (pan)");
    expect(title("inline:adetailer")).toBe("Face Enhancer");
  });

  it("hub entries in the panel carry canonical titles", () => {
    for (const t of LIGHTBOX) {
      const n = toolName(t.key);
      if (n) expect(t.title, t.key).toBe(n.title);
    }
  });

  it("searching any alias of an inline row finds it", () => {
    for (const t of INLINE_TOOLS) {
      for (const alias of t.aliases) {
        const hits = filterLightboxTools(LIGHTBOX, {
          media: t.media[0],
          external: false,
          query: alias,
        }).map((x) => x.key);
        expect(hits, `${alias} → ${t.key}`).toContain(t.key);
      }
    }
  });

  it.each([
    ["outpaint", ["inline:zoom", "inline:pan", EXPAND_KEY]],
    ["zoom out", ["inline:zoom", EXPAND_KEY]],
    ["pan", ["inline:pan", EXPAND_KEY]],
    ["expand", ["inline:zoom", "inline:pan", EXPAND_KEY]],
    ["head swap", ["catalog:qwen21-head-swap"]],
    ["face & hands", ["inline:adetailer"]],
  ])("%j finds %j", (query, expected) => {
    const hits = filterLightboxTools(LIGHTBOX, {
      media: "image",
      external: false,
      query,
    }).map((x) => x.key);
    expect(hits).toEqual(expect.arrayContaining(expected));
  });
});

describe("provenance chips + Made with labels read the map", () => {
  it("action cards label as their canonical name", () => {
    for (const spec of ACTION_TOOLS) {
      expect(actionLabel(spec.id), spec.id).toBe(
        toolTitle(`action:${spec.id}`),
      );
    }
  });

  it("lightbox actions label as tool · variant", () => {
    expect(actionLabel("pan_left")).toBe("Expand · Pan left");
    expect(actionLabel("zoom_1_5x")).toBe("Expand · Zoom out 1.5×");
    expect(actionLabel("zoom_out_2x")).toBe("Expand · Zoom out 2×");
    expect(actionLabel("animate_low")).toBe("Image to Video · Low motion");
    expect(actionLabel("adetailer")).toBe("Face Enhancer");
    expect(actionLabel("adetailer_auto")).toBe("Face Enhancer · Auto");
    expect(actionLabel("make_3d")).toBe(toolTitle("action:make_3d"));
  });

  it("legacy stored tool labels map to the canonical name", () => {
    for (const t of REGISTRY) {
      const title = catalogToolTitle(t.id);
      if (title) expect(toolLabel(t.id, t.label), t.id).toBe(title);
    }
    expect(toolLabel("qwen21-outpaint", "Outpaint")).toBe("Expand");
    expect(toolLabel("qwen21-head-swap", "Head swap")).toBe("Face Swap");
    // Pre-stamp rows (only tool_id) and old stamps with the old label.
    expect(runProvenance({ tool_id: "krea2-outpaint" })?.label).toBe("Expand");
    expect(
      runProvenance({
        action_provenance: {
          kind: "tool",
          id: "qwen21-head-swap",
          label: "Head swap",
        },
      })?.label,
    ).toBe("Face Swap");
  });
});

describe("quick edit reads the map", () => {
  it("mode chips use canonical tool names", () => {
    const label = (id: string) =>
      QUICK_EDIT_MODES.find((m) => m.id === id)?.label;
    expect(label("inpaint")).toBe(toolTitle("catalog:krea2-inpaint"));
    expect(label("erase")).toBe(toolTitle("action:remove_object"));
    expect(label("expand")).toBe(toolTitle(EXPAND_KEY));
    expect(label("upscale")).toBe(toolTitle("action:upscale"));
  });

  it("Object Remover submits as Remove, not Erase", () => {
    const erase = QUICK_EDIT_MODES.find((m) => m.id === "erase");
    expect(erase?.label).toBe("Object Remover");
    expect(erase?.action).toBe("Remove");
  });
});

describe("inpaint / erase naming", () => {
  // "Inpaint" = paint a mask + say what goes there; "... Remover" = erase
  // and rebuild what was behind. Every surface uses these names.
  it("Tools cards, docs and the editor agree", () => {
    const label = (id: string) => REGISTRY.find((t) => t.id === id)?.label;
    expect(toolTitle("catalog:krea2-inpaint")).toBe("Inpaint");
    expect(toolTitle("catalog:krea2-anypaint")).toBe("Inpaint + Expand");
    expect(label("krea2-anypaint")).toBe("Inpaint + Expand");
    expect(label("qwen21-remove-box")).toBe("Object Remover (box)");
    expect(label("qwen2511-remove")).toBe("Object Remover (text)");
    const title = (id: string) => ACTION_TOOLS.find((s) => s.id === id)?.title;
    expect(title("remove_object")).toBe(toolTitle("action:remove_object"));
    expect(title("video_object_remove")).toBe(
      toolTitle("action:video_object_remove"),
    );
    expect(title("person_remove")).toBe(toolTitle("action:person_remove"));
    expect(title("video_remove_text")).toBe(
      toolTitle("action:video_remove_text"),
    );
    expect(editLoraFamilies.krea2inpaint.label).toBe("Inpaint");
    expect(EDIT_MODES.remove.label).toBe(toolTitle("action:remove_object"));
  });

  it("old names still find the cards", () => {
    const finds = (q: string, key: string) =>
      filterHubCards(HUB, q).some((c) => c.key === key);
    expect(finds("AnyPaint", "catalog:krea2-anypaint")).toBe(true);
    expect(finds("Inpaint Edit", "catalog:krea2-inpaint")).toBe(true);
    expect(finds("generative fill", "catalog:krea2-inpaint")).toBe(true);
    expect(finds("Remove object", "action:remove_object")).toBe(true);
    expect(finds("eraser", "action:remove_object")).toBe(true);
    expect(finds("Remove text from video", "action:video_remove_text")).toBe(
      true,
    );
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INLINE_GROUPS,
  INLINE_TOOLS,
  buildLightboxTools,
  filterLightboxTools,
  groupLightboxTools,
  lightboxMediaKind,
  type LightboxTool,
} from "@/lib/ui/lightboxTools";
import { ACTION_TOOLS, type CatalogTool } from "@/lib/tools/toolsPage";
import type { GalleryImage } from "@/types";

const item = (patch: Partial<GalleryImage> = {}): GalleryImage =>
  ({
    id: "img-1",
    url: "/api/comfy/view?filename=a.png",
    prompt: "a lighthouse at dusk",
    runId: "run-1",
    jobIndex: 0,
    width: 1024,
    height: 1024,
    ...patch,
  }) as GalleryImage;

const ALL = buildLightboxTools();
const keys = (tools: LightboxTool[]) => tools.map((t) => t.key);
const inlineActions = (tools: LightboxTool[]) =>
  tools.flatMap((t) =>
    t.target.kind === "inline"
      ? t.target.variants.flatMap((v) =>
          v.run.kind === "action" ? [v.run.action] : [],
        )
      : [],
  );

describe("lightboxMediaKind", () => {
  it("classifies the open item", () => {
    expect(lightboxMediaKind(item())).toBe("image");
    expect(lightboxMediaKind(item({ videoUrl: "/v.mp4" }))).toBe("video");
    expect(lightboxMediaKind(item({ audioUrl: "/a.mp3" }))).toBe("audio");
    expect(lightboxMediaKind(item({ meshUrl: "/m.glb" }))).toBe("mesh");
  });
});

describe("lightbox Tools catalog", () => {
  it("keeps every action the old lightbox rows fired as an inline tool", () => {
    const actions = inlineActions(INLINE_TOOLS);
    for (const a of [
      "zoom_out_1_5x",
      "zoom_out_2x",
      "pan_left",
      "pan_up",
      "pan_down",
      "pan_right",
      "detail",
      "upscale_detail",
      "adetailer",
      "adetailer_auto",
      "realism_lite",
      "realism_pro",
    ]) {
      expect(actions).toContain(a);
    }
    const runs = INLINE_TOOLS.flatMap((t) =>
      t.target.kind === "inline" ? t.target.variants.map((v) => v.run) : [],
    );
    expect(runs).toContainEqual({ kind: "remix", variant: "subtle" });
    expect(runs).toContainEqual({ kind: "remix", variant: "strong" });
    expect(runs).toContainEqual({ kind: "prompt_seed" });
    expect(runs).toContainEqual({ kind: "use_start_frame" });
  });

  it("has unique keys and lists Tools-page cards as open targets", () => {
    expect(new Set(keys(ALL)).size).toBe(ALL.length);
    const open = ALL.filter((t) => t.target.kind === "open");
    expect(open.length).toBeGreaterThan(10);
    for (const t of open) {
      expect(t.target.kind === "open" && t.target.toolKey).toBe(t.key);
      expect(t.localOnly).toBe(false);
    }
    // Template and app runners take the hand-off too.
    expect(open.some((t) => t.key.startsWith("template:"))).toBe(true);
    expect(open.some((t) => t.key.startsWith("app:"))).toBe(true);
  });

  it("only lists action tools whose runner takes an image, clip or audio", () => {
    for (const spec of ACTION_TOOLS) {
      const entry = ALL.find((t) => t.key === `action:${spec.id}`);
      if (spec.noSourceInput) {
        if (spec.audioHandoff) expect(entry?.media, spec.id).toEqual(["audio"]);
        else expect(entry, spec.id).toBeUndefined();
        continue;
      }
      if (!entry) continue; // folded into a hub variant card
      expect(entry.media, spec.id).toEqual(
        spec.videoInput ? ["video"] : ["image"],
      );
    }
  });
});

describe("filterLightboxTools", () => {
  it("filters by media kind", () => {
    const images = filterLightboxTools(ALL, {
      media: "image",
      external: false,
      query: "",
    });
    const videos = filterLightboxTools(ALL, {
      media: "video",
      external: false,
      query: "",
    });
    expect(images.every((t) => t.media.includes("image"))).toBe(true);
    expect(videos.every((t) => t.media.includes("video"))).toBe(true);
    expect(keys(images)).toContain("inline:zoom");
    // Inline video rows are Video Expand only (zoom / pan on the open clip).
    expect(
      keys(videos.filter((t) => t.target.kind === "inline")).sort(),
    ).toEqual(["inline:vpan", "inline:vzoom"]);
    expect(keys(images)).not.toContain("inline:vzoom");
    const videoIn = ACTION_TOOLS.filter((s) => s.videoInput).map(
      (s) => `action:${s.id}`,
    );
    expect(keys(videos).some((k) => videoIn.includes(k))).toBe(true);
  });

  it("lists only the audio-in tools for audio, nothing for 3D", () => {
    const audio = filterLightboxTools(ALL, {
      media: "audio",
      external: false,
      query: "",
    });
    expect(keys(audio).sort()).toEqual([
      "action:sa3_a2a",
      "action:sa3_extend",
      "action:sa3_inpaint",
    ]);
    expect(
      filterLightboxTools(ALL, { media: "mesh", external: false, query: "" }),
    ).toEqual([]);
  });

  it("hides local-run actions for external images", () => {
    const ext = filterLightboxTools(ALL, {
      media: "image",
      external: true,
      query: "",
    });
    expect(ext.some((t) => t.localOnly)).toBe(false);
    expect(ext.some((t) => t.target.kind === "open")).toBe(true);
  });

  it("matches every search word across title, aliases and variant labels", () => {
    const f = (query: string) =>
      keys(
        filterLightboxTools(ALL, { media: "image", external: false, query }),
      );
    expect(f("pan")).toContain("inline:pan");
    expect(f("outpaint")).toEqual(
      expect.arrayContaining(["inline:zoom", "inline:pan"]),
    );
    expect(f("ADETAILER")).toContain("inline:adetailer");
    expect(f("auto refine")).toContain("inline:adetailer");
    expect(f("realism+")).toContain("inline:realism");
    expect(f("start frame")).toContain("inline:reuse");
    expect(f("zzzz-no-such-tool")).toEqual([]);
    expect(f("  ")).toHaveLength(
      filterLightboxTools(ALL, { media: "image", external: false, query: "" })
        .length,
    );
  });
});

describe("groupLightboxTools", () => {
  it("puts inline groups first in fixed order, then Tools-page sections", () => {
    const groups = groupLightboxTools(
      filterLightboxTools(ALL, { media: "image", external: false, query: "" }),
    ).map((g) => g.group);
    expect(groups.slice(0, INLINE_GROUPS.length)).toEqual([...INLINE_GROUPS]);
    expect(new Set(groups).size).toBe(groups.length);
    expect(groups.length).toBeGreaterThan(INLINE_GROUPS.length);
  });

  it("keeps input order within a group and drops empty groups", () => {
    const grouped = groupLightboxTools(
      filterLightboxTools(ALL, {
        media: "image",
        external: false,
        query: "pan left",
      }),
    );
    const reframe = grouped.find((g) => g.group === "Reframe");
    expect(reframe?.tools.map((t) => t.key)).toEqual(["inline:pan"]);
    expect(grouped.some((g) => g.tools.length === 0)).toBe(false);
    const zoomFirst = groupLightboxTools(INLINE_TOOLS.slice(0, 2));
    expect(zoomFirst[0].tools.map((t) => t.key)).toEqual([
      "inline:zoom",
      "inline:pan",
    ]);
  });
});

describe("Lightbox Tools wiring", () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  const lightbox = src("src/components/Lightbox.tsx");

  it("T toggles the panel and Escape closes it before the lightbox", () => {
    expect(lightbox).toMatch(/case "tools":\s*setShowTools\(\(v\) => !v\);/);
    const escTools = lightbox.indexOf('if (showTools && e.key === "Escape")');
    const typingCheck = lightbox.indexOf("const intent = lightboxKeyIntent(");
    const switchEsc = lightbox.indexOf('case "close":');
    expect(escTools).toBeGreaterThan(-1);
    // Before the typing guard (works from the search field) and the close.
    expect(escTools).toBeLessThan(typingCheck);
    expect(escTools).toBeLessThan(switchEsc);
    // Quick edit keeps its E key.
    expect(lightbox).toMatch(/case "quick-edit":\s*openQuickEdit\(\);/);
  });

  it("opens other tools on the Tools page with the item handed off", () => {
    expect(lightbox).toContain("handoffFromGalleryItem(currentImage, toolKey");
    expect(lightbox).toContain("openToolFromLauncher(toolKey, false)");
    expect(lightbox).toContain('navigateTo("tools")');
  });

  it("documents T in keyboard help", () => {
    expect(src("src/components/KeyboardHelp.tsx")).toMatch(
      /keys: \["T"\], description: "Tools panel/,
    );
  });
});

describe("catalog tools in the panel", () => {
  const cat = (over: Partial<CatalogTool>): CatalogTool =>
    ({
      id: "krea2-inpaint",
      label: "Inpaint",
      category: "Edit",
      base: "krea2",
      baseLabel: "Krea 2",
      description: "Repaint a masked area",
      loras: [],
      extras: { keepFraming: null },
      speed: { supported: false },
      defaults: { steps: 20, cfg: 4 },
      refCount: 1,
      refLabels: ["Image"],
      needsMask: true,
      outpaint: null,
      promptMode: "required",
      promptTemplate: "",
      promptHint: "",
      options: [],
      requiresNodes: null,
      license: { name: "Apache-2.0", commercial: true, note: "" },
      sourceUrl: "",
      installed: true,
      packAvailable: true,
      available: true,
      ...over,
    }) as CatalogTool;
  const search = (tools: LightboxTool[], query: string, media: "image" | "video" = "image") =>
    filterLightboxTools(tools, { media, external: false, query });

  it("are absent until the live catalog loads", () => {
    expect(keys(ALL).some((k) => k.startsWith("catalog:"))).toBe(false);
  });

  it("installed catalog tools become searchable image tools that open on the Tools page", () => {
    const tools = buildLightboxTools([cat({})]);
    const hit = search(tools, "inpaint").find((t) => t.key === "catalog:krea2-inpaint");
    expect(hit).toBeDefined();
    expect(hit!.target).toEqual({ kind: "open", toolKey: "catalog:krea2-inpaint" });
    expect(search(tools, "inpaint", "video").some((t) => t.key.startsWith("catalog:"))).toBe(false);
  });

  it("uninstalled catalog tools stay out (no dead ends)", () => {
    const tools = buildLightboxTools([cat({ available: false, installed: false })]);
    expect(keys(tools)).not.toContain("catalog:krea2-inpaint");
  });
});

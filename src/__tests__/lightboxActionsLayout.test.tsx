/**
 * Lightbox creator actions, rendered to static markup (no DOM library in
 * devDeps): capped quick row, grouped submenus, per-submenu show/hide + pin
 * with reset, Customize, hidden actions handed to Tools, phone touch targets.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CreatorActionsCustomize,
  LightboxActions,
  type LightboxActionsProps,
} from "@/components/LightboxActions";
import type { LightboxTool } from "@/lib/ui/lightboxTools";
import {
  selectCreatorActionPrefs,
  useCreatorActionsStore,
} from "@/store/creatorActionsStore";

const noop = () => {};

// Static rendering reads the store's server snapshot (its initial state
// object), so copy the live prefs onto it before each render.
function syncServerSnapshot() {
  Object.assign(
    useCreatorActionsStore.getInitialState(),
    selectCreatorActionPrefs(useCreatorActionsStore.getState()),
  );
}

function render(over: Partial<LightboxActionsProps> = {}) {
  let toolsSeen: LightboxTool[] | null = null;
  const props: LightboxActionsProps = {
    media: "image",
    external: false,
    hasImageUrl: true,
    canQuickEdit: true,
    quickEditOpen: false,
    canRetake: true,
    isRunning: () => false,
    onRun: noop,
    onOpenTool: noop,
    rerunSheetOpen: false,
    rerunSheet: null,
    openGroup: null,
    onOpenGroup: noop,
    groupEditing: false,
    onGroupEditing: noop,
    customizeOpen: false,
    onToggleCustomize: noop,
    toolsOpen: false,
    onToggleTools: noop,
    renderToolsPanel: (tools) => {
      toolsSeen = tools;
      return createElement("div", { "data-tools-panel": "" });
    },
    ...over,
  };
  syncServerSnapshot();
  const html = renderToStaticMarkup(createElement(LightboxActions, props));
  return { html, toolsSeen: toolsSeen as LightboxTool[] | null };
}

const quick = (html: string) => {
  const row = html.match(/data-creator-quick[^>]*>([\s\S]*?)<\/div>/)?.[1];
  return [...(row ?? "").matchAll(/data-creator-action="([^"]+)"/g)].map(
    (m) => m[1],
  );
};
const groupRows = (html: string) =>
  [...html.matchAll(/data-creator-group="([^"]+)"/g)].map((m) => m[1]);
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);

describe("LightboxActions default layout", () => {
  beforeEach(() => useCreatorActionsStore.getState().reset());

  it("image: four quick actions over six closed groups", () => {
    const { html } = render();
    expect(html).toContain('aria-label="Creator actions"');
    expect(quick(html)).toEqual([
      "vary_subtle",
      "upscale_faithful",
      "quick_edit",
      "animate_low",
    ]);
    expect(groupRows(html)).toEqual([
      "vary",
      "edit",
      "upscale",
      "animate",
      "layers",
      "use",
    ]);
    expect(html).not.toContain('role="group" aria-label="Vary actions"');
    expect(html).toMatch(
      /aria-expanded="false" aria-label="Upscale &amp; enhance"/,
    );
    // Closed rows summarise what's inside.
    expect(html).toContain("Subtle · Strong · Rerun · Rerun with tweaks…");
  });

  it("no wall of buttons: closed layout has at most quick + groups + chrome", () => {
    const { html } = render();
    // 4 quick + 6 groups + All tools + Customize gear.
    expect(buttons(html)).toHaveLength(12);
  });

  it("video: Upscale + Editor quick, no image-only groups", () => {
    const { html } = render({ media: "video" });
    expect(quick(html)).toEqual(["upscale_clip", "video_editor"]);
    expect(groupRows(html)).toEqual(["vary", "edit", "upscale", "use"]);
    expect(html).toContain('aria-label="Upscale video"');
    expect(html).not.toContain("Quick edit");
  });

  it("keeps shortcuts in tooltips and kbd hints", () => {
    const { html } = render();
    expect(html).toContain('aria-keyshortcuts="E"');
    expect(html).toContain("(E)");
    expect(html).toContain('aria-keyshortcuts="T"');
    expect(html).toContain('title="All tools for this item (T)"');
    expect(render({ toolsOpen: true }).html).toMatch(
      /aria-expanded="true" aria-keyshortcuts="T" aria-label="All tools"/,
    );
    expect(html).toContain('aria-label="Customize actions"');
  });

  it("disables Quick edit when it can't run and says why", () => {
    const { html } = render({ canQuickEdit: false });
    expect(html).toMatch(
      /disabled=""[^>]*aria-label="Quick edit"[^>]*title="Quick edit works on still images"/,
    );
  });
});

describe("group submenus", () => {
  beforeEach(() => useCreatorActionsStore.getState().reset());

  it("an open group lists its actions with icon + label rows", () => {
    const { html } = render({ openGroup: "edit" });
    expect(html).toMatch(
      /aria-expanded="true" aria-controls="creator-group-edit"/,
    );
    expect(html).toContain('role="group" aria-label="Edit actions"');
    expect(html).toContain('aria-label="Open in the image editor"');
    expect(html).toContain('aria-label="Show or hide Edit actions"');
    expect(html).not.toContain("data-creator-group-editor");
  });

  it("3D & layers and Vary rows carry their full names", () => {
    expect(render({ openGroup: "layers" }).html).toMatch(
      /aria-label="Open [^"]+ with this image"/,
    );
    const vary = render({ openGroup: "vary" }).html;
    expect(vary).toContain('aria-label="Vary strong"');
    expect(vary).toContain('aria-label="Rerun with parameters"');
  });

  it("Show or hide mode: a checkbox and pin per action, reset, done", () => {
    useCreatorActionsStore.getState().setActionHidden("vary_strong", true);
    const { html } = render({ openGroup: "vary", groupEditing: true });
    expect(html).toContain('data-creator-group-editor="vary"');
    for (const name of [
      "Vary subtle",
      "Vary strong",
      "Rerun",
      "Rerun with parameters",
    ]) {
      expect(html).toContain(`aria-label="Show ${name}"`);
      expect(html).toContain(`aria-label="Pin ${name} to the quick row"`);
    }
    expect(html).toMatch(/aria-label="Show Vary strong"[^>]*\/>/);
    expect(html).not.toMatch(/aria-label="Show Vary strong"[^>]*checked=""/);
    expect(html).toMatch(/aria-label="Show Vary subtle"[^>]*checked=""/);
    expect(html).toMatch(
      /aria-pressed="true" aria-label="Pin Vary subtle to the quick row"/,
    );
    // Quick row is full (4), so unpinned actions can't be pinned.
    expect(html).toMatch(
      /disabled="" aria-pressed="false" aria-label="Pin Rerun to the quick row" title="Quick row is full/,
    );
    expect(html).toContain('aria-label="Reset Vary to defaults"');
    expect(html).toContain("Reset to defaults");
    expect(html).toContain('aria-label="Done editing Vary"');
  });

  it("the open group counts its hidden actions", () => {
    const s = useCreatorActionsStore.getState();
    s.setActionHidden("fix_faces", true);
    s.setActionHidden("detail", true);
    const { html } = render({ openGroup: "upscale" });
    expect(html).not.toContain('aria-label="Fix faces (ADetailer)"');
    expect(html).toContain("2 hidden");
  });
});

describe("hidden actions", () => {
  beforeEach(() => useCreatorActionsStore.getState().reset());

  it("leave the quick row and groups and reach the Tools panel", () => {
    const s = useCreatorActionsStore.getState();
    s.setActionHidden("vary_subtle", true);
    s.setGroupHidden("use", true);
    const { html, toolsSeen } = render({ toolsOpen: true });
    expect(quick(html)).toEqual([
      "upscale_faithful",
      "quick_edit",
      "animate_low",
    ]);
    expect(groupRows(html)).not.toContain("use");
    expect(html).toContain("5 hidden");
    expect(html).toContain("data-tools-panel");
    expect(toolsSeen?.map((t) => t.key)).toEqual([
      "creator:vary",
      "creator:use",
    ]);
  });
});

describe("touch targets and labels", () => {
  beforeEach(() => useCreatorActionsStore.getState().reset());

  it("every button is ≥40px on phones and has a title + aria-label", () => {
    const html = [
      render({ openGroup: "upscale" }).html,
      render({ openGroup: "animate", groupEditing: true }).html,
      render({ customizeOpen: true }).html,
    ].join("");
    const all = buttons(html).filter((b) => !b.includes("upscale-model"));
    expect(all.length).toBeGreaterThan(30);
    for (const b of all) {
      if (b.includes("data-creator-action") && b.includes("h-14")) continue;
      expect(b, b).toMatch(/\bh-10\b|\bmin-h-10\b|\bh-14\b/);
      expect(b, b).toMatch(/title="[^"]+"/);
      expect(b, b).toMatch(/aria-label="[^"]+"/);
    }
  });
});

describe("Customize panel", () => {
  beforeEach(() => useCreatorActionsStore.getState().reset());

  it("orders the quick row, shows and orders groups, resets all", () => {
    syncServerSnapshot();
    const html = renderToStaticMarkup(
      createElement(CreatorActionsCustomize, {
        ctx: { media: "image", external: false },
        onDone: noop,
      }),
    );
    for (const name of [
      "Vary subtle",
      "Upscale faithful",
      "Quick edit",
      "Animate low motion",
    ]) {
      expect(html).toContain(`aria-label="Move ${name} earlier"`);
      expect(html).toContain(`aria-label="Unpin ${name}"`);
    }
    for (const label of [
      "Vary",
      "Edit",
      "Upscale &amp; enhance",
      "Animate",
      "3D &amp; layers",
      "Use &amp; recipe",
    ]) {
      expect(html).toContain(`aria-label="Show ${label}"`);
      expect(html).toContain(`aria-label="Move ${label} up"`);
    }
    expect(html).toContain('aria-label="Reset actions to default"');
  });

  it("video ctx lists only the video pins", () => {
    syncServerSnapshot();
    const html = renderToStaticMarkup(
      createElement(CreatorActionsCustomize, {
        ctx: { media: "video", external: false },
        onDone: noop,
      }),
    );
    expect(
      [...html.matchAll(/data-customize-pin="([^"]+)"/g)].map((m) => m[1]),
    ).toEqual(["upscale_clip", "video_editor"]);
  });

  it("renders inside the action area when open", () => {
    expect(render({ customizeOpen: true }).html).toContain(
      'id="lightbox-customize-actions"',
    );
  });
});

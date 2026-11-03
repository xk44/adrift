/**
 * Lightbox creator actions (lib/ui/creatorActions.ts): grouping, the capped
 * quick row, per-action/group prefs, and the store behind them
 * (adrift.creator-actions).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STORAGE_KEYS } from "@/lib/storageKeys";
import * as lucide from "lucide-react";
import { CREATOR_ICONS, creatorIcon } from "@/components/creatorActionIcons";
import {
  CREATOR_ACTIONS,
  CREATOR_ACTION_IDS,
  CREATOR_GROUPS,
  CREATOR_GROUP_IDS,
  DEFAULT_CREATOR_ACTION_PREFS,
  HIDDEN_ACTIONS_GROUP,
  QUICK_ROW_MAX,
  canPin,
  isPinnedShown,
  DEFAULT_PINNED,
  creatorActionLayout,
  defaultCreatorActionPrefs,
  groupActionIds,
  hiddenActionTools,
  moveGroup,
  movePinned,
  normalizeCreatorActionPrefs,
  resetGroupPrefs,
  withPinned,
  type CreatorActionContext,
  type CreatorActionPrefs,
} from "@/lib/ui/creatorActions";
import {
  filterLightboxTools,
  groupLightboxTools,
  type LightboxTool,
} from "@/lib/ui/lightboxTools";
import {
  selectCreatorActionPrefs,
  selectCreatorActionShown,
  useCreatorActionsStore,
} from "@/store/creatorActionsStore";

const KEY = STORAGE_KEYS.creatorActions;
const prefs = (over: Partial<CreatorActionPrefs> = {}): CreatorActionPrefs => ({
  ...defaultCreatorActionPrefs(),
  ...over,
});
const IMAGE: CreatorActionContext = { media: "image", external: false };
const VIDEO: CreatorActionContext = { media: "video", external: false };
const groupsOf = (p: CreatorActionPrefs, ctx: CreatorActionContext) =>
  creatorActionLayout(p, ctx).groups.map((g) => g.id);

describe("catalog", () => {
  it("every action belongs to one of six labelled groups", () => {
    expect(CREATOR_GROUPS.map((g) => g.label)).toEqual([
      "Vary",
      "Edit",
      "Upscale & enhance",
      "Animate",
      "3D & layers",
      "Use & recipe",
    ]);
    for (const a of CREATOR_ACTIONS) {
      expect(CREATOR_GROUP_IDS).toContain(a.group);
    }
    expect(new Set(CREATOR_ACTION_IDS).size).toBe(CREATOR_ACTIONS.length);
  });

  it("accessible names are unique", () => {
    const names = CREATOR_ACTIONS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("names lucide icons the lightbox, gallery and Tools panel render", () => {
    const lib = lucide as unknown as Record<string, unknown>;
    for (const a of CREATOR_ACTIONS) {
      expect(CREATOR_ICONS[a.icon], a.icon).toBeDefined();
      expect(lib[a.icon]).toBe(CREATOR_ICONS[a.icon]);
      expect(creatorIcon(a.icon)).toBe(CREATOR_ICONS[a.icon]);
    }
    for (const g of CREATOR_GROUPS) {
      expect(CREATOR_ICONS[g.icon], g.icon).toBeDefined();
    }
  });
});

describe("creatorActionLayout", () => {
  it("image: four quick actions, five groups, nothing hidden", () => {
    const layout = creatorActionLayout(prefs(), IMAGE);
    expect(layout.quick).toEqual([
      "vary_subtle",
      "upscale_faithful",
      "quick_edit",
      "animate_low",
    ]);
    expect(layout.groups.map((g) => g.id)).toEqual([...CREATOR_GROUP_IDS]);
    expect(layout.hidden).toEqual([]);
    const edit = layout.groups.find((g) => g.id === "edit");
    expect(edit?.actions).toEqual(["quick_edit", "open_editor"]);
  });

  it("video: upscale + editor quick, no image-only groups", () => {
    const layout = creatorActionLayout(prefs(), VIDEO);
    expect(layout.quick).toEqual(["upscale_clip", "video_editor"]);
    expect(layout.groups.map((g) => g.id)).toEqual([
      "vary",
      "edit",
      "upscale",
      "use",
    ]);
    expect(layout.groups.find((g) => g.id === "edit")?.actions).toEqual([
      "video_editor",
      "retake",
    ]);
    expect(
      creatorActionLayout(prefs(), { ...VIDEO, canRetake: false }).groups.find(
        (g) => g.id === "edit",
      )?.actions,
    ).toEqual(["video_editor"]);
  });

  it("external images keep only non-generation actions", () => {
    const layout = creatorActionLayout(prefs(), {
      media: "image",
      external: true,
    });
    expect(layout.quick).toEqual([]);
    expect(layout.groups.map((g) => g.id)).toEqual(["layers", "use"]);
    expect(layout.groups.find((g) => g.id === "use")?.actions).toEqual([
      "use_image",
      "use_style",
      "use_prompt",
    ]);
  });

  it("caps the quick row however many are pinned", () => {
    const all = prefs({ pinned: [...CREATOR_ACTION_IDS] });
    expect(creatorActionLayout(all, IMAGE).quick).toHaveLength(QUICK_ROW_MAX);
    expect(canPin(all, "detail", IMAGE)).toBe(true); // already pinned
    const full = prefs();
    expect(canPin(full, "detail", IMAGE)).toBe(false);
    expect(canPin(full, "vary_subtle", IMAGE)).toBe(true);
    // Image pins don't count against video's row.
    expect(canPin(full, "retake", VIDEO)).toBe(true);
  });

  it("a pinned but hidden action is not counted as pinned", () => {
    const p = prefs({ hidden: ["vary_subtle"] });
    expect(isPinnedShown(p, "vary_subtle")).toBe(false);
    expect(isPinnedShown(p, "upscale_faithful")).toBe(true);
    const full = prefs({
      hidden: ["vary_subtle"],
      pinned: [...DEFAULT_PINNED, "detail"],
    });
    expect(creatorActionLayout(full, IMAGE).quick).toHaveLength(QUICK_ROW_MAX);
    expect(canPin(full, "vary_subtle", IMAGE)).toBe(false);
  });

  it("hidden actions leave their group and the quick row; hidden groups vanish", () => {
    const p = prefs({ hidden: ["vary_subtle", "detail"] });
    const layout = creatorActionLayout(p, IMAGE);
    expect(layout.quick).toEqual([
      "upscale_faithful",
      "quick_edit",
      "animate_low",
    ]);
    const vary = layout.groups.find((g) => g.id === "vary")!;
    expect(vary.actions).not.toContain("vary_subtle");
    expect(vary.hidden).toEqual(["vary_subtle"]);
    expect(layout.hidden).toEqual(["vary_subtle", "detail"]);

    const noAnimate = creatorActionLayout(
      prefs({ hiddenGroups: ["animate"] }),
      IMAGE,
    );
    expect(noAnimate.groups.map((g) => g.id)).not.toContain("animate");
    expect(noAnimate.quick).not.toContain("animate_low");
    expect(noAnimate.hidden).toEqual(groupActionIds("animate"));
  });

  it("a group with every action hidden stays listed so it can be re-shown", () => {
    const p = prefs({ hidden: groupActionIds("layers") });
    const layers = creatorActionLayout(p, IMAGE).groups.find(
      (g) => g.id === "layers",
    );
    expect(layers).toEqual({
      id: "layers",
      actions: [],
      hidden: ["make_3d", "layer_split"],
    });
  });
});

describe("pins and ordering", () => {
  it("pins append once and unpin removes", () => {
    const p = prefs();
    expect(withPinned(p, "detail", true)).toEqual([...p.pinned, "detail"]);
    expect(withPinned(p, "vary_subtle", true)).toBe(p.pinned);
    expect(withPinned(p, "vary_subtle", false)).not.toContain("vary_subtle");
  });

  it("moves pins among those that apply to the open item", () => {
    const p = prefs();
    expect(movePinned(p, "upscale_faithful", -1).slice(0, 2)).toEqual([
      "upscale_faithful",
      "vary_subtle",
    ]);
    expect(movePinned(p, "vary_subtle", -1)).toBe(p.pinned);
    // On video, Editor's left neighbour is Upscale clip, not Animate.
    const moved = movePinned(p, "video_editor", -1, VIDEO);
    expect(creatorActionLayout({ ...p, pinned: moved }, VIDEO).quick).toEqual([
      "video_editor",
      "upscale_clip",
    ]);
    expect(creatorActionLayout({ ...p, pinned: moved }, IMAGE).quick).toEqual(
      creatorActionLayout(p, IMAGE).quick,
    );
  });

  it("moves groups; edges are no-ops", () => {
    const p = prefs();
    expect(moveGroup(p, "edit", -1).slice(0, 2)).toEqual(["edit", "vary"]);
    expect(moveGroup(p, "vary", -1)).toBe(p.groupOrder);
    expect(moveGroup(p, "use", 1)).toBe(p.groupOrder);
    expect(
      groupsOf({ ...p, groupOrder: moveGroup(p, "use", -1) }, IMAGE),
    ).toEqual(["vary", "edit", "upscale", "animate", "use", "layers"]);
  });

  it("resetting one group leaves the others alone", () => {
    const p = prefs({
      pinned: ["upscale_faithful", "detail", "animate_low"],
      hidden: ["vary_strong", "fix_faces", "use_style"],
      hiddenGroups: ["vary", "use"],
    });
    const r = resetGroupPrefs(p, "vary");
    expect(r.pinned).toEqual([
      "vary_subtle",
      "upscale_faithful",
      "detail",
      "animate_low",
    ]);
    expect(r.hidden).toEqual(["fix_faces", "use_style"]);
    expect(r.hiddenGroups).toEqual(["use"]);
    const u = resetGroupPrefs(p, "upscale");
    expect(u.pinned).toEqual([
      "upscale_faithful",
      "animate_low",
      "upscale_clip",
    ]);
    expect(u.hidden).toEqual(["vary_strong", "use_style"]);
  });
});

describe("normalizeCreatorActionPrefs", () => {
  it("defaults for nothing stored", () => {
    expect(normalizeCreatorActionPrefs(null)).toEqual(
      DEFAULT_CREATOR_ACTION_PREFS,
    );
    expect(normalizeCreatorActionPrefs("junk")).toEqual(
      DEFAULT_CREATOR_ACTION_PREFS,
    );
  });

  it("drops unknown ids and dupes, re-adds missing groups in place", () => {
    const n = normalizeCreatorActionPrefs({
      pinned: ["detail", "bogus", "detail"],
      hidden: ["rerun", "zzz", "rerun"],
      groupOrder: ["use", "vary", "nope", "animate"],
      hiddenGroups: ["layers", "x"],
    });
    expect(n.pinned).toEqual(["detail"]);
    expect(n.hidden).toEqual(["rerun"]);
    expect(n.groupOrder).toEqual([
      "use",
      "vary",
      "edit",
      "upscale",
      "animate",
      "layers",
    ]);
    expect(n.hiddenGroups).toEqual(["layers"]);
    // An explicit empty pin list is kept (quick row off).
    expect(normalizeCreatorActionPrefs({ pinned: [] }).pinned).toEqual([]);
  });

  it("maps v1 row prefs onto the actions those rows held", () => {
    const n = normalizeCreatorActionPrefs({
      order: [
        "vary",
        "upscale",
        "edit",
        "animate",
        "rerun",
        "use",
        "reproduce",
      ],
      hidden: ["edit"],
      sections: {},
      hiddenSections: ["more"],
      moreOpen: true,
    });
    expect(n.hidden).toEqual([
      "quick_edit",
      "open_editor",
      "video_editor",
      "retake",
      "rerun",
      "rerun_tweak",
      "use_image",
      "use_style",
      "use_prompt",
      "reproduce",
    ]);
    expect(n.pinned).toEqual(DEFAULT_CREATOR_ACTION_PREFS.pinned);
    expect(Object.keys(n).sort()).toEqual(
      ["groupOrder", "hidden", "hiddenGroups", "pinned"].sort(),
    );
  });
});

describe("hidden-action fallback", () => {
  const find = (all: LightboxTool[], query: string) =>
    filterLightboxTools(all, { media: "image", external: false, query });

  it("one searchable Tools row per group, its hidden actions as buttons", () => {
    const all = hiddenActionTools([
      "vary_subtle",
      "vary_strong",
      "rerun",
      "detail",
    ]);
    expect(all.map((t) => t.key)).toEqual(["creator:vary", "creator:upscale"]);
    expect(find(all, "vary strong").map((t) => t.key)).toEqual([
      "creator:vary",
    ]);
    expect(find(all, "hidden")).toHaveLength(2);
    const vary = all[0];
    expect(vary.title).toBe("Vary");
    expect(
      vary.target.kind === "inline" && vary.target.variants.map((v) => v.run),
    ).toEqual([
      { kind: "action", action: "vary_subtle" },
      { kind: "action", action: "vary_strong" },
      { kind: "rerun" },
    ]);
  });

  it("loops keep their params; 3D & layers stay as their own Tools cards", () => {
    const [animate] = hiddenActionTools(["loop_low", "loop_high"]);
    expect(
      animate.target.kind === "inline" &&
        animate.target.variants.map((v) => v.run),
    ).toEqual([
      { kind: "action", action: "animate_low", params: { loop: 0 } },
      { kind: "action", action: "animate_high", params: { loop: 0 } },
    ]);
    expect(hiddenActionTools(["make_3d", "layer_split"])).toEqual([]);
  });

  it("groups them first in the Tools panel", () => {
    const other: LightboxTool = {
      key: "x",
      title: "Other",
      subtitle: "",
      group: "Refine",
      icon: "Sparkles",
      media: ["image"],
      localOnly: false,
      aliases: [],
      target: { kind: "inline", variants: [] },
    };
    expect(
      groupLightboxTools([other, ...hiddenActionTools(["vary_subtle"])])[0]
        .group,
    ).toBe(HIDDEN_ACTIONS_GROUP);
  });
});

describe("creatorActionsStore", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY);
    useCreatorActionsStore.getState().reset();
  });
  const prefsNow = () =>
    selectCreatorActionPrefs(useCreatorActionsStore.getState());

  it("uses an adrift.* key", () => {
    expect(KEY).toBe("adrift.creator-actions");
  });

  it("toggles actions and groups idempotently", () => {
    const s = useCreatorActionsStore.getState();
    s.setActionHidden("vary_strong", true);
    s.setActionHidden("vary_strong", true);
    expect(prefsNow().hidden).toEqual(["vary_strong"]);
    s.setGroupHidden("use", true);
    const shown = selectCreatorActionShown(useCreatorActionsStore.getState());
    expect(shown.vary_strong).toBe(false);
    expect(shown.vary_subtle).toBe(true);
    expect(shown.use_image).toBe(false);
    expect(shown.reproduce).toBe(false);
    s.setActionHidden("vary_strong", false);
    s.setGroupHidden("use", false);
    expect(
      Object.values(
        selectCreatorActionShown(useCreatorActionsStore.getState()),
      ).every(Boolean),
    ).toBe(true);
  });

  it("pins, moves, resets one group, resets all", () => {
    const s = useCreatorActionsStore.getState();
    s.setPinned("vary_subtle", false);
    s.setPinned("detail", true);
    s.movePinned("detail", -1);
    s.moveGroup("use", -1);
    s.setActionHidden("loop_high", true);
    s.setActionHidden("fix_faces", true);
    expect(prefsNow().pinned.slice(-2)).toEqual(["detail", "video_editor"]);
    s.resetGroup("vary");
    expect(prefsNow().pinned[0]).toBe("vary_subtle");
    s.resetGroup("animate");
    expect(prefsNow().hidden).toEqual(["fix_faces"]);
    s.reset();
    expect(prefsNow()).toEqual(DEFAULT_CREATOR_ACTION_PREFS);
  });

  it("persists prefs only and rehydrates v1 data normalized", async () => {
    useCreatorActionsStore.getState().setActionHidden("upscale_creative", true);
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    expect(stored.version).toBe(2);
    expect(stored.state.hidden).toEqual(["upscale_creative"]);
    expect(Object.keys(stored.state).sort()).toEqual(
      ["groupOrder", "hidden", "hiddenGroups", "pinned"].sort(),
    );

    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: { order: [], hidden: ["vary", "zzz"], moreOpen: true },
        version: 1,
      }),
    );
    await useCreatorActionsStore.persist.rehydrate();
    const s = useCreatorActionsStore.getState();
    expect(s.hidden).toEqual(["vary_subtle", "vary_strong"]);
    expect(s.pinned).toEqual(DEFAULT_CREATOR_ACTION_PREFS.pinned);
    expect(s.groupOrder).toEqual([...CREATOR_GROUP_IDS]);
    expect(typeof s.setActionHidden).toBe("function");
  });
});

describe("gallery hover actions follow the same prefs", () => {
  const gallery = readFileSync(
    join(process.cwd(), "src/components/Gallery.tsx"),
    "utf8",
  );

  it("reads the shared shown set and icons", () => {
    expect(gallery).toContain("selectCreatorActionShown");
    expect(gallery).toContain("creatorIcon(specOf(");
    for (const id of [
      "vary_subtle",
      "vary_strong",
      "upscale_faithful",
      "use_image",
      "rerun",
      "animate_low",
    ]) {
      expect(gallery).toContain(`shownActions.${id}`);
    }
    expect(gallery).toContain(
      "RUN_MORE_ACTIONS.filter(({ id }) => shownActions[id])",
    );
  });
});

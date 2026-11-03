import { describe, it, expect } from "vitest";
import {
  readinessDetail,
  readinessLine,
  toolsReadiness,
} from "@/lib/tools/toolsReadiness";
import {
  actionAvailability,
  buildToolCards,
  getActionTool,
} from "@/lib/tools/toolsPage";
import { readyCount } from "@/lib/tools/hubVisuals";
import { buildHubCards, type HubCard } from "@/lib/tools/hub";

describe("toolsReadiness", () => {
  const cards = [
    { available: true, kind: "action" },
    { available: true, kind: "action", unverified: true },
    { available: false, kind: "action" },
    { available: true, kind: "placeholder" },
  ];

  it("counts only verified tools as ready", () => {
    const r = toolsReadiness(cards, false);
    expect(r).toEqual({ ready: 1, notChecked: 1, total: 3, offline: false });
    expect(readinessLine(r)).toBe("1 of 3 tools ready");
    expect(readinessLine({ ...r, notChecked: 0 })).toBe("1 of 3 tools ready");
  });

  it("keeps the breakdown in the tooltip, in plain words", () => {
    const r = toolsReadiness(cards, false);
    const d = readinessDetail(r);
    expect(d.split("\n")[0]).toBe("1 ready · 1 beta · 1 need setup");
    expect(d).toContain("Beta:");
    expect(readinessDetail({ ...r, notChecked: 0 })).toBe("1 ready · 2 need setup");
  });

  it("labels offline instead of showing a ready count", () => {
    expect(readinessLine(toolsReadiness(cards, true))).toBe(
      "Server offline, can't check models · 3 tools",
    );
  });
});

describe("unverified tools", () => {
  it("a spec without modelCheck is available but unverified", () => {
    const bg = getActionTool("bg_remove")!;
    expect(bg.modelCheck).toBeUndefined();
    expect(actionAvailability(bg, new Set(), null, { tools: {} })).toEqual({
      available: true,
      checking: false,
      reason: null,
      unverified: true,
    });
  });

  it("a model-checked spec with its models present is verified", () => {
    const up = getActionTool("upscale_seedvr2")!;
    const av = actionAvailability(up, new Set(), null, {
      tools: { upscale_seedvr2: { missing: [] } },
    });
    expect(av.available).toBe(true);
    expect(av.unverified).toBeUndefined();
  });

  it("hub cards carry the flag and readyCount skips them", () => {
    const toolCards = buildToolCards({
      catalog: [],
      packIds: new Set(),
      editLoras: null,
      modelStatus: { tools: { upscale_seedvr2: { missing: [] } } },
    });
    const hub = buildHubCards({
      toolCards,
      ctx: { catalog: [], packIds: new Set(), editLoras: null },
    });
    const bg = hub.find((c) => c.key === "action:bg_remove") as HubCard;
    expect(bg.unverified).toBe(true);
    const up = hub.find((c) => c.key === "action:upscale_seedvr2")!;
    expect(up.available).toBe(true);
    expect(readyCount([bg, up])).toBe(1);
  });
});

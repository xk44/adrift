import { describe, it, expect } from "vitest";
import rawApps from "@/lib/tools/appTemplates.json";
import {
  appAutoAnimates,
  compileAppPrompt,
  compileMotionPrompt,
  getApp,
  shouldAutoAnimate,
  validateAppTemplates,
} from "@/lib/tools/apps";
import { buildHubCards } from "@/lib/tools/hub";

describe("Sketch to Video (one-action sketch_to_real -> animate)", () => {
  const app = getApp("sketch_to_video")!;

  it("is a single-image app that auto-animates", () => {
    expect(app).toBeDefined();
    expect(app.inputs?.second).toBeUndefined();
    expect(app.autoAnimate).toBe(true);
    expect(appAutoAnimates(app)).toBe(true);
    // The plain two-step app stays manual.
    expect(appAutoAnimates(getApp("sketch_to_real")!)).toBe(false);
  });

  it("step 1 follows the drawing; the optional subject fills in", () => {
    expect(compileAppPrompt(app)).toContain("photograph of the scene as drawn");
    expect(compileAppPrompt(app, "a lighthouse at dusk")).toContain(
      "photograph of a lighthouse at dusk:",
    );
    expect(compileAppPrompt(app)).toMatch(/proportions closely\.$/);
    expect(compileMotionPrompt(app)).toBe(app.motion);
  });

  it("catalog validation enforces autoAnimate rules", () => {
    expect(validateAppTemplates(rawApps)).toEqual([]);
    const broken = {
      apps: [
        {
          id: "x_auto",
          name: "X",
          category: "Scenes & FX",
          description: "d",
          prompt: "Turn this picture into something else entirely, please.",
          autoAnimate: true,
        },
        {
          id: "y_auto",
          name: "Y",
          category: "Scenes & FX",
          description: "d",
          prompt: "Turn this picture into something else entirely, please.",
          motion: "slow push in",
          autoAnimate: "yes",
        },
      ],
    };
    const errs = validateAppTemplates(broken).join("\n");
    expect(errs).toMatch(/x_auto.*needs a motion prompt/);
    expect(errs).toMatch(/y_auto.*must be a boolean/);
  });

  it("auto-animates exactly once per finished step-1 run", () => {
    const s = {
      enabled: true,
      step1RunId: "R1",
      step1Done: true,
      animatedRunId: null,
    };
    expect(shouldAutoAnimate(s)).toBe(true);
    expect(shouldAutoAnimate({ ...s, animatedRunId: "R1" })).toBe(false);
    expect(shouldAutoAnimate({ ...s, step1Done: false })).toBe(false);
    expect(shouldAutoAnimate({ ...s, enabled: false })).toBe(false);
    expect(shouldAutoAnimate({ ...s, step1RunId: null })).toBe(false);
    // A re-run of step 1 animates again.
    expect(
      shouldAutoAnimate({ ...s, step1RunId: "R2", animatedRunId: "R1" }),
    ).toBe(true);
  });

  it("shows up as a Scenes & Effects hub card tagged for video", () => {
    const card = buildHubCards({
      toolCards: [],
      ctx: {
        catalog: [],
        packIds: new Set(),
        editLoras: { families: {}, loras: [] },
      },
    }).find((c) => c.key === "app:sketch_to_video")!;
    expect(card.hubCategory).toBe("Scenes");
    expect(card.aliases).toContain("video");
    expect(card.icon).toBe("Film");
  });
});

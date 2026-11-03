import { describe, it, expect } from "vitest";
import rawApps from "@/lib/tools/appTemplates.json";
import {
  APP_DEFAULT_VARIANT,
  appVariantChoices,
  compileAppPrompt,
  getApp,
  validateAppTemplates,
} from "@/lib/tools/apps";

// Trending / Ads parity apps added in the parity refresh (graph-only:
// one edit prompt + an Animate motion prompt).
const NEW_APPS = [
  "bullet_time_white",
  "bullet_time_splash",
  "yes_kiss",
  "j_magazine",
  "j_poster",
];

describe("parity refresh apps", () => {
  it("validate and are single-image edit + animate apps", () => {
    expect(validateAppTemplates(rawApps)).toEqual([]);
    for (const id of NEW_APPS) {
      const a = getApp(id);
      expect(a, id).toBeDefined();
      expect(a!.inputs?.second, id).toBeUndefined();
      expect(a!.followUp, id).toBeUndefined();
      expect(a!.prompt.length, id).toBeGreaterThanOrEqual(120);
      expect(a!.prompt.length, id).toBeLessThanOrEqual(700);
      expect(a!.prompt, id).toMatch(/[.!]$/);
      expect(a!.motion, id).toBeTruthy();
      expect(a!.motion!.length, id).toBeLessThanOrEqual(160);
      expect(compileAppPrompt(a!), id).not.toMatch(/\{\w+\}/);
    }
  });

  it("bullet-time apps animate an orbit", () => {
    for (const id of ["bullet_time_white", "bullet_time_splash"])
      expect(getApp(id)!.motion, id).toMatch(/orbit/);
  });

  it("J-Poster puts the title text in the prompt", () => {
    const p = compileAppPrompt(getApp("j_poster")!, "LAST FERRY");
    expect(p).toContain('"LAST FERRY"');
    expect(compileAppPrompt(getApp("j_poster")!)).toContain('"NIGHT TRAIN"');
  });

  it("Game Dump offers a 12-style grid that keeps the typed style", () => {
    const app = getApp("game_dump")!;
    expect(appVariantChoices(app).map((c) => c.id)).toEqual([
      APP_DEFAULT_VARIANT,
      "style_grid",
    ]);
    const grid = compileAppPrompt(app, "cozy farming sim", "style_grid");
    expect(grid).toContain("twelve in-game screenshots");
    expect(grid).toContain("a cozy farming sim,");
    // 12 genres: the typed one plus 11 fixed ones.
    const list = grid.split("graphics style: ")[1].split(". The person")[0];
    expect(list.split(/, | and /).length).toBe(12);
    // Classic stays the single-screenshot prompt.
    expect(compileAppPrompt(app, "kart racer")).toContain(
      "from a kart racer video game",
    );
  });
});

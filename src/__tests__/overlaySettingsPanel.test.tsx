import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OverlaySettingsPanel } from "@/components/OverlaySettingsPanel";

describe("OverlaySettingsPanel", () => {
  it("shows no toggles for settings nothing consumes", () => {
    const html = renderToStaticMarkup(createElement(OverlaySettingsPanel));
    expect(html).toContain("Show ComfyUI progress");
    expect(html).not.toContain("Queue via ComfyUI");
    expect(html).not.toContain("Auto-sync workflow");
    expect(html).not.toContain("ComfyUI URL");
  });
});

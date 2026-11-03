import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Tabs, nextTabIndex, tabId, tabPanelId } from "@/components/ui/Tabs";

const items = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta", badge: 3 },
  { id: "c", label: "Gamma", disabled: true },
  { id: "d", label: "Delta" },
] as const;

describe("ui/Tabs", () => {
  it("renders an ARIA tablist with one selected, focusable tab", () => {
    const html = renderToStaticMarkup(
      createElement(Tabs<string>, {
        items,
        value: "b",
        onChange: vi.fn(),
        ariaLabel: "Sections",
        idPrefix: "wf",
      }),
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Sections"');
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain(`id="${tabId("wf", "b")}"`);
    expect(html).toContain(`aria-controls="${tabPanelId("wf", "a")}"`);
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain(">3<");
  });

  it("falls back to the first tab when value is unknown", () => {
    const html = renderToStaticMarkup(
      createElement(Tabs<string>, {
        items,
        value: "zzz",
        onChange: vi.fn(),
        ariaLabel: "Sections",
      }),
    );
    expect(html.indexOf('aria-selected="true"')).toBeLessThan(
      html.indexOf("Beta"),
    );
  });

  it("arrow/Home/End keys wrap and skip disabled tabs", () => {
    const disabled = items.map((t) => "disabled" in t && !!t.disabled);
    expect(nextTabIndex("ArrowRight", 0, disabled)).toBe(1);
    expect(nextTabIndex("ArrowRight", 1, disabled)).toBe(3);
    expect(nextTabIndex("ArrowRight", 3, disabled)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, disabled)).toBe(3);
    expect(nextTabIndex("ArrowLeft", 3, disabled)).toBe(1);
    expect(nextTabIndex("Home", 3, disabled)).toBe(0);
    expect(nextTabIndex("End", 0, disabled)).toBe(3);
    expect(nextTabIndex("Enter", 0, disabled)).toBeNull();
    expect(nextTabIndex("ArrowRight", 0, [])).toBeNull();
  });
});

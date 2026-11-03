/**
 * App shell: icon-only controls with hover/focus labels, avatar-only
 * account trigger, collapsible sidebar rail. Rendered to static markup.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar } from "@/components/Sidebar";
import { PromptBar } from "@/components/PromptBar";
import { useUIStore } from "@/store";
import {
  PROMPT_OVERFLOW_LABEL_CLASS,
  PROMPT_PILL_LABEL_CLASS,
} from "@/lib/ui/promptBarLayout";

const renderSidebar = () => renderToStaticMarkup(createElement(Sidebar));
const visibleText = (html: string) =>
  html
    .replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, "")
    .replace(/<[^>]+>/g, " ");

afterEach(() => useUIStore.setState({ sidebarCollapsed: false }));

describe("sidebar shell", () => {
  it("bottom-left is an avatar-only menu trigger, no Profile or name text", () => {
    const html = renderSidebar();
    const footer = html.slice(html.indexOf('aria-label="Menu"') - 400);
    expect(html).toContain('aria-label="Menu"');
    expect(html).toContain('title="Menu"');
    expect(visibleText(footer)).not.toMatch(/\b(Profile|Account|User)\b/);
  });

  it("expanded shows labels and a collapse toggle", () => {
    const html = renderSidebar();
    expect(html).toContain('aria-label="Collapse sidebar"');
    expect(html).toContain("w-48");
    expect(html).toContain("<span>Create</span>");
  });

  it("collapse state toggles and is persisted", () => {
    useUIStore.getState().toggleSidebar();
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);
    const partialize = useUIStore.persist.getOptions().partialize!;
    expect(partialize(useUIStore.getState())).toMatchObject({
      sidebarCollapsed: true,
    });
  });

  it("collapsed rail keeps a tooltip and name on every icon", () => {
    // SSR renders the store's initial state, so check the collapsed branch
    // in source: nav items, More and the toggle all carry title + label.
    const src = readFileSync(
      join(process.cwd(), "src/components/Sidebar.tsx"),
      "utf8",
    );
    expect(src).toContain('sidebarCollapsed ? "w-14" : "w-48"');
    // Nav icons: a portalled label on hover AND keyboard focus (a native
    // title never shows on focus, and the scrolling nav would clip it).
    const nav = src.slice(src.indexOf("function NavButton"));
    expect(nav).toContain("onFocus={(e) => showTip(e.currentTarget)}");
    expect(nav).toContain("onMouseEnter={(e) => showTip(e.currentTarget)}");
    expect(nav).toContain("onBlur={hideTip}");
    expect(nav).toContain('data-testid="rail-tooltip"');
    expect(nav).toContain("createPortal(");
    expect(nav).not.toContain("title={collapsed ? item.label : undefined}");
    expect(src).toContain("aria-label={collapsed ? item.label : undefined}");
    expect(src).toContain('aria-label={sidebarCollapsed ? "More pages" : undefined}');
    expect(src).toContain('aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}');
  });
});

describe("prompt bar control labels", () => {
  it("the … trigger has no native tooltip, its name pops in under it", () => {
    const html = renderToStaticMarkup(
      createElement(PromptBar, {
        onSubmit: async () => undefined,
        isConnected: true,
      }),
    );
    expect(html).not.toContain('title="More tools"');
    expect(html).toContain(
      `<span class="${PROMPT_OVERFLOW_LABEL_CLASS}" aria-hidden="true">More tools</span>`,
    );
    for (const cls of [PROMPT_PILL_LABEL_CLASS, PROMPT_OVERFLOW_LABEL_CLASS]) {
      expect(cls).toMatch(/(^| )top-full( |$)/);
      expect(cls).toContain("group-focus-visible:opacity-100");
      expect(cls).toMatch(/(^| )absolute( |$)/);
    }
    expect(PROMPT_OVERFLOW_LABEL_CLASS).toMatch(/(^| )right-0( |$)/);
    expect(PROMPT_OVERFLOW_LABEL_CLASS).not.toContain("left-1/2");
  });
});

/**
 * Nav registry parity: one list (lib/ui/navRegistry.ts) feeds the desktop
 * sidebar, the mobile tab bar + Menu, the command palette and the keyboard
 * help, so labels, icons and shortcuts cannot drift apart again.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { NavKey } from "@/types";
import {
  NAV_DESTINATIONS,
  destinationForNav,
  isDestinationActive,
  mobileFooterDestinations,
  mobileMenuDestinations,
  mobileTabDestinations,
  navDestinationsIn,
  navShortcutMap,
  navigateToDestination,
} from "@/lib/ui/navRegistry";
import { shortcutSections } from "@/components/KeyboardHelp";
import { menuItemForNav } from "@/components/MobileBottomNav";
import { BRAND_LEAK } from "./brandLeak";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** Every member of the NavKey union, read from the type itself. */
function allNavKeys(): NavKey[] {
  const types = src("src/types/index.ts");
  const block = types.slice(
    types.indexOf("export type NavKey ="),
    types.indexOf(";", types.indexOf("export type NavKey =")),
  );
  return [...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1] as NavKey);
}

describe("nav registry", () => {
  it("has unique keys, labels and shortcuts", () => {
    const keys = NAV_DESTINATIONS.map((d) => d.key);
    const labels = NAV_DESTINATIONS.map((d) => d.label);
    const shortcuts = NAV_DESTINATIONS.flatMap((d) =>
      d.shortcut ? [d.shortcut] : [],
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("reaches every page in the NavKey union (directly or via an alias)", () => {
    const navKeys = allNavKeys();
    expect(navKeys.length).toBeGreaterThan(15);
    for (const key of navKeys) {
      expect(destinationForNav(key), key).toBeDefined();
    }
  });

  it("has seven primary pages; Setup sits with the account pages", () => {
    const primary = navDestinationsIn("primary").map((d) => d.key);
    expect(primary).toEqual([
      "explore",
      "create",
      "edit",
      "organize",
      "tools",
      "styles",
      "characters",
    ]);
    const more = navDestinationsIn("more").map((d) => d.key);
    expect(more).toEqual(["moodboards", "personalize", "tasks"]);
    const account = navDestinationsIn("account").map((d) => d.key);
    expect(account).toContain("setup");
    for (const old of ["workflows", "pipelines", "manager"]) {
      expect(NAV_DESTINATIONS.map((d) => d.key as string)).not.toContain(old);
    }
  });

  it("finds Setup by its old page names in search", () => {
    const setup = destinationForNav("setup")!;
    expect(setup.label).toBe("Setup");
    for (const word of ["workflows", "pipelines", "button routing", "node packs", "models"]) {
      expect(setup.keywords).toContain(word);
    }
  });

  it("gives every destination a plain one-line hint", () => {
    for (const d of NAV_DESTINATIONS) {
      expect(d.hint.length, d.key).toBeGreaterThan(10);
      expect(d.hint.length, d.key).toBeLessThan(70);
      expect(d.hint).not.toMatch(BRAND_LEAK);
      expect(d.label).not.toMatch(BRAND_LEAK);
    }
  });

  it("number shortcuts 1-7 follow the primary nav", () => {
    expect(navShortcutMap()).toEqual({
      "1": "explore",
      "2": "create",
      "3": "edit",
      "4": "organize",
      "5": "tools",
      "6": "styles",
      "7": "characters",
    });
  });

  it("routes Styles through the hub's Browse tab", () => {
    const setActiveNav = vi.fn();
    const setStylesHubTab = vi.fn();
    navigateToDestination("styles", { setActiveNav, setStylesHubTab });
    expect(setStylesHubTab).toHaveBeenCalledWith("library");
    expect(setActiveNav).toHaveBeenCalledWith("library");
    navigateToDestination("setup", { setActiveNav, setStylesHubTab });
    expect(setActiveNav).toHaveBeenLastCalledWith("setup");
    const styles = destinationForNav("styles")!;
    expect(isDestinationActive(styles, "style-vault")).toBe(true);
    expect(isDestinationActive(styles, "create")).toBe(false);
  });
});

describe("desktop / mobile parity", () => {
  it("mobile tabs + Menu + footer cover exactly the registry", () => {
    const mobile = [
      ...mobileTabDestinations(),
      ...mobileMenuDestinations(),
      ...mobileFooterDestinations(),
    ].map((d) => d.key);
    expect(new Set(mobile).size).toBe(mobile.length);
    expect([...mobile].sort()).toEqual(
      NAV_DESTINATIONS.map((d) => d.key).sort(),
    );
    // Sidebar groups cover the same set.
    const desktop = (["primary", "more", "account"] as const).flatMap((g) =>
      navDestinationsIn(g).map((d) => d.key),
    );
    expect([...desktop].sort()).toEqual([...mobile].sort());
  });

  it("the mobile tab bar is a subset of the primary list", () => {
    for (const tab of mobileTabDestinations()) {
      expect(tab.group).toBe("primary");
    }
    expect(mobileTabDestinations().length).toBe(4);
  });

  it("neither nav component hardcodes its own labels or icons", () => {
    for (const file of [
      "src/components/Sidebar.tsx",
      "src/components/MobileBottomNav.tsx",
      "src/components/CommandPalette.tsx",
    ]) {
      const code = src(file);
      expect(code, file).toContain("@/lib/ui/navRegistry");
      // No local `{ key: "...", label: "..." }` nav tables.
      expect(code, file).not.toMatch(/key:\s*"[a-z-]+",\s*label:/);
    }
  });

  it("Menu highlights the row that owns the page", () => {
    expect(menuItemForNav("setup")).toBe("setup");
    expect(menuItemForNav("style-creator")).toBe("styles");
    expect(menuItemForNav("create")).toBeNull();
  });

  it("page titles use the registry labels", () => {
    const page = src("src/app/page.tsx");
    const block = page.slice(
      page.indexOf("const pageLabels"),
      page.indexOf("};", page.indexOf("const pageLabels")),
    );
    for (const d of NAV_DESTINATIONS) {
      const re = new RegExp(`"?${d.key}"?:\\s*"([^"]+)"`);
      expect(block.match(re)?.[1], d.key).toBe(d.label);
    }
  });

  it("the Workflows view links to Button routing", () => {
    expect(src("src/components/WorkflowsPage.tsx")).toContain(
      'openSetupTab("routing")',
    );
  });
});

describe("keyboard help matches the real handlers", () => {
  it("lists Ctrl/Cmd+K as the palette and / as the prompt", () => {
    const general = shortcutSections().find((s) => s.title === "General")!;
    const byKeys = (k: string[]) =>
      general.items.find((i) => i.keys.join("+") === k.join("+"))?.description;
    expect(byKeys(["Ctrl/Cmd", "K"])).toMatch(/command palette/i);
    expect(byKeys(["/"])).toMatch(/prompt/i);

    const page = src("src/app/page.tsx");
    expect(page).toMatch(/e\.key === "k"[\s\S]{0,160}setPaletteOpen/);
    expect(page).toMatch(/e\.key === "\/"[\s\S]{0,200}#desktop_input_bar/);
  });

  it("generates Go-to rows from the same map page.tsx uses", () => {
    const goTo = shortcutSections().find((s) => s.title === "Go to")!;
    expect(goTo.items).toEqual(
      Object.entries(navShortcutMap()).map(([k, nav]) => ({
        keys: [k],
        description: `Go to ${destinationForNav(nav)!.label}`,
      })),
    );
    expect(goTo.items.find((i) => i.keys[0] === "6")?.description).toBe(
      "Go to Styles",
    );
    expect(goTo.items.find((i) => i.keys[0] === "7")?.description).toBe(
      "Go to Characters",
    );
    expect(JSON.stringify(shortcutSections())).not.toContain("Chat");
    expect(src("src/app/page.tsx")).toContain(
      "const navKeys = navShortcutMap()",
    );
  });
});

describe("command palette", () => {
  it("lists every destination", async () => {
    const { CommandPalette } = await import("@/components/CommandPalette");
    const html = renderToStaticMarkup(
      React.createElement(CommandPalette, {
        isOpen: true,
        onClose: () => {},
        onShowKeyboardHelp: () => {},
        onDescribe: () => {},
      }),
    );
    for (const d of NAV_DESTINATIONS) {
      expect(html, d.key).toContain(`Go to ${d.label}`);
    }
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useUIStore } from "@/store";
import {
  applyPromptControl,
  buildPromptOverflowItems,
  formatControlCount,
  isPromptControlActive,
  overflowHasActiveMode,
  usePromptDrawerStore,
  type PromptControlState,
} from "@/components/settings/promptControls";

const closed: PromptControlState = {
  drawerOpen: false,
  drawerTab: "settings",
  imagesOpen: false,
};

describe("applyPromptControl", () => {
  it("opens the drawer on the clicked tab", () => {
    expect(applyPromptControl(closed, "styles")).toEqual({
      drawerOpen: true,
      drawerTab: "styles",
      imagesOpen: false,
    });
    expect(applyPromptControl(closed, "settings")).toMatchObject({
      drawerOpen: true,
      drawerTab: "settings",
    });
  });

  it("switches tabs without closing when another drawer pill is clicked", () => {
    const open = applyPromptControl(closed, "settings");
    expect(applyPromptControl(open, "styles")).toMatchObject({
      drawerOpen: true,
      drawerTab: "styles",
    });
  });

  it("closes the drawer when the active tab's pill is clicked again", () => {
    const open = applyPromptControl(closed, "styles");
    expect(applyPromptControl(open, "styles")).toMatchObject({
      drawerOpen: false,
      drawerTab: "styles",
    });
  });

  it("toggles images independently of the drawer", () => {
    const open = applyPromptControl(closed, "settings");
    const withImages = applyPromptControl(open, "images");
    expect(withImages).toEqual({
      drawerOpen: true,
      drawerTab: "settings",
      imagesOpen: true,
    });
    expect(applyPromptControl(withImages, "images").imagesOpen).toBe(false);
  });

  it("does not mutate the input state", () => {
    const state = { ...closed };
    applyPromptControl(state, "styles");
    applyPromptControl(state, "images");
    expect(state).toEqual(closed);
  });
});

describe("isPromptControlActive", () => {
  it("marks only the visible drawer tab as pressed", () => {
    const state: PromptControlState = {
      drawerOpen: true,
      drawerTab: "styles",
      imagesOpen: false,
    };
    expect(isPromptControlActive(state, "styles")).toBe(true);
    expect(isPromptControlActive(state, "settings")).toBe(false);
    expect(isPromptControlActive(state, "images")).toBe(false);
  });

  it("is never pressed for a closed drawer", () => {
    expect(isPromptControlActive(closed, "settings")).toBe(false);
    expect(
      isPromptControlActive({ ...closed, imagesOpen: true }, "images"),
    ).toBe(true);
  });
});

describe("formatControlCount", () => {
  it("hides empty and invalid counts", () => {
    expect(formatControlCount(0)).toBeNull();
    expect(formatControlCount(-2)).toBeNull();
    expect(formatControlCount(Number.NaN)).toBeNull();
    expect(formatControlCount(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("shows small counts and caps at 9+", () => {
    expect(formatControlCount(1)).toBe("1");
    expect(formatControlCount(9)).toBe("9");
    expect(formatControlCount(10)).toBe("9+");
    expect(formatControlCount(3.7)).toBe("3");
  });
});

describe("buildPromptOverflowItems", () => {
  it("lists the relocated tools in a stable order", () => {
    const items = buildPromptOverflowItems({
      hasHistory: true,
      runNext: false,
      nevoEnabled: false,
    });
    expect(items.map((i) => i.id)).toEqual([
      "history",
      "import",
      "library",
      "run-next",
      "nevo",
    ]);
    for (const item of items) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.hint.length).toBeGreaterThan(0);
    }
  });

  it("omits history until there is some", () => {
    const ids = buildPromptOverflowItems({
      hasHistory: false,
      runNext: false,
      nevoEnabled: false,
    }).map((i) => i.id);
    expect(ids).not.toContain("history");
    expect(ids[0]).toBe("import");
  });

  it("reflects run-next as a checkbox and evolve mode as active", () => {
    const items = buildPromptOverflowItems({
      hasHistory: false,
      runNext: true,
      nevoEnabled: true,
    });
    const runNext = items.find((i) => i.id === "run-next");
    const nevo = items.find((i) => i.id === "nevo");
    expect(runNext?.checked).toBe(true);
    expect(nevo?.active).toBe(true);
    expect(nevo?.checked).toBeUndefined();

    const off = buildPromptOverflowItems({
      hasHistory: false,
      runNext: false,
      nevoEnabled: false,
    });
    expect(off.find((i) => i.id === "run-next")?.checked).toBe(false);
    expect(off.find((i) => i.id === "nevo")?.active).toBe(false);
  });
});

describe("overflowHasActiveMode", () => {
  it("flags the menu when a hidden mode is on", () => {
    expect(overflowHasActiveMode({ runNext: false, nevoEnabled: false })).toBe(
      false,
    );
    expect(overflowHasActiveMode({ runNext: true, nevoEnabled: false })).toBe(
      true,
    );
    expect(overflowHasActiveMode({ runNext: false, nevoEnabled: true })).toBe(
      true,
    );
  });
});

describe("usePromptDrawerStore", () => {
  afterEach(() => usePromptDrawerStore.getState().setTab("settings"));

  it("defaults to the settings tab and switches tabs", () => {
    expect(usePromptDrawerStore.getState().tab).toBe("settings");
    usePromptDrawerStore.getState().setTab("styles");
    expect(usePromptDrawerStore.getState().tab).toBe("styles");
  });

  it("Styles pill opens the drawer on the styles tab and keeps it while open", () => {
    useUIStore.getState().setSettingsOpen(false);
    const next = applyPromptControl(
      { drawerOpen: false, drawerTab: "settings", imagesOpen: false },
      "styles",
    );
    // Same order PromptBar.handleControl applies it.
    usePromptDrawerStore.getState().setTab(next.drawerTab);
    useUIStore.getState().setSettingsOpen(next.drawerOpen);
    expect(useUIStore.getState().settingsOpen).toBe(true);
    expect(usePromptDrawerStore.getState().tab).toBe("styles");
    // Unrelated UI-store updates while open don't reset the tab.
    useUIStore.getState().setSettingsOpen(true);
    expect(usePromptDrawerStore.getState().tab).toBe("styles");
  });

  it("resets to settings when the drawer closes, so Ctrl+S lands on Settings", () => {
    usePromptDrawerStore.getState().setTab("styles");
    useUIStore.getState().setSettingsOpen(true);
    useUIStore.getState().setSettingsOpen(false);
    expect(usePromptDrawerStore.getState().tab).toBe("settings");
    useUIStore.getState().toggleSettings();
    expect(usePromptDrawerStore.getState().tab).toBe("settings");
    useUIStore.getState().setSettingsOpen(false);
  });

  it("SettingsPanel does not reset the tab on unmount (StrictMode double-mount)", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/components/SettingsPanel.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/useEffect\(\(\) => \(\) => setTab/);
  });
});

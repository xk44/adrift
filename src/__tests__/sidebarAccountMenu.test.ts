import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { menuItemsIn } from "@/components/Sidebar";

const src = readFileSync(
  path.join(process.cwd(), "src/components/Sidebar.tsx"),
  "utf8",
);

describe("Sidebar account menu keyboard (C13)", () => {
  it("menuItemsIn handles a missing menu and skips disabled items", () => {
    expect(menuItemsIn(null)).toEqual([]);
    const seen: string[] = [];
    const fake = {
      querySelectorAll(sel: string) {
        seen.push(sel);
        return [];
      },
    } as unknown as HTMLElement;
    expect(menuItemsIn(fake)).toEqual([]);
    expect(seen[0]).toBe('[role="menuitem"]:not([disabled])');
  });

  it("menu roves with arrows, focuses in on open, returns focus on Escape", () => {
    expect(src).toContain("onKeyDown={onAccountMenuKeyDown}");
    expect(src).toContain("menuItemsIn(accountMenuListRef.current)[0]?.focus()");
    expect(src).toContain("ref={accountTriggerRef}");
    expect(src).toMatch(/useDismissable\(\s*accountMenuOpen,[\s\S]{0,80}focusAccountTrigger/);
    const items = src.match(/role="menuitem"\n\s*tabIndex=\{-1\}/g) ?? [];
    // Account pages, the two tour entries, Report a problem, theme toggle and Sign Out
    // (shown when sign-in is on).
    expect(items.length).toBe(6);
  });

  it("menu Escape is marked handled so the page doesn't close another layer", () => {
    expect(src).toMatch(/if \(e\.key !== "Escape" \|\| e\.defaultPrevented\) return;\s*\/\/[^\n]*\n[^\n]*\n\s*e\.preventDefault\(\);/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePathname, parseHash, buildPathname } from "@/lib/routeMapper";
import { destinationForNav } from "@/lib/ui/navRegistry";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("Tools tab wiring", () => {
  it("routes /tools and #tools to the tools nav key", () => {
    expect(parsePathname("/tools")).toEqual({ nav: "tools", params: {} });
    expect(parseHash("#tools")).toBe("tools");
    expect(buildPathname("tools")).toBe("/tools");
  });
  it("appears in sidebar, mobile nav and page switch", () => {
    // Sidebar + mobile tab bar both render the registry's primary/mobile items.
    expect(destinationForNav("tools")).toMatchObject({
      group: "primary",
      mobileTab: true,
    });
    expect(read("src/components/Sidebar.tsx")).toContain('navDestinationsIn("primary")');
    expect(read("src/components/MobileBottomNav.tsx")).toContain("mobileTabDestinations()");
    const page = read("src/app/page.tsx");
    expect(page).toContain('case "tools"');
    expect(page).toContain("components/tools/ToolsPage");
  });
  it("runner submits only through the tested helpers (no raw job fetches)", () => {
    const runner = read("src/components/tools/ToolRunner.tsx");
    expect(runner).toContain("submitCatalogTool");
    expect(runner).toContain("submitActionTool");
    expect(runner).not.toMatch(/\/api\/jobs\//);
    expect(runner).toContain("tool-license");
  });
});

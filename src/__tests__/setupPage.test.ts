/**
 * Setup page: Workflows + Button routing + Node packs + Models in one place.
 * URL state, legacy redirects, route table and the page's source contract.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SETUP_TABS,
  SETUP_TAB_LABELS,
  legacySetupLocation,
  legacySetupSearch,
  parseSetupLocation,
  setupHref,
} from "@/lib/setupUrl";
import {
  buildPathname,
  canonicalSearch,
  parseHash,
  resolvePathname,
} from "@/lib/routeMapper";
import { CHROME_PAGES } from "@/lib/ui/shellChrome";
import { destinationForNav, mobileTabDestinations } from "@/lib/ui/navRegistry";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("setup URL state", () => {
  it("has four tabs with plain labels", () => {
    expect([...SETUP_TABS]).toEqual(["workflows", "routing", "nodes", "models"]);
    expect(Object.values(SETUP_TAB_LABELS)).toEqual([
      "Workflows",
      "Button routing",
      "Node packs",
      "Models",
    ]);
  });

  it("parses tab + section and falls back on junk", () => {
    expect(parseSetupLocation("")).toEqual({ tab: "workflows", section: "saved" });
    expect(parseSetupLocation("?tab=models&section=download")).toEqual({
      tab: "models",
      section: "download",
    });
    expect(parseSetupLocation("?tab=nope&section=x")).toEqual({
      tab: "workflows",
      section: "saved",
    });
    expect(parseSetupLocation("?tab=nodes&section=download")).toEqual({
      tab: "nodes",
      section: "packs",
    });
  });

  it("builds short hrefs (defaults left out) with extra query", () => {
    expect(setupHref("workflows")).toBe("/setup");
    expect(setupHref("workflows", "saved")).toBe("/setup");
    expect(setupHref("routing")).toBe("/setup?tab=routing");
    expect(setupHref("models", "download", { q: "flux" })).toBe(
      "/setup?tab=models&section=download&q=flux",
    );
  });

  it("maps the old pages and old Workflows tabs", () => {
    expect(legacySetupLocation("pipelines", "")).toEqual({
      tab: "routing",
      section: "slots",
    });
    expect(legacySetupLocation("manager", "")).toEqual({
      tab: "nodes",
      section: "packs",
    });
    expect(legacySetupLocation("workflows", "?tab=aliases")).toEqual({
      tab: "models",
      section: "names",
    });
    expect(legacySetupLocation("workflows", "?tab=packs")).toEqual({
      tab: "workflows",
      section: "packs",
    });
    expect(legacySetupSearch("workflows", "?tab=civitai&q=sdxl&sort=new")).toBe(
      "?tab=models&section=download&q=sdxl&sort=new",
    );
    expect(legacySetupSearch("workflows", "")).toBe("");
  });
});

describe("routes", () => {
  it("resolves /setup and redirects the old paths", () => {
    expect(resolvePathname("/setup")?.nav).toBe("setup");
    expect(buildPathname("setup")).toBe("/setup");
    for (const [path, legacy] of [
      ["/workflows", "workflows"],
      ["/pipelines", "pipelines"],
      ["/button-routing", "pipelines"],
      ["/manager", "manager"],
      ["/Manager", "manager"],
    ] as const) {
      const r = resolvePathname(path);
      expect(r?.nav, path).toBe("setup");
      expect(r?.legacy, path).toBe(legacy);
    }
    const r = resolvePathname("/workflows")!;
    expect(canonicalSearch(r, "?tab=civitai")).toBe(
      "?tab=models&section=download",
    );
  });

  it("maps the old hash routes to Setup", () => {
    for (const h of ["#pipelines", "#workflows", "#manager", "#setup"]) {
      expect(parseHash(h), h).toBe("setup");
    }
  });
});

describe("Setup in the shell", () => {
  it("is one registry entry outside the primary seven, never a mobile tab", () => {
    const setup = destinationForNav("setup")!;
    expect(setup.group).toBe("account");
    expect(setup.shortcut).toBeUndefined();
    expect(mobileTabDestinations().map((d) => d.key)).not.toContain("setup");
    expect(CHROME_PAGES).toContain("setup");
  });

  it("uses the shared Tabs, keeps tab state in the URL, left-aligned header", () => {
    const page = src("src/components/SetupPage.tsx");
    expect(page).toContain('from "@/components/ui/Tabs"');
    expect(page).toMatch(/<Tabs\s[\s\S]*ariaLabel="Setup sections"/);
    expect(page).toContain('align="left"');
    expect(page).toContain("parseSetupLocation(window.location.search)");
    expect(page).toContain('window.addEventListener("popstate"');
    expect(page).toContain("window.history.pushState(null, \"\", href)");
  });

  it("is wired into page.tsx and the old pages are gone", () => {
    const app = src("src/app/page.tsx");
    expect(app).toMatch(/case "setup":\s*content = <SetupPage \/>/);
    expect(app).not.toMatch(/case "(workflows|pipelines|manager)":/);
    // A saved activeNav from before the merge lands on Setup.
    expect(src("src/store/index.ts")).toMatch(
      /legacyNav === "manager"[\s\S]{0,60}p\.activeNav = "setup"/,
    );
  });

  it("contextual links go to Setup tabs, not old pages", () => {
    expect(src("src/components/setup/CreateFailureNotice.tsx")).toContain(
      'openSetupTab("nodes")',
    );
    expect(
      src("src/components/tools/userTools/ImportWorkflowDialog.tsx"),
    ).toContain('openSetupTab("nodes")');
    expect(src("src/components/WorkflowPipelinePage.tsx")).toContain(
      "Button routing",
    );
    expect(src("src/components/WorkflowPipelinePage.tsx")).not.toContain(
      "Workflow / Pipeline Manager",
    );
  });
});

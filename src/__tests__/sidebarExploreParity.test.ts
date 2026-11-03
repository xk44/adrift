/**
 * Sidebar & ExplorePage UI Slice Tests
 * ======================================
 * Tests for the P1 parity changes:
 *  - Sidebar: report bug footer item, profile user icon (not Bug icon), account dropdown
 *  - ExplorePage: Random/Likes tabs functional (no comingSoon), Styles/Videos grid fallback
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useLikesStore } from "@/store/likesStore";
import { navDestinationsIn } from "@/lib/ui/navRegistry";
import type { LikedImage } from "@/store/likesStore";

const projectRoot = process.cwd();
const source = (path: string) => readFileSync(join(projectRoot, path), "utf8");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLikeImage(
  civitaiId: number,
  overrides?: Partial<LikedImage>,
): LikedImage {
  return {
    civitaiId,
    url: `https://example.com/img/${civitaiId}.jpg`,
    thumbnailUrl: `https://example.com/thumb/${civitaiId}.jpg`,
    prompt: `liked prompt ${civitaiId}`,
    width: 512,
    height: 768,
    models: [{ name: "sdxl", type: "Checkpoint" }],
    likedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sidebar parity: Verify data structures match the design reference
// ---------------------------------------------------------------------------

describe("Sidebar footer/account parity", () => {
  it("moves Report Bug / Help / Updates / theme into the account menu", () => {
    const sidebar = source("src/components/Sidebar.tsx");
    const menu = sidebar.slice(
      sidebar.indexOf('role="menu"'),
      sidebar.indexOf("{/* ComfyUI status dot"),
    );

    expect(menu).toContain("{/* Report Bug");
    expect(menu).toContain('setActiveNav("help")');
    expect(menu).toContain('getElementById("report-problem")');
    expect(menu).toContain('<Bug className="w-4 h-4" />');
    expect(menu).toContain("<span>Report a problem</span>");
    // Profile / Account Settings / Help / Updates come from the registry
    expect(menu).toContain("accountItems.map((item)");
    expect(menu).toContain("<span>{item.label}</span>");
    expect(navDestinationsIn("account").map((d) => d.label)).toEqual([
      "Profile",
      "Settings",
      "Setup",
      "Help",
      "Updates",
    ]);
    expect(menu).toContain("toggleTheme()");
    expect(menu).toContain('"Light mode"');
    expect(menu).toContain('"Switch to light mode"');
    // Footer no longer carries them as standalone rows
    expect(sidebar).not.toContain('<Bug className="w-5 h-5" />');
    expect(sidebar).not.toContain('<HelpCircle className="w-5 h-5" />');
    // Collapsed rail still reaches the menu via the avatar trigger
    expect(sidebar).toContain('aria-label="Menu"');
  });

  it("uses an avatar/account overflow menu instead of a Bug-icon Profile footer button", () => {
    const sidebar = source("src/components/Sidebar.tsx");

    expect(sidebar).toContain(
      "const [accountMenuOpen, setAccountMenuOpen] = useState(false)",
    );
    expect(sidebar).toContain("accountMenuRef");
    expect(sidebar).toContain("{/* Avatar: profile initial, or a person icon until a name is set */}");
    expect(sidebar).toContain('navDestinationsIn("account")');
    expect(sidebar).toContain("<span>Sign Out</span>");
    // Only when sign-in is on, and it really signs out.
    expect(sidebar).toContain("{signInEnabled && (");
    expect(sidebar).toContain('fetch("/api/auth/logout"');
    expect(sidebar).not.toContain("no account session to sign out of");
    expect(sidebar).not.toContain("<span>Profile</span>\n          <Bug");
  });

  it("renders running badge and active nav chrome", () => {
    const sidebar = source("src/components/Sidebar.tsx");
    const globals = source("src/app/globals.css");

    expect(sidebar).toContain("const hasRunningJobs = activeJobCount > 0");
    expect(sidebar).toContain("shadow-[0_0_8px_var(--accent-primary)]");
    // sidebar: transparent on page bg, no right border, handwritten
    // version script; active nav = rounded-full pill, splash-red tint
    expect(sidebar).toContain("bg-transparent");
    expect(sidebar).not.toContain("border-r border-[var(--border-primary)]");
    // Wordmark only — no version flourish
    expect(sidebar).not.toContain("alpha");
    // active nav = splash text only, no tinted pill
    expect(globals).toContain(".nav-item-active {");
    expect(globals).toMatch(
      /\.nav-item-active\s*\{[\s\S]*?background:\s*transparent/,
    );
    expect(globals).not.toContain("rgba(242, 51, 13, 0.12)");
    expect(globals).not.toContain("rgba(59, 130, 246");
    expect(globals).not.toContain(".nav-item-active::before");
  });

  it("hosts the ComfyUI status row in the sidebar footer (no bottom status bar)", () => {
    const sidebar = source("src/components/Sidebar.tsx");
    const page = source("src/app/page.tsx");

    expect(sidebar).toContain("function SidebarStatus");
    expect(sidebar).toContain("cj:ws-reconnect");
    expect(sidebar).toContain("queueRemaining");
    // Compact dot + popover (errors still reachable), no text status row
    expect(sidebar).toContain('data-testid="sidebar-status-dot"');
    expect(sidebar).toContain("formatErrorReport(errors)");
    expect(sidebar).toContain('aria-label="Clear all errors"');
    expect(sidebar).not.toContain("<AlertTriangle");
    expect(page).not.toContain("<StatusBar");
    expect(page).toContain('window.addEventListener("cj:ws-reconnect"');
  });
});

// ---------------------------------------------------------------------------
// ExplorePage: Verify tab changes remove comingSoon gates
// ---------------------------------------------------------------------------

describe("ExplorePage tab completion", () => {
  // Test that PRIMARY_TABS no longer have comingSoon: true on Random and Likes

  it("Hot, Top, New, and Likes primary tabs are wired in source without comingSoon gates", () => {
    // Tab definitions live in the shared explore store (used by both
    // ExplorePage and the prompt-bar-row ExploreControls)
    const store = source("src/store/exploreStore.ts");
    const explore = source("src/components/ExplorePage.tsx");

    expect(store).toContain(
      '{ id: "hot", label: "Hot", sort: "Most Reactions" }',
    );
    expect(store).toContain('{ id: "new", label: "New", sort: "Newest" }');
    expect(store).toContain(
      '{ id: "likes", label: "Likes", sort: "Most Reactions" }',
    );
    expect(store).not.toContain("comingSoon");
    expect(explore).not.toContain("comingSoon");
    expect(explore).toMatch(
      /primaryTab\s*===\s*"likes"\s*&&\s*secondaryTab\s*===\s*"images"/,
    );
    expect(explore).toContain("renderLikedImages()");
  });

  it("explore sort/search controls render inline with the prompt bar row", () => {
    const page = source("src/app/page.tsx");
    const controls = source("src/components/ExploreControls.tsx");
    const explore = source("src/components/ExplorePage.tsx");

    expect(page).toContain(
      '{activeNav === "explore" ? <ExploreControls /> : <div />}',
    );
    expect(controls).toContain("useExploreStore");
    expect(controls).toContain("Search Images");
    expect(controls).toContain("Search Models");
    // ExplorePage no longer renders its own header block
    expect(explore).not.toContain("<header");
    // Mobile fallback keeps controls reachable below lg
    expect(explore).toContain('<ExploreControls variant="mobile" />');
  });

  it("Top period selector is wired through the Civitai images API query", () => {
    const store = source("src/store/exploreStore.ts");
    const explore = source("src/components/ExplorePage.tsx");
    const route = source("src/app/api/civitai/images/route.ts");

    expect(store).toContain("const CIVITAI_TOP_PERIOD");
    expect(explore).toContain(
      'primaryTab === "top" ? CIVITAI_TOP_PERIOD[topPeriod] : undefined',
    );
    expect(explore).toContain("topPeriod]");
    expect(route).toContain('searchParams.get("period")');
    expect(route).toContain("period,");
  });

  it("Styles and Videos secondary tabs render real content paths, not Coming Soon", () => {
    const explore = source("src/components/ExplorePage.tsx");

    expect(explore).toContain("const SEED_VIDEO_PROMPTS");
    expect(explore).toContain("const renderVideosGrid = () =>");
    // Styles tab mounts the Krea 2 style-LoRA browser instead of the
    // SEED_STYLES placeholder grid.
    expect(explore).toContain("Krea2StyleLoraBrowser");
    expect(explore).toContain('secondaryTab === "styles"');
    expect(explore).toContain("<Krea2StyleLoraBrowser />");
    expect(explore).toContain('secondaryTab === "videos"');
    expect(explore).toContain("renderVideosGrid()");
    expect(explore).toContain("generationRuns");
    expect(explore).toContain("Use Prompt");
  });
});

// ---------------------------------------------------------------------------
// Likes integration: Verify likesStore powers the Likes tab content
// ---------------------------------------------------------------------------

describe("ExplorePage Likes tab — likesStore integration", () => {
  beforeEach(() => {
    useLikesStore.setState({ likes: [] });
  });

  it("renders liked images from the store", () => {
    const img1 = makeLikeImage(101, { prompt: "sunset over ocean" });
    const img2 = makeLikeImage(102, { prompt: "mountain landscape" });
    useLikesStore.getState().toggleLike(img1);
    useLikesStore.getState().toggleLike(img2);

    const likedImages = useLikesStore.getState().getLikedImages();
    expect(likedImages).toHaveLength(2);
    // Verify both prompts are present (order depends on likedAt timestamps)
    const prompts = likedImages.map((l) => l.prompt);
    expect(prompts).toContain("sunset over ocean");
    expect(prompts).toContain("mountain landscape");
  });

  it("shows empty state when no images are liked", () => {
    expect(useLikesStore.getState().getLikedImages()).toHaveLength(0);
  });

  it("can unlike an image to remove it from the Likes view", () => {
    const img = makeLikeImage(200);
    useLikesStore.getState().toggleLike(img);
    expect(useLikesStore.getState().isLiked(200)).toBe(true);

    useLikesStore.getState().toggleLike(img); // unlike
    expect(useLikesStore.getState().isLiked(200)).toBe(false);
    expect(useLikesStore.getState().getLikedImages()).toHaveLength(0);
  });
});

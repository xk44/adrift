import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  connectionDotClass,
  connectionLabel,
  connectionTitle,
  deriveConnectionState,
  CONNECTION_ALERT_DELAY_MS,
  errorBadgeText,
  errorBannerMode,
  formatErrorReport,
  isConnectionErrorMessage,
} from "@/lib/ui/connectionState";
import {
  CHROME_PAGES,
  isChromePage,
  isPromptBarDesktopOnly,
} from "@/lib/ui/shellChrome";
import { menuItemForNav } from "@/components/MobileBottomNav";
import { mobileTabDestinations } from "@/lib/ui/navRegistry";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("deriveConnectionState", () => {
  it("prefers connected, then reconnecting, then partial, then offline", () => {
    expect(
      deriveConnectionState({
        wsConnected: true,
        comfyReachable: false,
        wsReconnecting: true,
      }),
    ).toBe("connected");
    expect(
      deriveConnectionState({
        wsConnected: false,
        comfyReachable: true,
        wsReconnecting: true,
      }),
    ).toBe("reconnecting");
    expect(
      deriveConnectionState({
        wsConnected: false,
        comfyReachable: true,
        wsReconnecting: false,
      }),
    ).toBe("partial");
    expect(
      deriveConnectionState({
        wsConnected: false,
        comfyReachable: false,
        wsReconnecting: false,
      }),
    ).toBe("offline");
  });

  it("uses calm wording (no alarm words) and keeps the queue count", () => {
    expect(connectionLabel("connected")).toBe("ComfyUI");
    expect(connectionLabel("connected", 3)).toBe("ComfyUI · queue 3");
    expect(connectionLabel("offline")).toBe("Offline");
    expect(connectionLabel("reconnecting")).toBe("Reconnecting…");
    for (const s of ["partial", "reconnecting", "offline"] as const) {
      expect(connectionLabel(s)).not.toMatch(/disconnected|error/i);
      expect(connectionTitle(s).length).toBeGreaterThan(0);
    }
  });

  it("never paints offline in the error red", () => {
    expect(connectionDotClass("offline")).not.toContain("--error");
    expect(connectionDotClass("connected")).toContain("--success");
    expect(connectionDotClass("reconnecting")).toContain("--warning");
  });
});

describe("chrome pages hide the prompt bar", () => {
  it("covers the account/info pages and the setup/admin pages", () => {
    expect([...CHROME_PAGES].sort()).toEqual(
      [
        "account-settings",
        "help",
        "updates",
        "setup",
      ].sort(),
    );
    expect(isChromePage("updates")).toBe(true);
    expect(isChromePage("setup")).toBe(true);
    expect(isChromePage("explore")).toBe(false);
    expect(isChromePage("create")).toBe(false);
    expect(isChromePage("profile")).toBe(false);
    expect(isChromePage("tools")).toBe(false);
  });

  it("Tools/Styles/Profile keep the bar on desktop only", () => {
    for (const nav of ["tools", "profile", "library", "style-vault"] as const) {
      expect(isPromptBarDesktopOnly(nav)).toBe(true);
    }
    for (const nav of ["create", "explore", "organize"] as const) {
      expect(isPromptBarDesktopOnly(nav)).toBe(false);
    }
    const page = src("src/app/page.tsx");
    expect(page).toContain("isPromptBarDesktopOnly(activeNav)");
    expect(page).toContain('promptBarDesktopOnly ? "hidden md:block" : undefined');
  });

  it("page.tsx gates showPromptBar on isChromePage", () => {
    expect(src("src/app/page.tsx")).toMatch(
      /const showPromptBar = !showEditor && !isChromePage\(activeNav\)/,
    );
  });
});

describe("mobile menu", () => {
  it("maps every page that lives in the Menu panel to its row", () => {
    expect(menuItemForNav("library")).toBe("styles");
    expect(menuItemForNav("style-vault")).toBe("styles");
    expect(menuItemForNav("edit")).toBe("edit");
    expect(menuItemForNav("setup")).toBe("setup");
    expect(menuItemForNav("account-settings")).toBe("account-settings");
    expect(menuItemForNav("updates")).toBe("updates");
    expect(menuItemForNav("explore")).toBeNull();
    expect(menuItemForNav("tools")).toBeNull();
  });

  it("keeps primary tabs to Menu + four destinations", () => {
    const nav = src("src/components/MobileBottomNav.tsx");
    expect(mobileTabDestinations().map((d) => d.key)).toEqual([
      "explore",
      "create",
      "organize",
      "tools",
    ]);
    expect(nav).toContain('aria-controls="mobile-menu-panel"');
  });

  it("prompt bar uses the compact status pill, not a red banner", () => {
    const bar = src("src/components/PromptBar.tsx");
    expect(bar).toContain("<ConnectionStatusPill isConnected={isConnected} />");
    expect(bar).not.toContain("<span>Disconnected</span>");
  });
});

describe("delayed connection alerts", () => {
  const WS_ERR = "WebSocket disconnected and ComfyUI unreachable";
  const LOST = "Lost connection to ComfyUI. Please check if it's running.";

  it("recognizes the socket hook's connection errors only", () => {
    expect(isConnectionErrorMessage(WS_ERR)).toBe(true);
    expect(isConnectionErrorMessage(LOST)).toBe(true);
    expect(isConnectionErrorMessage("Failed to connect to ComfyUI")).toBe(true);
    expect(isConnectionErrorMessage("Generation failed: OOM")).toBe(false);
    expect(isConnectionErrorMessage(null)).toBe(false);
    expect(isConnectionErrorMessage("")).toBe(false);
  });

  it("waits 15s before any banner", () => {
    expect(CONNECTION_ALERT_DELAY_MS).toBe(15_000);
  });

  it("hides connection errors until the outage is long, and after dismissal", () => {
    const base = { message: WS_ERR, isConnected: false, dismissed: false };
    expect(errorBannerMode({ ...base, downLong: false })).toBe("hidden");
    expect(errorBannerMode({ ...base, downLong: true })).toBe("connection");
    expect(errorBannerMode({ ...base, downLong: true, dismissed: true })).toBe(
      "hidden",
    );
  });

  it("drops a stale connection error once reconnected", () => {
    expect(
      errorBannerMode({
        message: LOST,
        isConnected: true,
        downLong: false,
        dismissed: false,
      }),
    ).toBe("hidden");
  });

  it("always shows ordinary errors, regardless of connection/dismissal", () => {
    expect(
      errorBannerMode({
        message: "Generation failed: bad workflow",
        isConnected: false,
        downLong: false,
        dismissed: true,
      }),
    ).toBe("error");
    expect(
      errorBannerMode({
        message: null,
        isConnected: false,
        downLong: true,
        dismissed: false,
      }),
    ).toBe("hidden");
  });

  it("formats a numbered error report with prompt ids", () => {
    const text = formatErrorReport([
      { message: "first", timestamp: 0, promptId: "p1" },
      { message: "second", timestamp: 0 },
    ]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^1\. \[.+\] first \(prompt: p1\)$/);
    expect(lines[1]).toMatch(/^2\. \[.+\] second$/);
  });

  it("caps the error badge so the dot stays small", () => {
    expect(errorBadgeText(0)).toBeNull();
    expect(errorBadgeText(1)).toBe("1");
    expect(errorBadgeText(9)).toBe("9");
    expect(errorBadgeText(12)).toBe("9+");
  });

  it("page.tsx gates the banner through errorBannerMode with a session dismissal", () => {
    const page = src("src/app/page.tsx");
    expect(page).toContain("errorBannerMode({");
    expect(page).toContain('bannerMode === "connection"');
    expect(page).toContain('bannerMode === "error"');
    expect(page).toContain("CONNECTION_BANNER_DISMISSED_KEY");
    expect(page).toContain("sessionStorage");
  });

  it("the mobile pill waits for a sustained outage too", () => {
    const pill = src("src/components/ConnectionStatusPill.tsx");
    expect(pill).toContain("useConnectionDownFor(isConnected)");
  });
});

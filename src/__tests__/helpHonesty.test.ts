/**
 * Honesty checks (critique #22): no settings wired to nothing, and the bug
 * report never pretends to be "submitted" somewhere.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ISSUES_URL,
  MAX_ISSUE_URL_LENGTH,
  buildBugReport,
  issueUrlForReport,
  issuesUrl,
} from "@/lib/ui/bugReport";

const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("buildBugReport", () => {
  const now = new Date("2026-10-27T12:00:00Z");

  it("puts the user's words first, then the facts", () => {
    const report = buildBugReport({
      description: "  The upscale button does nothing  ",
      comfyReachable: false,
      wsConnected: true,
      userAgent: "TestBrowser/1.0",
      page: "/tools",
      now,
    });
    expect(
      report.startsWith(
        "## What happened\n\nThe upscale button does nothing\n",
      ),
    ).toBe(true);
    expect(report).toContain("- ComfyUI: not reachable");
    expect(report).toContain("- Live updates (WebSocket): connected");
    expect(report).toContain("- Page: /tools");
    expect(report).toContain("- Browser: TestBrowser/1.0");
    expect(report).toContain("- Time: 2026-10-27T12:00:00.000Z");
    expect(report).not.toContain("Recent errors");
  });

  it("adds at most 10 recent errors", () => {
    const errors = Array.from({ length: 12 }, (_, i) => ({
      message: `boom-${i}`,
      timestamp: now.getTime(),
    }));
    const report = buildBugReport({
      description: "x",
      comfyReachable: true,
      wsConnected: true,
      errors,
      now,
    });
    expect(report).toContain("## Recent errors");
    expect(report).toContain("boom-9");
    expect(report).not.toContain("boom-10");
  });

  it("never comes out empty", () => {
    const report = buildBugReport({
      description: "   ",
      comfyReachable: true,
      wsConnected: false,
      now,
    });
    expect(report).toContain("(no description)");
  });
});

describe("issueUrlForReport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pre-fills title and body on the issues page", () => {
    const url = new URL(
      issueUrlForReport("## What happened\n\nbroken", "Lightbox freezes\nmore"),
    );
    expect(`${url.origin}${url.pathname}`).toBe(DEFAULT_ISSUES_URL);
    expect(url.searchParams.get("title")).toBe("Lightbox freezes");
    expect(url.searchParams.get("body")).toBe("## What happened\n\nbroken");
  });

  it("keeps existing query params on a custom base", () => {
    const url = issueUrlForReport(
      "body",
      "t",
      "https://example.test/new?labels=bug",
    );
    expect(url.startsWith("https://example.test/new?labels=bug&")).toBe(true);
  });

  it("shortens long titles and bodies to fit a URL", () => {
    const longTitle = "a".repeat(200);
    const url = issueUrlForReport("é".repeat(20_000), longTitle);
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_LENGTH);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("title")).toHaveLength(80);
    expect(parsed.searchParams.get("body")).toContain("Report shortened");
  });

  it("can be pointed at another tracker", () => {
    vi.stubEnv("NEXT_PUBLIC_ISSUES_URL", "https://tracker.example/new");
    expect(issuesUrl()).toBe("https://tracker.example/new");
    vi.stubEnv("NEXT_PUBLIC_ISSUES_URL", "  ");
    expect(issuesUrl()).toBe(DEFAULT_ISSUES_URL);
  });
});

describe("Help page report section", () => {
  it("offers Copy report + Open an issue and never claims a submit", async () => {
    vi.resetModules();
    const ui = { activeNav: "help" };
    const gen = { comfyReachable: false, wsConnected: false, errors: [] };
    vi.doMock("@/store", () => ({
      useUIStore: (sel: (s: typeof ui) => unknown) => sel(ui),
      useGenerationStore: (sel: (s: typeof gen) => unknown) => sel(gen),
    }));
    const { HelpPage } = await import("@/components/HelpPage");
    const html = renderToStaticMarkup(React.createElement(HelpPage));
    expect(html).toContain('id="report-problem"');
    expect(html).toContain("Copy report");
    expect(html).toContain("Open an issue");
    expect(html).toContain("does not send reports anywhere");
    expect(html).not.toMatch(/Submit Report|Report saved|Past Reports/);
    expect(html).not.toContain("port 8188.");

    const code = src("src/components/HelpPage.tsx");
    expect(code).not.toContain('status: "submitted"');
    expect(code).not.toContain("STORAGE_KEYS.feedback");
  });
});

describe("no settings wired to nothing", () => {
  it("cookie toggles are gone from Account Settings and Profile", () => {
    for (const file of [
      "src/components/AccountSettingsPage.tsx",
      "src/components/ProfilePage.tsx",
    ]) {
      const code = src(file);
      expect(code, file).not.toMatch(/cookieAnalytics|cookieAdvertising/);
      expect(code, file).not.toContain("Cookie Settings");
    }
    expect(src("src/components/AccountSettingsPage.tsx")).toContain(
      "no analytics or",
    );
  });
});

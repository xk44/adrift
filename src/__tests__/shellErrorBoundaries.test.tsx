import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RouteError from "@/app/error";
import GlobalError from "@/app/global-error";
import { ErrorBoundary } from "@/components/ErrorBoundary";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("app-level error boundaries", () => {
  it("error.tsx renders an alert with the message and a retry", () => {
    const html = renderToStaticMarkup(
      createElement(RouteError, { error: new Error("boom"), reset: () => {} }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("boom");
    expect(html).toContain("Try again");
  });

  it("global-error.tsx renders its own document", () => {
    const html = renderToStaticMarkup(
      createElement(GlobalError, { error: new Error("x"), reset: () => {} }),
    );
    expect(html.startsWith("<html")).toBe(true);
    expect(html).toContain("<body");
    expect(html).toContain("Try again");
  });

  it("ErrorBoundary switches to its fallback once it has caught", () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error("e"))).toEqual({
      hasError: true,
      error: expect.any(Error),
    });
    const b = new ErrorBoundary({
      children: createElement("span", null, "child"),
      fallback: createElement("span", null, "fallback"),
    });
    b.state = { hasError: true, error: new Error("e") };
    expect(renderToStaticMarkup(b.render() as React.ReactElement)).toBe(
      "<span>fallback</span>",
    );
  });

  it("shell chrome sits inside boundaries so one crash can't blank the app", () => {
    const page = read("src/app/page.tsx");
    for (const tag of [
      "<Sidebar />",
      "<MobileBottomNav />",
      "<OfflineCard",
      "<OverlayTopBar",
      "<PromptBar",
    ]) {
      const at = page.indexOf(tag);
      expect(at, tag).toBeGreaterThan(-1);
      const before = page.slice(Math.max(0, at - 120), at);
      expect(before, tag).toContain("<ShellBoundary");
    }
  });
});

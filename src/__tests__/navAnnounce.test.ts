import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { documentTitleFor, focusPageHeading } from "@/lib/ui/navAnnounce";

function fakeEl() {
  const attrs = new Map<string, string>();
  return {
    focus: vi.fn(),
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    hasAttribute: (k: string) => attrs.has(k),
    attrs,
  };
}

describe("documentTitleFor", () => {
  it("formats `Label · Adrift`", () => {
    expect(documentTitleFor("Tools")).toBe("Tools · Adrift");
    expect(documentTitleFor(undefined)).toBe("Adrift");
    expect(documentTitleFor("  ")).toBe("Adrift");
  });
});

describe("focusPageHeading", () => {
  it("focuses the page h1 (made programmatically focusable)", () => {
    const h1 = fakeEl();
    const root = { ...fakeEl(), querySelector: () => h1 };
    focusPageHeading(root);
    expect(h1.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(h1.attrs.get("tabindex")).toBe("-1");
    expect(root.focus).not.toHaveBeenCalled();
  });

  it("waits for a lazy page's heading, then falls back to the container", () => {
    let t = 0;
    const queued: Array<() => void> = [];
    const root = { ...fakeEl(), querySelector: () => null };
    focusPageHeading(root, {
      timeoutMs: 100,
      now: () => t,
      schedule: (cb) => queued.push(cb),
      cancel: () => {},
    });
    expect(root.focus).not.toHaveBeenCalled();
    t = 150;
    queued.shift()!();
    expect(root.focus).toHaveBeenCalledTimes(1);
  });

  it("cancel stops a pending retry", () => {
    const queued: Array<() => void> = [];
    const root = { ...fakeEl(), querySelector: () => null };
    const stop = focusPageHeading(root, {
      timeoutMs: 1e9,
      schedule: (cb) => queued.push(cb),
      cancel: () => {},
    });
    stop();
    queued.shift()!();
    expect(root.focus).not.toHaveBeenCalled();
  });
});

describe("shell wiring", () => {
  it("layout renders skip links and the scroll container is focusable", () => {
    const layout = readFileSync(path.join(process.cwd(), "src/app/layout.tsx"), "utf8");
    const page = readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
    expect(layout).toContain("<SkipLinks />");
    expect(page).toMatch(/id="pageScroll"\s+tabIndex=\{-1\}/);
    expect(page).toContain("document.title = documentTitleFor(currentPageLabel)");
  });
});

describe("Create page heading (C9)", () => {
  it("page.tsx gives Create a one-line h1 in the feed column", () => {
    const page = readFileSync(
      path.join(process.cwd(), "src/app/page.tsx"),
      "utf8",
    );
    expect(page).toMatch(
      /activeNav === "create" && \([\s\S]{0,400}data-testid="create-heading"/,
    );
    // No tagline under the prompt bar (keep the chrome quiet).
    expect(page).not.toContain("type a prompt, get images or video");
  });
});

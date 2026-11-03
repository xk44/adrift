/**
 * NEvo menu copy + sizing: one-line intro behind "Learn more", panel width
 * capped to the viewport on phones, no machine-specific hints.
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const nevo = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}));

vi.mock("@/store/nevoStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/nevoStore")>();
  Object.assign(nevo.state, actual.useNevoStore.getState(), {
    menuOpen: true,
    enabled: true,
    config: { ...actual.DEFAULT_NEVO_CONFIG, device: "cuda", mode: "t2v" },
    options: null,
  });
  return {
    ...actual,
    useNevoStore: (selector: (s: typeof nevo.state) => unknown) =>
      selector(nevo.state),
  };
});

import {
  NevoMenu,
  NEVO_INTRO_MORE,
  NEVO_INTRO_SHORT,
} from "@/components/nevo/NevoMenu";

describe("NEvo menu", () => {
  const html = renderToStaticMarkup(createElement(NevoMenu));

  it("caps the panel width to the viewport", () => {
    expect(html).toContain("w-[min(360px,calc(100vw-2rem))]");
    expect(html).not.toContain("w-[360px]");
  });

  it("shows a one-line intro with Learn more, details collapsed", () => {
    expect(NEVO_INTRO_SHORT.length).toBeLessThanOrEqual(80);
    expect(html).toContain(NEVO_INTRO_SHORT);
    expect(html).toMatch(/aria-expanded="false"[^>]*>Learn more</);
    expect(html).not.toContain(NEVO_INTRO_MORE);
  });

  it("keeps hints short and free of machine-specific names", () => {
    expect(html).not.toMatch(/4090|this Mac/);
    expect(html).toContain("Only LTX for now.");
    expect(html).toContain('aria-label="Close NEvo"');
  });
});

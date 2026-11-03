/**
 * Element-count budget for the Collections section of the Styles page. A
 * real library holds hundreds of boards and StyleVault groups; rendering all
 * of them at once put ~40k nodes on the page. Each list now pages at 24.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Pins the style-code UI on (the public export flips the default off;
// styleCodesFlagOff.test.ts covers that build).
vi.mock("@/lib/features", () => ({ STYLE_CODES_ENABLED: true }));
import { StyleLibraryPage } from "@/components/StyleLibraryPage";
import type { Moodboard } from "@/types";

vi.mock("@/hooks", () => ({ navigateTo: vi.fn() }));
vi.mock("@/components/Toast", () => ({ showToast: vi.fn() }));

function boards(n: number): Moodboard[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `board-${i}`,
    name: `Board ${i}`,
    images: Array.from({ length: 4 }, (_, j) => ({
      url: `/img/${i}-${j}.png`,
      weight: 1,
    })),
  }));
}

function groups(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    sref: String(1000 + i),
    tag: `group-${i}`,
    count: 5,
  }));
}

function countElements(html: string): number {
  return (html.match(/<[a-z][a-z0-9-]*/gi) ?? []).length;
}

function countButtons(html: string): number {
  return (html.match(/<button/g) ?? []).length;
}

describe("StyleLibraryPage element budget", () => {
  it("pages large libraries instead of rendering every card", () => {
    const html = renderToStaticMarkup(
      React.createElement(StyleLibraryPage, {
        embedded: true,
        query: "",
        initialBoards: boards(600),
        initialSvGroups: groups(600),
      }),
    );
    const elements = countElements(html);
    const buttons = countButtons(html);
    // Measured: 14,424 elements / 1,206 buttons before paging; 599 / 56
    // after (24 + 24 cards plus two "Show more" buttons).
    expect(elements).toBeLessThan(1000);
    expect(buttons).toBeLessThan(70);
    expect(html).toContain('data-testid="style-library-more-boards"');
    expect(html).toContain('data-testid="style-library-more-groups"');
    expect(html).toContain("Board 23");
    expect(html).not.toContain("Board 24<");
  });

  it("does not repeat the Collections heading the Styles page already shows", () => {
    const html = renderToStaticMarkup(
      React.createElement(StyleLibraryPage, {
        embedded: true,
        query: "",
        initialBoards: boards(2),
        initialSvGroups: [],
      }),
    );
    expect(html).not.toContain(">Collections</h2>");
    expect(html).not.toContain("style-library-more-boards");
  });
});

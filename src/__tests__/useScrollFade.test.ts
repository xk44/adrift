import { describe, expect, it } from "vitest";
import { fadeMaskStyle, scrollEdges, revealScrollLeft } from "@/components/tools/useScrollFade";

describe("scrollEdges", () => {
  it("reports no edges when content fits", () => {
    expect(
      scrollEdges({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 }),
    ).toEqual({ start: false, end: false });
  });

  it("reports only the end edge at the start", () => {
    expect(
      scrollEdges({ scrollLeft: 0, scrollWidth: 600, clientWidth: 300 }),
    ).toEqual({ start: false, end: true });
  });

  it("reports both edges mid-scroll", () => {
    expect(
      scrollEdges({ scrollLeft: 150, scrollWidth: 600, clientWidth: 300 }),
    ).toEqual({ start: true, end: true });
  });

  it("treats sub-pixel remainders as reached", () => {
    expect(
      scrollEdges({ scrollLeft: 299.5, scrollWidth: 600, clientWidth: 300 }),
    ).toEqual({ start: true, end: false });
  });
});

describe("fadeMaskStyle", () => {
  it("is empty when nothing is hidden", () => {
    expect(fadeMaskStyle({ start: false, end: false })).toEqual({});
  });

  it("fades only the hidden side", () => {
    const end = fadeMaskStyle({ start: false, end: true });
    expect(end.maskImage).toContain("transparent 100%");
    expect(end.maskImage).not.toContain("transparent 0");
    expect(end.WebkitMaskImage).toBe(end.maskImage);
    const start = fadeMaskStyle({ start: true, end: false });
    expect(start.maskImage).toContain("transparent 0");
    expect(start.maskImage).not.toContain("transparent 100%");
  });
});

describe("revealScrollLeft", () => {
  const row = (scrollLeft: number) => ({ scrollLeft, clientWidth: 400, scrollWidth: 1000 });
  it("leaves a visible chip alone", () => {
    expect(revealScrollLeft(row(0), { offsetLeft: 100, offsetWidth: 80 }, 48)).toBeNull();
  });
  it("scrolls right so the chip clears the end fade", () => {
    expect(revealScrollLeft(row(0), { offsetLeft: 700, offsetWidth: 80 }, 48)).toBe(428);
  });
  it("scrolls left so the chip clears the start fade, clamped at 0", () => {
    expect(revealScrollLeft(row(500), { offsetLeft: 520, offsetWidth: 60 }, 48)).toBe(472);
    expect(revealScrollLeft(row(300), { offsetLeft: 16, offsetWidth: 60 }, 48)).toBe(0);
  });
  it("clamps to the max scroll", () => {
    expect(revealScrollLeft(row(0), { offsetLeft: 950, offsetWidth: 40 }, 48)).toBe(600);
  });
});

import { describe, it, expect } from "vitest";
import {
  CHANGELOG,
  UPDATES_TABS,
  filterChangelog,
  formatDate,
  getEntryKind,
  type ChangelogEntry,
} from "@/lib/changelog";

const entry = (
  version: string,
  kind?: ChangelogEntry["kind"],
): ChangelogEntry => ({
  version,
  date: "2026-10",
  title: version,
  kind,
  highlights: [],
});

describe("Updates timeline tabs", () => {
  const entries = [
    entry("3.0.0", "announcement"),
    entry("2.0.0"),
    entry("1.0.0", "changelog"),
  ];

  it("exposes All / Announcements / Changelog in order", () => {
    expect(UPDATES_TABS.map((t) => t.label)).toEqual([
      "All",
      "Announcements",
      "Changelog",
    ]);
  });

  it("defaults entries without a kind to changelog", () => {
    expect(getEntryKind(entries[1])).toBe("changelog");
    expect(getEntryKind(entries[0])).toBe("announcement");
  });

  it("filters by tab, preserving newest-first order", () => {
    expect(filterChangelog(entries, "all").map((e) => e.version)).toEqual([
      "3.0.0",
      "2.0.0",
      "1.0.0",
    ]);
    expect(
      filterChangelog(entries, "announcements").map((e) => e.version),
    ).toEqual(["3.0.0"]);
    expect(filterChangelog(entries, "changelog").map((e) => e.version)).toEqual(
      ["2.0.0", "1.0.0"],
    );
  });

  it("returns a copy for the All tab", () => {
    const all = filterChangelog(entries, "all");
    expect(all).not.toBe(entries);
    expect(all).toEqual(entries);
  });
});

describe("formatDate with a day", () => {
  it("renders full dates", () => {
    expect(formatDate("2026-10-25")).toBe("October 25, 2026");
    expect(formatDate("2026-01-03")).toBe("January 3, 2026");
  });

  it("keeps month-only output", () => {
    expect(formatDate("2026-04")).toBe("April 2026");
  });
});

describe("changelog content", () => {
  it("uses current product branding in user-visible text", () => {
    const text = CHANGELOG.flatMap((e) => [
      e.title,
      e.summary ?? "",
      e.image?.alt ?? "",
      ...e.highlights,
      ...(e.fixes ?? []),
    ]).join("\n");
    expect(text).not.toMatch(/comfy\s*journey/i);
    expect(CHANGELOG.some((e) => /\bAdrift\b/.test(e.title))).toBe(true);
  });

  it("leads with an announcement that has a summary", () => {
    const latest = CHANGELOG[0];
    expect(getEntryKind(latest)).toBe("announcement");
    expect(latest.summary).toBeTruthy();
    expect(latest.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("has unique versions", () => {
    const versions = CHANGELOG.map((e) => e.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("only references bundled preview images", () => {
    for (const e of CHANGELOG) {
      if (e.image) expect(e.image.src).toMatch(/^\/tool-previews\//);
    }
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROFILE_ARCHIVE_LIMIT,
  profileEmptyState,
  profileGridOverflow,
  profileSpotlight,
} from "@/lib/profileView";

const imgs = [
  { id: "a", liked: true },
  { id: "b", liked: false },
  { id: "c", liked: true },
];

describe("profileSpotlight", () => {
  it("prefers pinned, falls back to liked, else none", () => {
    expect(profileSpotlight(imgs, new Set(["b"]))).toEqual({
      images: [imgs[1]],
      source: "pinned",
    });
    expect(profileSpotlight(imgs, new Set(["zz"]))).toEqual({
      images: [imgs[0], imgs[2]],
      source: "liked",
    });
    expect(profileSpotlight([{ id: "x" }], new Set())).toEqual({
      images: [],
      source: "none",
    });
  });
});

describe("profileEmptyState", () => {
  const own = { isViewingOther: false, handle: "@me", archiveCount: 0 };
  const other = { isViewingOther: true, handle: "@pal", archiveCount: 5 };

  it("own spotlight points to Archive once there are images", () => {
    expect(profileEmptyState("spotlight", own).action?.target).toBe("create");
    expect(
      profileEmptyState("spotlight", { ...own, archiveCount: 3 }).action
        ?.target,
    ).toBe("archive");
  });

  it("other people's profiles get no call to action", () => {
    for (const tab of ["spotlight", "archive", "following"] as const) {
      const s = profileEmptyState(tab, other);
      expect(s.action, tab).toBeUndefined();
      expect(s.body, tab).toContain("@pal");
    }
  });

  it("own archive offers to start creating", () => {
    expect(profileEmptyState("archive", own)).toMatchObject({
      title: "No images archived yet",
      action: { target: "create" },
    });
    expect(profileEmptyState("following", own).title).toBe(
      "Not following anyone",
    );
  });
});

describe("profileGridOverflow", () => {
  it("only hints when the grid is capped", () => {
    expect(profileGridOverflow(10, PROFILE_ARCHIVE_LIMIT)).toBeNull();
    expect(profileGridOverflow(60, 60)).toBeNull();
    expect(profileGridOverflow(214, 60)).toBe("Showing 60 of 214");
  });
});

describe("ProfilePage source contracts", () => {
  const src = readFileSync(
    join(__dirname, "../components/ProfilePage.tsx"),
    "utf8",
  );

  it("returns early only after every hook", () => {
    const early = src.indexOf('if (activeNav !== "profile") return null;');
    expect(early).toBeGreaterThan(0);
    const lastHook = Math.max(
      src.lastIndexOf("useCallback("),
      src.lastIndexOf("useEffect("),
      src.lastIndexOf("useState("),
    );
    expect(lastHook).toBeLessThan(early);
  });

  it("uses the shared empty state on every tab", () => {
    for (const tab of ["spotlight", "archive", "following"])
      expect(src).toContain(`state={emptyFor("${tab}")}`);
  });

  it("labels the pin toggle by the action it performs", () => {
    expect(src).not.toMatch(/:\s*"Pinned"\s*\n/);
    expect(src).toContain('"Pin to spotlight"');
  });
});

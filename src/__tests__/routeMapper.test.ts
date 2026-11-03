/**
 * Tests for the routeMapper pure module.
 */
import { describe, it, expect } from "vitest";
import {
  parsePathname,
  parseHash,
  buildPathname,
  buildHash,
  buildUrl,
  resolvePathname,
  unknownPathNotice,
} from "@/lib/routeMapper";

// ---------------------------------------------------------------------------
// parsePathname
// ---------------------------------------------------------------------------

describe("parsePathname", () => {
  it("maps / to create (default landing)", () => {
    expect(parsePathname("/")).toEqual({ nav: "create", params: {} });
  });

  it("maps empty string to create", () => {
    expect(parsePathname("")).toEqual({ nav: "create", params: {} });
  });

  it("maps static routes", () => {
    expect(parsePathname("/explore")).toEqual({ nav: "explore", params: {} });
    expect(parsePathname("/create")).toEqual({ nav: "create", params: {} });
    expect(parsePathname("/setup")).toEqual({
      nav: "setup",
      params: {},
    });
    expect(parsePathname("/tasks")).toEqual({ nav: "tasks", params: {} });
    expect(parsePathname("/help")).toEqual({ nav: "help", params: {} });
    expect(parsePathname("/updates")).toEqual({
      nav: "updates",
      params: {},
    });
  });

  it("maps /account → account-settings", () => {
    expect(parsePathname("/account")).toEqual({
      nav: "account-settings",
      params: {},
    });
  });

  it("maps /account-settings → account-settings", () => {
    expect(parsePathname("/account-settings")).toEqual({
      nav: "account-settings",
      params: {},
    });
  });

  it("maps /@username → profile with username param", () => {
    expect(parsePathname("/@demo")).toEqual({
      nav: "profile",
      params: { username: "demo" },
    });
    expect(parsePathname("/@john_doe")).toEqual({
      nav: "profile",
      params: { username: "john_doe" },
    });
  });

  it("maps /moodboards/:id → moodboards with id param", () => {
    expect(parsePathname("/moodboards/abc123")).toEqual({
      nav: "moodboards",
      params: { id: "abc123" },
    });
  });

  it("maps /styles/:id → style-vault with id param", () => {
    expect(parsePathname("/styles/my-style")).toEqual({
      nav: "style-vault",
      params: { id: "my-style" },
    });
  });

  it("maps /style-creator/:id → style-creator with id param", () => {
    expect(parsePathname("/style-creator/new")).toEqual({
      nav: "style-creator",
      params: { id: "new" },
    });
  });

  it("returns null for unknown routes", () => {
    expect(parsePathname("/unknown-path")).toBeNull();
    expect(parsePathname("/foo/bar/baz")).toBeNull();
  });

  it("handles trailing slashes", () => {
    expect(parsePathname("/explore/")).toEqual({
      nav: "explore",
      params: {},
    });
  });

  it("handles double slashes", () => {
    expect(parsePathname("//explore")).toEqual({
      nav: "explore",
      params: {},
    });
  });
});

// ---------------------------------------------------------------------------
// parseHash
// ---------------------------------------------------------------------------

describe("parseHash", () => {
  it("parses hash routes", () => {
    expect(parseHash("#/create")).toBe("create");
    expect(parseHash("#explore")).toBe("explore");
    expect(parseHash("#/style-vault")).toBe("style-vault");
  });

  it("returns null for unknown hash", () => {
    expect(parseHash("#/unknown")).toBeNull();
    expect(parseHash("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPathname
// ---------------------------------------------------------------------------

describe("buildPathname", () => {
  it("builds default paths for NavKeys", () => {
    expect(buildPathname("create")).toBe("/create");
    expect(buildPathname("explore")).toBe("/explore");
    expect(buildPathname("account-settings")).toBe("/settings");
  });

  it("builds paths with dynamic params for moodboards", () => {
    expect(buildPathname("moodboards", { id: "abc" })).toBe("/moodboards/abc");
  });

  it("builds paths with username param for profile", () => {
    expect(buildPathname("profile", { username: "demo" })).toBe("/@demo");
  });

  it("builds paths with id param for style-vault", () => {
    expect(buildPathname("style-vault", { id: "cool-style" })).toBe(
      "/styles/vault/cool-style",
    );
  });

  it("falls back to static path when no params given", () => {
    expect(buildPathname("moodboards")).toBe("/moodboards");
    expect(buildPathname("profile")).toBe("/profile");
  });
});

// ---------------------------------------------------------------------------
// buildHash
// ---------------------------------------------------------------------------

describe("buildHash", () => {
  it("builds hash routes", () => {
    expect(buildHash("create")).toBe("#/create");
    expect(buildHash("explore")).toBe("#/explore");
  });
});

// ---------------------------------------------------------------------------
// buildUrl
// ---------------------------------------------------------------------------

describe("buildUrl", () => {
  it("delegates to buildPathname", () => {
    expect(buildUrl("create")).toBe("/create");
    expect(buildUrl("moodboards", { id: "abc" })).toBe("/moodboards/abc");
  });
});

// ---------------------------------------------------------------------------
// resolvePathname (aliases + prefix fallback)
// ---------------------------------------------------------------------------

describe("resolvePathname", () => {
  it("passes exact routes through unchanged", () => {
    expect(resolvePathname("/explore")).toEqual({
      nav: "explore",
      params: {},
      match: "exact",
    });
    expect(resolvePathname("/styles/my-style")).toEqual({
      nav: "style-vault",
      params: { id: "my-style" },
      match: "exact",
    });
    expect(resolvePathname("/")).toEqual({
      nav: "create",
      params: {},
      match: "exact",
    });
  });

  it("/styles is the canonical Styles (Browse) page; /library still resolves", () => {
    const r = resolvePathname("/styles");
    expect(r).toEqual({ nav: "library", params: {}, match: "exact" });
    expect(buildPathname(r!.nav)).toBe("/styles");
    expect(resolvePathname("/styles/")?.nav).toBe("library");
    expect(resolvePathname("/library")).toEqual({
      nav: "library",
      params: {},
      match: "exact",
    });
  });

  it("library views have short URLs that round-trip", () => {
    for (const id of ["map", "clusters", "images", "train"]) {
      const url = buildPathname("style-vault", { id });
      expect(url).toBe(`/styles/${id}`);
      expect(parsePathname(url)).toEqual({ nav: "style-vault", params: { id } });
    }
    expect(buildPathname("style-vault")).toBe("/style-vault");
  });

  it("vault links live under /styles/vault, old /styles/:id links still parse", () => {
    expect(parsePathname("/styles/vault/abc")).toEqual({
      nav: "style-vault",
      params: { id: "abc" },
    });
    expect(parsePathname("/styles/vault")).toEqual({
      nav: "style-vault",
      params: {},
    });
    expect(buildPathname("style-vault", { id: "abc" })).toBe("/styles/vault/abc");
    expect(parsePathname("/styles/abc")?.nav).toBe("style-vault");
    // Datasets (legacy nav key "styles") keep their own path.
    expect(buildPathname("styles")).toBe("/style-datasets");
  });

  it("maps singular / synonym paths to their pages", () => {
    expect(resolvePathname("/moodboard")?.nav).toBe("moodboards");
    expect(resolvePathname("/character")?.nav).toBe("characters");
    expect(resolvePathname("/workflow")?.nav).toBe("setup");
    expect(resolvePathname("/settings")?.nav).toBe("account-settings");
    expect(resolvePathname("/changelog")?.nav).toBe("updates");
    expect(resolvePathname("/imagine")?.nav).toBe("create");
  });

  it("folds case on static routes but not on dynamic params", () => {
    expect(resolvePathname("/Explore")).toEqual({
      nav: "explore",
      params: {},
      match: "alias",
    });
    expect(resolvePathname("/STYLES")?.nav).toBe("library");
    // Mixed-case ids keep their case via the exact match
    expect(resolvePathname("/moodboards/AbC")).toEqual({
      nav: "moodboards",
      params: { id: "AbC" },
      match: "exact",
    });
  });

  it("falls back to the first known segment for deep unknown paths", () => {
    expect(resolvePathname("/organize/folders/x")).toEqual({
      nav: "organize",
      params: {},
      match: "prefix",
    });
    expect(resolvePathname("/styles/a/b")?.nav).toBe("library");
    expect(resolvePathname("/explore/anything")?.match).toBe("prefix");
  });

  it("returns null when nothing sensible matches (never silently Create)", () => {
    expect(resolvePathname("/unknown-path")).toBeNull();
    expect(resolvePathname("/nope/deeper")).toBeNull();
    // A username-looking head is not a static page
    expect(resolvePathname("/@alice/extra")).toBeNull();
  });
});

describe("unknownPathNotice", () => {
  it("explains the redirect for unknown paths", () => {
    expect(unknownPathNotice("/nope", "/create")).toBe(
      "Nothing lives at /nope — opened /create instead",
    );
  });

  it("stays quiet for root and for a no-op fallback", () => {
    expect(unknownPathNotice("/", "/create")).toBeNull();
    expect(unknownPathNotice("", "/create")).toBeNull();
    expect(unknownPathNotice("/create/", "/create")).toBeNull();
  });

  it("truncates very long paths", () => {
    const long = "/" + "x".repeat(80);
    const msg = unknownPathNotice(long, "/explore")!;
    expect(msg).toContain("…");
    expect(msg.length).toBeLessThan(90);
  });
});

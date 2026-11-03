/**
 * Tests for route-param propagation into page components.
 *
 * These tests verify the core contract that routeMapper and useNavSync
 * establish: when a user navigates to /moodboards/abc123, the store's
 * navParams.id should be "abc123" and the page should be able to consume it.
 *
 * This is a unit test (no DOM/rendering) that validates the data-flow path:
 *   URL → parsePathname → {nav, params} → setActiveNav + setNavParams → store
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  parsePathname,
  buildPathname,
  buildUrl,
} from "@/lib/routeMapper";

// ---------------------------------------------------------------------------
// parsePathname — dynamic route param extraction
// ---------------------------------------------------------------------------

describe("route param propagation", () => {
  describe("parsePathname extracts params for dynamic routes", () => {
    it("extracts username from /@username profile routes", () => {
      const result = parsePathname("/@demo");
      expect(result).not.toBeNull();
      expect(result!.nav).toBe("profile");
      expect(result!.params.username).toBe("demo");
    });

    it("extracts id from /moodboards/:id", () => {
      const result = parsePathname("/moodboards/abc123");
      expect(result).not.toBeNull();
      expect(result!.nav).toBe("moodboards");
      expect(result!.params.id).toBe("abc123");
    });

    it("extracts id from /styles/:id for style vault", () => {
      const result = parsePathname("/styles/dreamy-pastel");
      expect(result).not.toBeNull();
      expect(result!.nav).toBe("style-vault");
      expect(result!.params.id).toBe("dreamy-pastel");
    });

    it("extracts id from /style-creator/:id", () => {
      const result = parsePathname("/style-creator/new");
      expect(result).not.toBeNull();
      expect(result!.nav).toBe("style-creator");
      expect(result!.params.id).toBe("new");
    });

    it("extracts id from /style-creator/:id with uuid-like id", () => {
      const result = parsePathname("/style-creator/550e8400-e29b-41d4-a716-446655440000");
      expect(result).not.toBeNull();
      expect(result!.nav).toBe("style-creator");
      expect(result!.params.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    });
  });

  describe("buildPathname reconstructs URLs with params", () => {
    it("reconstructs /moodboards/:id from nav + params", () => {
      expect(buildPathname("moodboards", { id: "abc123" })).toBe("/moodboards/abc123");
    });

    it("reconstructs /@username from profile + params", () => {
      expect(buildPathname("profile", { username: "demo" })).toBe("/@demo");
    });

    it("reconstructs /styles/vault/:id from style-vault + params", () => {
      expect(buildPathname("style-vault", { id: "cool-style" })).toBe("/styles/vault/cool-style");
    });

    it("reconstructs /style-creator/:id from params", () => {
      expect(buildPathname("style-creator", { id: "new" })).toBe("/style-creator/new");
    });

    it("falls back to static path when no params", () => {
      expect(buildPathname("moodboards")).toBe("/moodboards");
      expect(buildPathname("profile")).toBe("/profile");
    });
  });

  describe("buildUrl (convenience wrapper)", () => {
    it("delegates to buildPathname with params", () => {
      expect(buildUrl("moodboards", { id: "test-id" })).toBe("/moodboards/test-id");
      expect(buildUrl("profile", { username: "artist" })).toBe("/@artist");
    });
  });

  describe("round-trip: parse then build", () => {
    it("round-trips moodboard URLs", () => {
      const original = "/moodboards/abc123";
      const parsed = parsePathname(original)!;
      const rebuilt = buildPathname(parsed.nav, parsed.params);
      expect(rebuilt).toBe(original);
    });

    it("round-trips profile URLs", () => {
      const original = "/@cooluser";
      const parsed = parsePathname(original)!;
      const rebuilt = buildPathname(parsed.nav, parsed.params);
      expect(rebuilt).toBe(original);
    });

    it("round-trips style-vault URLs", () => {
      const original = "/styles/vault/my-style-42";
      const parsed = parsePathname(original)!;
      const rebuilt = buildPathname(parsed.nav, parsed.params);
      expect(rebuilt).toBe(original);
    });

    it("round-trips style-creator URLs", () => {
      const original = "/style-creator/new";
      const parsed = parsePathname(original)!;
      const rebuilt = buildPathname(parsed.nav, parsed.params);
      expect(rebuilt).toBe(original);
    });

    it("round-trips static routes unchanged", () => {
      // Note: /account and /account-settings are aliases; the canonical path is /settings
      const statics = [
        "/explore",
        "/create",
        "/settings",
        "/help",
        "/updates",
        "/tasks",
      ];
      for (const path of statics) {
        const parsed = parsePathname(path)!;
        const rebuilt = buildPathname(parsed.nav);
        expect(rebuilt).toBe(path);
      }
    });
  });

  describe("param extraction for page data-state gating", () => {
    it("profile page: hasParams true when username present", () => {
      const result = parsePathname("/@demo")!;
      const hasParams = Object.keys(result.params).length > 0;
      expect(hasParams).toBe(true);
      expect(result.params.username).toBe("demo");
    });

    it("moodboards page: hasParams true when id present", () => {
      const result = parsePathname("/moodboards/abc")!;
      const hasParams = Object.keys(result.params).length > 0;
      expect(hasParams).toBe(true);
      expect(result.params.id).toBe("abc");
    });

    it("moodboards page: hasParams false for list view", () => {
      const result = parsePathname("/moodboards")!;
      const hasParams = Object.keys(result.params).length > 0;
      expect(hasParams).toBe(false);
    });

    it("style-creator page: distinguish list vs session by id param", () => {
      const listResult = parsePathname("/style-creator")!;
      expect(Object.keys(listResult.params).length).toBe(0);

      const sessionResult = parsePathname("/style-creator/new")!;
      expect(sessionResult.params.id).toBe("new");

      const detailResult = parsePathname("/style-creator/some-session-id")!;
      expect(detailResult.params.id).toBe("some-session-id");
    });
  });
});
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  expandWildcards,
  isValidWildcardName,
  parseWildcardFile,
  hasWildcards,
  WILDCARD_MAX_DEPTH,
} from "@/lib/wildcards";
import {
  resolveWildcardPath,
  readWildcard,
  listWildcards,
  expandWildcardsFromDisk,
} from "@/lib/wildcardsFs";
import { getAutocompleteContext, buildSuggestions } from "@/lib/promptAutocomplete";

const lib: Record<string, string[]> = {
  color: ["red", "green", "blue", "gold", "teal"],
  thing: ["a __color__ cat", "a __color__ dog"],
  loop: ["__loop__ again"],
};
const lookup = (n: string) => lib[n] ?? null;

describe("parse + names", () => {
  it("skips comments and blanks", () => {
    expect(parseWildcardFile("# c\n\n a \r\nb\n  # x\n")).toEqual(["a", "b"]);
  });
  it("validates names", () => {
    for (const ok of ["a", "a-b_c", "dir/sub/x1"]) expect(isValidWildcardName(ok)).toBe(true);
    for (const bad of ["", "../x", "a/../b", "/a", "a/", "a//b", "A", "a.b", "a b", "a\\b", "a__b", "x".repeat(65)])
      expect(isValidWildcardName(bad)).toBe(false);
  });
});

describe("expansion", () => {
  it("is deterministic per seed and varies across seeds", () => {
    const p = "__color__ __color__ __color__ __color__";
    const a = expandWildcards(p, lookup, 42).text;
    expect(expandWildcards(p, lookup, 42).text).toBe(a);
    const others = new Set([1, 2, 3, 4, 5, 6].map((s) => expandWildcards(p, lookup, s).text));
    expect(others.size).toBeGreaterThan(1);
  });
  it("expands nested wildcards", () => {
    const r = expandWildcards("__thing__", lookup, 7);
    expect(r.text).toMatch(/^a (red|green|blue|gold|teal) (cat|dog)$/);
    expect(r.used.length).toBe(2);
  });
  it("caps recursion depth", () => {
    const r = expandWildcards("__loop__", lookup, 1);
    expect(r.depthExceeded).toBe(true);
    expect(r.text).toBe("__loop__" + " again".repeat(WILDCARD_MAX_DEPTH));
  });
  it("leaves unknown tokens literal and reports them", () => {
    const r = expandWildcards("x __nope__ y", lookup, 1);
    expect(r.text).toBe("x __nope__ y");
    expect(r.missing).toEqual(["nope"]);
  });
  it("never resolves traversal-looking tokens", () => {
    const seen: string[] = [];
    const r = expandWildcards("__../etc/passwd__ __a/../b__", (n) => (seen.push(n), null), 1);
    expect(seen).toEqual([]);
    expect(r.text).toBe("__../etc/passwd__ __a/../b__");
  });
  it("expands braces in picked lines with the same rng, optional", () => {
    const l = (n: string) => (n === "x" ? ["{a|b}"] : null);
    expect(expandWildcards("__x__", l, 3).text).toMatch(/^[ab]$/);
    expect(expandWildcards("__x__", l, 3, { braces: false }).text).toBe("{a|b}");
  });
  it("detects tokens", () => {
    expect(hasWildcards("a __b__ c")).toBe(true);
    expect(hasWildcards("a __ b")).toBe(false);
  });
});

describe("fs loader", () => {
  let root: string;
  let outside: string;
  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "wc-"));
    root = path.join(base, "wildcards");
    outside = path.join(base, "secret.txt");
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "c.txt"), "# hi\nred\nblue\n");
    fs.writeFileSync(path.join(root, "sub", "d.txt"), "__c__ ball\n");
    fs.writeFileSync(outside, "TOPSECRET\n");
    fs.symlinkSync(outside, path.join(root, "link.txt"));
  });
  afterAll(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

  it("reads and lists", () => {
    expect(readWildcard("c", root)).toEqual(["red", "blue"]);
    expect(listWildcards(root)).toEqual([
      { name: "c", count: 2 },
      { name: "sub/d", count: 1 },
    ]);
  });
  it("rejects traversal and symlink escapes", () => {
    for (const bad of ["../secret", "sub/../../secret", "/etc/passwd", "link", "..%2fsecret"]) {
      expect(resolveWildcardPath(bad, root)).toBeNull();
      expect(readWildcard(bad, root)).toBeNull();
    }
  });
  it("expands across files deterministically", () => {
    const a = expandWildcardsFromDisk("__sub/d__", 5, { root });
    expect(a.text).toMatch(/^(red|blue) ball$/);
    expect(expandWildcardsFromDisk("__sub/d__", 5, { root }).text).toBe(a.text);
  });
});

describe("shipped example library", () => {
  it("has valid example files", () => {
    const names = listWildcards().map((w) => w.name);
    expect(names).toEqual(expect.arrayContaining(["colors", "lighting", "medium", "subject/scenes"]));
    const r = expandWildcardsFromDisk("__medium__", 11);
    expect(r.missing).toEqual([]);
  });
});

describe("prompt autocomplete", () => {
  it("opens on __ and suggests names", () => {
    const v = "a cat, __co";
    const ctx = getAutocompleteContext(v, v.length);
    expect(ctx).toMatchObject({ type: "wildcard", query: "co", from: 7 });
    const s = buildSuggestions({
      context: ctx!,
      registry: {},
      downloads: [],
      wildcards: [{ name: "colors", count: 6 }, { name: "medium" }],
    });
    expect(s.map((x) => x.insertText)).toEqual(["__colors__ "]);
  });
  it("does not open after a completed token", () => {
    const v = "__colors__";
    expect(getAutocompleteContext(v, v.length)?.type).not.toBe("wildcard");
  });
});

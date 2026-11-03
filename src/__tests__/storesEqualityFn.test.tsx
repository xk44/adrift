import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { shallow } from "zustand/shallow";
import { useGenerationStore } from "@/store";

const STORE_DIR = path.join(process.cwd(), "src/store");
// styleStore.ts is owned by the Styles lane and migrates separately.
const SKIP = new Set(["styleStore.ts"]);

describe("zustand stores use createWithEqualityFn", () => {
  it("no store in src/store binds hooks with plain create()", () => {
    const offenders = readdirSync(STORE_DIR)
      .filter((f) => f.endsWith(".ts") && !SKIP.has(f))
      .filter((f) => {
        const src = readFileSync(path.join(STORE_DIR, f), "utf8");
        return /import\s*\{[^}]*\bcreate\b[^}]*\}\s*from\s*"zustand"/.test(src);
      });
    expect(offenders).toEqual([]);
  });

  it("selector + shallow equality does not log the zustand deprecation", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    function Probe() {
      const runs = useGenerationStore((s) => s.runs, shallow);
      return createElement("span", null, String(Array.isArray(runs) || !!runs));
    }
    renderToStaticMarkup(createElement(Probe));
    const deprecations = warn.mock.calls.filter((c) =>
      String(c[0]).includes("createWithEqualityFn"),
    );
    warn.mockRestore();
    expect(deprecations).toEqual([]);
  });
});

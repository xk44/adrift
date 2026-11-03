import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ParamReference, buildGroups } from "@/components/ParamReference";
import registry from "@/lib/oj/registry.json";

type RegistryParam = { flags?: string[]; hidden?: boolean };
const params = (
  registry as unknown as { params: Record<string, RegistryParam> }
).params;

describe("ParamReference", () => {
  it("buildGroups covers every registry param with flags", () => {
    const groups = buildGroups();
    const listed = new Set(groups.flatMap((g) => g.rows.map((r) => r.name)));
    for (const [name, param] of Object.entries(params)) {
      if (!param.flags?.length || param.hidden) continue;
      expect(listed.has(name), `param ${name} missing from reference`).toBe(
        true,
      );
    }
  });

  it("hidden (reserved) params are not listed", () => {
    const listed = new Set(
      buildGroups().flatMap((g) => g.rows.map((r) => r.name)),
    );
    expect(params.weird?.hidden).toBe(true);
    expect(listed.has("weird")).toBe(false);
    expect(listed.has("speedTier")).toBe(true);
  });

  it("no param is listed twice", () => {
    const names = buildGroups().flatMap((g) => g.rows.map((r) => r.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it("rows carry flags, a value hint, and a description", () => {
    for (const group of buildGroups()) {
      for (const row of group.rows) {
        expect(row.flags.length).toBeGreaterThan(0);
        expect(row.flags[0].startsWith("--")).toBe(true);
        expect(row.valueHint.length).toBeGreaterThan(0);
        expect(row.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("renders every primary flag and the total count", () => {
    const html = renderToStaticMarkup(<ParamReference />);
    const total = Object.values(params).filter(
      (p) => p.flags?.length && !p.hidden,
    ).length;
    expect(html).toContain(`All ${total} built-in prompt codes`);
    for (const param of Object.values(params)) {
      if (param.hidden) continue;
      const flag = param.flags?.[0];
      if (flag) expect(html).toContain(flag);
    }
  });
});

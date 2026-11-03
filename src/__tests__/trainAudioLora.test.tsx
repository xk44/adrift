import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseStoredRun } from "@/components/tools/TrainAudioLora";

const src = readFileSync(
  join(process.cwd(), "src/components/tools/TrainAudioLora.tsx"),
  "utf8",
);

describe("TrainAudioLora stored run", () => {
  it("round-trips base / adapter / preset", () => {
    const r = parseStoredRun(
      JSON.stringify({
        promptId: "p1",
        clientId: "c1",
        name: "dusty_drums",
        base: "small-sfx-base",
        adapter: "dora-rows",
        preset: "detailed",
      }),
    );
    expect(r).toEqual({
      promptId: "p1",
      clientId: "c1",
      name: "dusty_drums",
      base: "small-sfx-base",
      adapter: "dora-rows",
      preset: "detailed",
    });
  });

  it("still resumes an older run saved without settings", () => {
    const r = parseStoredRun(
      JSON.stringify({ promptId: "p1", clientId: "c1", name: "x" }),
    );
    expect(r?.promptId).toBe("p1");
    expect(r?.base).toBeUndefined();
  });

  it("drops unknown values and rejects junk", () => {
    const r = parseStoredRun(
      JSON.stringify({ promptId: "p", clientId: "c", name: "n", base: "huge" }),
    );
    expect(r?.base).toBeUndefined();
    expect(parseStoredRun(null)).toBeNull();
    expect(parseStoredRun("{")).toBeNull();
    expect(parseStoredRun(JSON.stringify({ name: "no id" }))).toBeNull();
  });

  it("saves the settings the run was started with", () => {
    expect(src).toMatch(
      /const r: ActiveRun = \{ \.\.\.started, name, base, adapter, preset \};/,
    );
    expect(src).toMatch(/if \(pending\.base\) setBase\(pending\.base\);/);
  });
});

describe("TrainAudioLora stop button", () => {
  it("labels the upload phase 'Cancel upload', not 'Stop training'", () => {
    expect(src).toMatch(/busy && !run && \([\s\S]*?Cancel upload/);
  });

  it("asks before stopping a training run", () => {
    expect(src).toMatch(/onClick=\{\(\) => setConfirmStop\(true\)\}/);
    expect(src).toMatch(/Yes, stop training/);
    expect(src).toMatch(/Keep training/);
  });
});

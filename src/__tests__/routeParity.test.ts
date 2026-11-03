/**
 * Route parity helpers: seeded wildcard expansion shared by imagine/action/
 * inpaint/tool, and extractOutputs-based job media for the action route.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  expandPromptWildcards,
  wildcardParams,
} from "@/lib/wildcardsFs";
import { jobMediaFromHistory } from "@/lib/comfy/outputs";

describe("expandPromptWildcards", () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "wcp-"));
    fs.writeFileSync(
      path.join(root, "c.txt"),
      Array.from({ length: 40 }, (_, i) => `color${i}`).join("\n"),
    );
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("passes prompts without wildcard tokens through untouched", () => {
    expect(expandPromptWildcards("a cat {x,y}", { root })).toEqual({
      text: "a cat {x,y}",
    });
  });

  it("is reproducible from the seed and reports info", () => {
    const a = expandPromptWildcards("a __c__ cat", { seed: 7, root });
    const b = expandPromptWildcards("a __c__ cat", { seed: 7, root });
    expect(a.text).toBe(b.text);
    expect(a.text).toMatch(/^a color\d+ cat$/);
    expect(a.info).toEqual({
      original: "a __c__ cat",
      seed: 7,
      used: ["c"],
      missing: [],
    });
    expect(wildcardParams(a.info!)).toEqual({
      original: "a __c__ cat",
      seed: 7,
      used: ["c"],
    });
  });

  it("explicit seed beats --seed, which beats random", () => {
    const fromFlag = expandPromptWildcards("__c__ --seed 123", { root });
    expect(fromFlag.info?.seed).toBe(123);
    const explicit = expandPromptWildcards("__c__ --seed 123", {
      seed: 99,
      root,
    });
    expect(explicit.info?.seed).toBe(99);
    const random = expandPromptWildcards("__c__", { root });
    expect(random.info?.seed).toBeGreaterThanOrEqual(0);
    expect(random.info?.seed).toBeLessThan(4294967296);
  });

  it("keeps {a,b} for --grid prompts, resolves it otherwise", () => {
    const grid = expandPromptWildcards("__c__ {a,b} --grid", { seed: 1, root });
    expect(grid.text).toContain("{a,b}");
    const plain = expandPromptWildcards("__c__ {a,b}", { seed: 1, root });
    expect(plain.text).not.toContain("{a,b}");
  });

  it("records missing names and leaves them literal", () => {
    const r = expandPromptWildcards("__nope__ dog", { seed: 1, root });
    expect(r.text).toContain("__nope__");
    expect(r.info?.missing).toEqual(["nope"]);
  });
});

describe("jobMediaFromHistory", () => {
  const entry = {
    outputs: {
      "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
      "10": {
        gifs: [
          { filename: "clip.mp4", subfolder: "vid", type: "output", format: "video/h264-mp4" },
          { filename: "loop.gif", subfolder: "", type: "output", format: "image/gif" },
        ],
      },
      "11": { audio: [{ filename: "s.flac", subfolder: "", type: "output" }] },
      "12": { "3d": [{ filename: "m.glb", subfolder: "3d", type: "output" }] },
      "13": { text: ["a caption"] },
      "14": { samples: [{ x: 1 }] },
    },
  };

  it("buckets image/gif/video/audio/mesh/text and skips unknown payloads", () => {
    const m = jobMediaFromHistory(entry, (q) => `http://c:8188/view?${q}`);
    expect(m.images).toEqual([
      "http://c:8188/view?filename=a.png&subfolder=&type=output",
      "http://c:8188/view?filename=loop.gif&subfolder=&type=output",
    ]);
    expect(m.videos).toEqual([
      "http://c:8188/view?filename=clip.mp4&subfolder=vid&type=output",
    ]);
    expect(m.audios).toHaveLength(1);
    expect(m.meshes).toEqual([
      "http://c:8188/view?filename=m.glb&subfolder=3d&type=output",
    ]);
    expect(m.texts).toEqual(["a caption"]);
  });

  it("defaults to the app image proxy", () => {
    expect(jobMediaFromHistory(entry).images[0]).toBe(
      "/api/comfy/image?filename=a.png&subfolder=&type=output",
    );
  });
});

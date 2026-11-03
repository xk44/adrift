import { describe, expect, it } from "vitest";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPlan,
  checkDisk,
  filterPlan,
  formatPlan,
  hfUrl,
  main,
  mergeSameSource,
  packTool,
  parseArgs,
  resolveTool,
  resolveTools,
  safeRel,
  skipPlan,
  totals,
  validateList,
} from "../../scripts/fetch-models.mjs";

const REV_A = "a".repeat(40);
const REV_B = "b".repeat(40);

const LIST = {
  files: [
    {
      set: "minimal",
      repo: "org/video",
      path: "split/dm/video.safetensors",
      revision: REV_A,
      size: 1000,
      dest: "diffusion_models/video.safetensors",
    },
    {
      set: "minimal",
      repo: "org/video",
      path: "split/vae/vae.safetensors",
      revision: REV_A,
      size: 200,
      dest: "vae/split/vae/vae.safetensors",
      also: ["vae/vae.safetensors"],
    },
    {
      set: "full",
      repo: "org/lora",
      path: "[v2]motion.safetensors",
      revision: REV_B,
      size: 50,
      dest: "loras/motion/motion.safetensors",
    },
    {
      set: "full",
      repo: "org/tts",
      path: "config.json",
      revision: REV_B,
      size: 3,
      dest: "tts/voice/model-a/config.json",
    },
    {
      set: "full",
      repo: "org/tts",
      path: "model.safetensors",
      revision: REV_B,
      size: 70,
      dest: "tts/voice/model-a/model.safetensors",
    },
  ],
  other: [
    {
      dest: "upscale_models/up.pth",
      size: 60,
      license: "BSD-3-Clause",
      page: "https://github.com/o/r/releases/tag/v1",
    },
  ],
  convert: [
    {
      repo: "org/conv",
      path: "w.safetensors",
      revision: REV_A,
      size: 80,
      dest: "loras/edit_tools/conv.safetensors",
      converter: "scripts/convert.py",
    },
  ],
};

const TOOLS = {
  tools: [
    {
      id: "animate",
      kind: "action",
      title: "Animate",
      category: "Video",
      files: [
        "diffusion_models/video.safetensors",
        "vae/vae.safetensors",
        "loras/motion/motion.safetensors",
        "text_encoders/missing.safetensors",
      ],
    },
    {
      id: "voice",
      kind: "pipeline",
      title: "Voiceover",
      category: "Audio",
      files: [],
      dirs: ["tts/voice/model-a/", "stt/none/"],
    },
    {
      id: "voice",
      kind: "catalog",
      title: "Voice LoRA",
      category: "Edit",
      files: ["loras/edit_tools/conv.safetensors"],
    },
    {
      id: "upscale",
      kind: "action",
      title: "Upscale",
      category: "Enhance",
      files: ["upscale_models/up.pth"],
    },
  ],
};

describe("parseArgs", () => {
  it("defaults to a dry run with no set chosen", () => {
    expect(parseArgs([])).toMatchObject({
      comfy: null,
      tool: null,
      set: null,
      yes: false,
      dryRun: false,
    });
  });

  it("reads valued flags in both --flag value and --flag=value form", () => {
    expect(
      parseArgs(["--comfy", "/c", "--tool=animate", "--set", "full", "--yes"]),
    ).toMatchObject({
      comfy: "/c",
      tool: "animate",
      set: "full",
      yes: true,
    });
  });

  it("lets --dry-run win over --yes", () => {
    const o = parseArgs(["--comfy", "/c", "--yes", "--dry-run"]);
    expect(o.yes).toBe(false);
    expect(o.dryRun).toBe(true);
  });

  it("rejects bad input", () => {
    expect(() => parseArgs(["--set", "huge"])).toThrow(/minimal or full/);
    expect(() => parseArgs(["--tool"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--comfy", "--yes"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--frobnicate"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--yes=1"])).toThrow(/takes no value/);
    expect(() => parseArgs(["--yes"])).toThrow(/needs --comfy/);
  });
});

describe("validateList", () => {
  it("accepts the fixture and rejects unsafe rows", () => {
    expect(validateList(LIST)).toBe(LIST);
    const bad = (patch) => ({ files: [{ ...LIST.files[0], ...patch }] });
    expect(() => validateList(bad({ dest: "../escape.safetensors" }))).toThrow(
      /unsafe/,
    );
    expect(() => validateList(bad({ dest: "/abs.safetensors" }))).toThrow(
      /unsafe/,
    );
    expect(() => validateList(bad({ also: ["a/../../b"] }))).toThrow(/unsafe/);
    expect(() => validateList(bad({ revision: "main" }))).toThrow(/revision/);
    expect(() => validateList(bad({ size: 0 }))).toThrow(/size/);
    expect(() => validateList(bad({ repo: "noslash" }))).toThrow(/repo/);
    expect(safeRel("loras/a.safetensors")).toBe(true);
    expect(safeRel("loras//a")).toBe(false);
  });

  it("builds pinned, encoded Hugging Face URLs", () => {
    expect(hfUrl(LIST.files[2])).toBe(
      `https://huggingface.co/org/lora/resolve/${REV_B}/%5Bv2%5Dmotion.safetensors`,
    );
  });
});

describe("mergeSameSource", () => {
  const vae = LIST.files[1];

  it("folds rows for the same pinned file into one row with links", () => {
    const doc = mergeSameSource({
      files: [
        { ...vae, set: "full", also: [] },
        LIST.files[0],
        { ...vae, dest: "vae/copy.safetensors", also: ["vae/vae.safetensors"] },
      ],
    });
    expect(doc.files).toHaveLength(2);
    expect(doc.files[0]).toMatchObject({
      dest: vae.dest,
      set: "minimal",
      also: ["vae/copy.safetensors", "vae/vae.safetensors"],
    });
    expect(buildPlan(doc).items.map((r) => r.dest)).toEqual([
      vae.dest,
      "diffusion_models/video.safetensors",
    ]);
  });

  it("keeps other revisions apart and rejects a size disagreement", () => {
    const other = { ...vae, revision: REV_B, dest: "vae/old.safetensors" };
    expect(mergeSameSource({ files: [vae, other] }).files).toHaveLength(2);
    expect(() =>
      mergeSameSource({ files: [vae, { ...vae, dest: "vae/x", size: 201 }] }),
    ).toThrow(/two sizes/);
  });
});

describe("resolveTool", () => {
  it("finds by id or kind:id and reports ambiguity", () => {
    expect(resolveTool(TOOLS, "animate").title).toBe("Animate");
    expect(resolveTool(TOOLS, "catalog:voice").title).toBe("Voice LoRA");
    expect(() => resolveTool(TOOLS, "voice")).toThrow(
      /ambiguous.*pipeline:voice.*catalog:voice/,
    );
    expect(() => resolveTool(TOOLS, "anim")).toThrow(/did you mean: animate/);
    expect(() => resolveTool(TOOLS, "zzz")).toThrow(/--list-tools/);
  });
});

describe("folder hand downloads", () => {
  const doc = {
    files: [],
    other: [{ dest: "SeeThrough/x/", size: 5, page: "https://example.test" }],
  };
  it("the list may name a folder, but not an unsafe one", () => {
    expect(validateList(doc)).toBe(doc);
    expect(() =>
      validateList({ files: [], other: [{ dest: "../x/" }] }),
    ).toThrow(/unsafe/);
  });
  it("a tool that loads the folder lists it by hand, not as unlisted", () => {
    const p = buildPlan(doc, {
      tool: { kind: "action", id: "t", files: [], dirs: ["SeeThrough/x/"] },
    });
    expect(p.other.map((o) => o.dest)).toEqual(["SeeThrough/x/"]);
    expect(p.unlisted).toEqual([]);
  });
});

// The published repo carries the generated list: a row the validator rejects
// stops every download, and nothing else would notice.
const SHIPPED = path.resolve("models/download-list.json");
describe.runIf(fs.existsSync(SHIPPED))("the shipped download list", () => {
  it("passes the script's own validation and merges", () => {
    const doc = JSON.parse(readFileSync(SHIPPED, "utf8"));
    expect(mergeSameSource(validateList(doc)).files.length).toBeGreaterThan(0);
  });
});

describe("resolveTools", () => {
  it("one id stays that tool; several become one, each file once", () => {
    expect(resolveTools(TOOLS, "animate")).toBe(resolveTool(TOOLS, "animate"));
    const a = resolveTool(TOOLS, "animate");
    const v = resolveTool(TOOLS, "catalog:voice");
    const both = resolveTools(TOOLS, "animate,catalog:voice");
    expect(both.files).toEqual([...new Set([...a.files, ...v.files])]);
    expect(both.dirs).toEqual([...new Set([...(a.dirs ?? []), ...(v.dirs ?? [])])]);
    expect(buildPlan(LIST, { tool: both }).set).toBe("full");
    expect(() => resolveTools(TOOLS, "animate,zzz")).toThrow(/--list-tools/);
    expect(() => resolveTools(TOOLS, " , ")).toThrow(/at least one/);
  });
});

describe("skipPlan", () => {
  const plan = {
    items: [
      { dest: "a/one", also: ["a/alias"] },
      { dest: "a/two" },
      { dest: "dir/three" },
    ],
    other: [{ dest: "o/x" }],
    convert: [],
    unlisted: ["u/y"],
  };
  const dests = (p) => p.items.map((r) => r.dest);

  it("parses a repeatable --skip", () => {
    expect(parseArgs(["--skip", "a/two", "--skip=o/x"]).skip).toEqual(["a/two", "o/x"]);
  });
  it("drops the named files, ignoring paths it doesn't have", () => {
    const p = skipPlan(plan, ["a/two", "o/x", "u/y", "nope"]);
    expect(dests(p)).toEqual(["a/one", "dir/three"]);
    expect(p.other).toEqual([]);
    expect(p.unlisted).toEqual([]);
  });
  it("without --skip nothing changes", () => {
    expect(skipPlan(plan, [])).toBe(plan);
  });
  it("skipping one path of a file drops it unless the tool loads the other", () => {
    expect(dests(skipPlan(plan, ["a/alias"], ["a/alias", "a/two"]))).not.toContain("a/one");
    expect(dests(skipPlan(plan, ["a/alias"], ["a/alias", "a/one"]))).toContain("a/one");
    expect(dests(skipPlan(plan, ["a/alias"]))).toContain("a/one");
  });
  it("keeps by-folder rows the tool doesn't name", () => {
    expect(dests(skipPlan(plan, ["a/two"], ["a/two"]))).toContain("dir/three");
  });
});

describe("buildPlan", () => {
  it("defaults to the minimal set; full adds the rest", () => {
    const min = buildPlan(LIST);
    expect(min.set).toBe("minimal");
    expect(min.items.map((r) => r.dest)).toEqual([
      "diffusion_models/video.safetensors",
      "vae/split/vae/vae.safetensors",
    ]);
    expect(min.other).toHaveLength(1);
    expect(min.skipped).toBe(3);
    expect(buildPlan(LIST, { set: "full" }).items).toHaveLength(5);
  });

  it("resolves a tool's files, including 'also' destinations and by-name folders", () => {
    const p = buildPlan(LIST, { tool: resolveTool(TOOLS, "animate") });
    expect(p.set).toBe("full");
    expect(p.tool).toBe("action:animate");
    expect(p.items.map((r) => r.dest)).toEqual([
      "diffusion_models/video.safetensors",
      "vae/split/vae/vae.safetensors",
      "loras/motion/motion.safetensors",
    ]);
    expect(p.unlisted).toEqual(["text_encoders/missing.safetensors"]);
    const pMin = buildPlan(LIST, { tool: TOOLS.tools[0], set: "minimal" });
    expect(pMin.items).toHaveLength(2);
    expect(pMin.skipped).toBe(1);
    expect(formatPlan(pMin, checkDisk(pMin, null))).toContain(
      "1 more file(s) are in the full set",
    );

    const v = buildPlan(LIST, { tool: resolveTool(TOOLS, "pipeline:voice") });
    expect(v.items.map((r) => r.dest)).toEqual([
      "tts/voice/model-a/config.json",
      "tts/voice/model-a/model.safetensors",
    ]);
    expect(v.unlisted).toEqual(["stt/none/"]);
  });

  it("routes non-HF and convert files to the manual sections for their tool only", () => {
    const up = buildPlan(LIST, { tool: resolveTool(TOOLS, "upscale") });
    expect(up.items).toEqual([]);
    expect(up.other.map((o) => o.dest)).toEqual(["upscale_models/up.pth"]);
    expect(up.unlisted).toEqual([]);
    const conv = buildPlan(LIST, { tool: resolveTool(TOOLS, "catalog:voice") });
    expect(conv.convert).toHaveLength(1);
    expect(conv.other).toEqual([]);
  });
});

describe("checkDisk + totals", () => {
  it("classifies have / part / get / mismatch and sums what is left", () => {
    const plan = buildPlan(LIST, { set: "full" });
    const disk = {
      "/m/diffusion_models/video.safetensors": 1000,
      "/m/vae/split/vae/vae.safetensors.part": 150,
      "/m/loras/motion/motion.safetensors": 49,
      "/m/tts/voice/model-a/config.json.part": 9,
    };
    const status = checkDisk(plan, "/m", (p) => disk[p] ?? -1);
    expect(status.map((s) => s.state)).toEqual([
      "have",
      "part",
      "mismatch",
      "mismatch",
      "get",
    ]);
    const t = totals(status);
    expect(t).toMatchObject({
      files: 5,
      bytes: 1323,
      have: 1000,
      nHave: 1,
      nMismatch: 2,
      need: 50 + 70,
    });
    const text = formatPlan(plan, status, { modelsDir: "/m", free: 10_000 });
    expect(text).toContain("resume from");
    expect(text).toContain("not touched");
    expect(text).toContain("also linked to vae/vae.safetensors");
    expect(text).toContain("Download by hand");
  });

  it("links a missing file from an existing copy at an `also` path", () => {
    const plan = buildPlan(LIST);
    const disk = { "/m/vae/vae.safetensors": 200 };
    const status = checkDisk(plan, "/m", (p) => disk[p] ?? -1);
    expect(status[1]).toMatchObject({ state: "link", from: "vae/vae.safetensors" });
    expect(totals(status)).toMatchObject({ have: 200, nHave: 1, need: 1000 });
    expect(formatPlan(plan, status, { modelsDir: "/m" })).toContain(
      "same file as vae/vae.safetensors; linked, not downloaded",
    );
  });

  it("without a models dir everything is planned as a download", () => {
    const status = checkDisk(buildPlan(LIST), null);
    expect(status.every((s) => s.state === "get")).toBe(true);
    expect(totals(status).need).toBe(1200);
  });
});

describe("committed tool map", () => {
  it("is readable by the script and every tool resolves", () => {
    const map = JSON.parse(
      readFileSync(
        path.resolve(__dirname, "../../docs/models-by-tool.json"),
        "utf8",
      ),
    );
    for (const t of map.tools)
      expect(resolveTool(map, `${t.kind}:${t.id}`)).toBe(t);
  });
});

describe("starter packs (--pack)", () => {
  const PACKS = {
    packs: [
      {
        id: "a",
        files: [
          {
            options: [
              { dest: "diffusion_models/m_bf16.safetensors" },
              { dest: "diffusion_models/m_fp8_scaled.safetensors" },
            ],
          },
          { dest: "vae/v.safetensors" },
        ],
      },
      { id: "b", files: [{ dest: "vae/v.safetensors" }, { dest: "loras/l.safetensors" }] },
    ],
  };

  it("packTool picks the first option, or the one named by --use", () => {
    expect(packTool(PACKS, "a").files).toEqual([
      "diffusion_models/m_bf16.safetensors",
      "vae/v.safetensors",
    ]);
    const t = packTool(PACKS, "a,b", ["diffusion_models/m_fp8_scaled.safetensors"]);
    expect(t).toMatchObject({ kind: "pack", id: "a,b" });
    expect(t.files).toEqual([
      "diffusion_models/m_fp8_scaled.safetensors",
      "vae/v.safetensors",
      "loras/l.safetensors",
    ]);
  });

  it("packTool reuses a slot option another chosen pack already fetches", () => {
    const doc = {
      packs: [
        ...PACKS.packs,
        {
          id: "c",
          files: [
            {
              options: [
                { dest: "diffusion_models/m_fp8_scaled.safetensors" },
                { dest: "diffusion_models/m_bf16.safetensors" },
              ],
            },
          ],
        },
      ],
    };
    expect(packTool(doc, "a,c").files).toEqual([
      "diffusion_models/m_bf16.safetensors",
      "vae/v.safetensors",
    ]);
    expect(packTool(doc, "c,a").files).toEqual([
      "diffusion_models/m_fp8_scaled.safetensors",
      "vae/v.safetensors",
    ]);
    expect(
      packTool(doc, "a,c", ["diffusion_models/m_fp8_scaled.safetensors"]).files,
    ).toEqual(["diffusion_models/m_fp8_scaled.safetensors", "vae/v.safetensors"]);
  });

  it("Images + Draft download one Qwen3-VL encoder and one VAE", () => {
    const doc = JSON.parse(
      readFileSync(path.resolve(__dirname, "../lib/onboarding/starterPacks.json"), "utf8"),
    );
    const files = packTool(doc, "images-best,images-draft").files;
    expect(files.filter((f) => f.includes("qwen3vl_4b"))).toHaveLength(1);
    expect(files.filter((f) => f.startsWith("vae/"))).toHaveLength(1);
    expect(new Set(files).size).toBe(files.length);
  });

  it("packTool rejects unknown packs and --use values that are not options", () => {
    expect(() => packTool(PACKS, "zzz")).toThrow(/unknown pack/);
    expect(() => packTool(PACKS, "")).toThrow(/at least one/);
    expect(() => packTool(PACKS, "b", ["diffusion_models/m_fp8_scaled.safetensors"])).toThrow(
      /not an option/,
    );
  });

  it("parseArgs: --pack/--use/--list-packs", () => {
    expect(parseArgs(["--pack", "a,b", "--use", "x", "--use=y"])).toMatchObject({
      pack: "a,b",
      use: ["x", "y"],
    });
    expect(parseArgs(["--list-packs"]).listPacks).toBe(true);
    expect(() => parseArgs(["--pack", "a", "--tool", "t"])).toThrow(/not both/);
    expect(() => parseArgs(["--use", "x"])).toThrow(/needs --pack/);
  });

  it("packTool leaves optional files out unless --use names them", () => {
    const doc = {
      packs: [
        {
          id: "s",
          files: [
            { dest: "checkpoints/m.safetensors" },
            { dest: "checkpoints/m_base.safetensors", optional: true },
          ],
        },
      ],
    };
    expect(packTool(doc, "s").files).toEqual(["checkpoints/m.safetensors"]);
    expect(packTool(doc, "s", ["checkpoints/m_base.safetensors"]).files).toEqual([
      "checkpoints/m.safetensors",
      "checkpoints/m_base.safetensors",
    ]);
  });

  it("the Stable Audio 3 pack fetches Medium + its text encoder; Quality is opt-in", () => {
    const doc = JSON.parse(
      readFileSync(path.resolve(__dirname, "../lib/onboarding/starterPacks.json"), "utf8"),
    );
    expect(packTool(doc, "audio-sa3").files).toEqual([
      "checkpoints/stable_audio_3_medium.safetensors",
      "text_encoders/t5gemma_b_b_ul2.safetensors",
    ]);
    expect(
      packTool(doc, "audio-sa3", ["checkpoints/stable_audio_3_medium_base.safetensors"]).files,
    ).toContain("checkpoints/stable_audio_3_medium_base.safetensors");
  });

  it("every pack in starterPacks.json resolves", () => {
    const doc = JSON.parse(
      readFileSync(path.resolve(__dirname, "../lib/onboarding/starterPacks.json"), "utf8"),
    );
    for (const p of doc.packs) expect(packTool(doc, p.id).files.length).toBeGreaterThan(0);
  });
});

describe("fetch-models --only", () => {
  it("parses repeatable --only", () => {
    const o = parseArgs(["--only", "loras/a.safetensors", "--only", "vae/b.safetensors"]);
    expect(o.only).toEqual(["loras/a.safetensors", "vae/b.safetensors"]);
  });

  it("keeps only the named rows, matching dest or also", () => {
    const plan = buildPlan(LIST, { set: "full" });
    const f = filterPlan(plan, [
      "loras/motion/motion.safetensors",
      "vae/vae.safetensors",
    ]);
    expect(f.items.map((r) => r.dest).sort()).toEqual([
      "loras/motion/motion.safetensors",
      "vae/split/vae/vae.safetensors",
    ]);
    expect(f.unlisted).toEqual([]);
  });

  it("returns the plan unchanged without --only", () => {
    const plan = buildPlan(LIST, { set: "full" });
    expect(filterPlan(plan, [])).toBe(plan);
  });

  it("throws on a path outside the plan", () => {
    const plan = buildPlan(LIST, { set: "full" });
    expect(() => filterPlan(plan, ["loras/nope.safetensors"])).toThrow(
      /not a file of this plan/,
    );
  });
});

describe("main links instead of downloading", () => {
  const row = {
    set: "minimal",
    repo: "org/video",
    path: "vae.safetensors",
    revision: REV_A,
    size: 4,
    dest: "vae/split/vae.safetensors",
    also: ["vae/vae.safetensors"],
  };
  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-link-"));
    const list = path.join(root, "list.json");
    fs.writeFileSync(list, JSON.stringify({ files: [row] }));
    fs.mkdirSync(path.join(root, "models/vae"), { recursive: true });
    fs.writeFileSync(path.join(root, "models/vae/vae.safetensors"), "abcd");
    const args = ["--list", list, "--comfy", root, "--yes", "--no-hf"];
    return { root, args };
  }

  it("hard-links the missing path from the copy already on disk", async () => {
    const { root, args } = setup();
    try {
      expect(await main(args)).toBe(0);
      const a = fs.statSync(path.join(root, "models", row.dest));
      const b = fs.statSync(path.join(root, "models", row.also[0]));
      expect(a.size).toBe(4);
      expect(a.ino).toBe(b.ino);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a link that cannot be made counts as a failure, not a crash", async () => {
    const { root, args } = setup();
    const dir = path.join(root, "models/vae/split");
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o555);
    try {
      expect(await main(args)).toBe(1);
      expect(fs.existsSync(path.join(root, "models", row.dest))).toBe(false);
    } finally {
      fs.chmodSync(dir, 0o755);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

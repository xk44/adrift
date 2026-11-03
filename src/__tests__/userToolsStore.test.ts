import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  createUserTool,
  deleteUserTool,
  getUserTool,
  listUserTools,
  readUserToolsFile,
  summarizeUserTool,
  updateUserTool,
  UserToolsStoreError,
} from "@/lib/userTools/store";
import {
  applyUserToolParams,
  promptLine,
  UserToolInputError,
} from "@/lib/userTools/build";
import { discoverParams } from "@/lib/userTools/analyze";
import { USER_TOOL_ICONS } from "@/lib/userTools/types";
import type { ObjectInfoIndex } from "@/lib/oj/inputSpec";
import { editGraph, objectInfo, t2iGraph } from "./fixtures/userToolsGraphs";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "adrift-user-tools-"));
  file = path.join(dir, "data", "user_tools.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function input(overrides: Record<string, unknown> = {}) {
  const workflow = editGraph();
  return {
    name: "Ink wash",
    icon: "Brush",
    category: "Edit",
    workflowType: "i2i",
    output: "image",
    workflow,
    params: discoverParams(workflow, objectInfo() as ObjectInfoIndex),
    source: {
      type: "civitai",
      url: "https://civitai.com/models/1?modelVersionId=2",
      modelId: 1,
      versionId: 2,
    },
    ...overrides,
  };
}

describe("user tools store", () => {
  it("reads a missing file as empty", async () => {
    expect(await readUserToolsFile(file)).toEqual({ version: 1, tools: [] });
  });

  it("creates, reads, updates and deletes with an atomic versioned file", async () => {
    const tool = await createUserTool(
      input(),
      file,
      new Date("2026-10-27T00:00:00Z"),
    );
    expect(tool.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tool.createdAt).toBe("2026-10-27T00:00:00.000Z");

    const disk = JSON.parse(await readFile(file, "utf8"));
    expect(disk.version).toBe(1);
    expect(disk.tools).toHaveLength(1);
    // no temp files left behind
    expect(
      (await readdir(path.dirname(file))).filter((f) => f.endsWith(".tmp")),
    ).toEqual([]);

    expect((await getUserTool(tool.id, file))?.name).toBe("Ink wash");
    const updated = await updateUserTool(
      tool.id,
      { name: "Ink wash v2", category: "Image", description: "Paints in ink" },
      file,
      new Date("2026-10-28T00:00:00Z"),
    );
    expect(updated).toMatchObject({
      name: "Ink wash v2",
      category: "Image",
      description: "Paints in ink",
    });
    expect(updated?.updatedAt).toBe("2026-10-28T00:00:00.000Z");
    expect(updated?.createdAt).toBe(tool.createdAt);

    expect(await deleteUserTool(tool.id, file)).toBe(true);
    expect(await deleteUserTool(tool.id, file)).toBe(false);
    expect(await listUserTools(file)).toEqual([]);
  });

  it("serializes concurrent creates", async () => {
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        createUserTool(input({ name: `Tool ${n}` }), file),
      ),
    );
    expect((await listUserTools(file)).map((t) => t.name).sort()).toEqual([
      "Tool 1",
      "Tool 2",
      "Tool 3",
      "Tool 4",
      "Tool 5",
    ]);
  });

  it("validates input", async () => {
    await expect(createUserTool(input({ name: "" }), file)).rejects.toThrow(
      /name is required/,
    );
    await expect(
      createUserTool(input({ category: "Nope" }), file),
    ).rejects.toThrow(/category/);
    await expect(
      createUserTool(input({ icon: "Skull" }), file),
    ).rejects.toThrow(/icon/);
    await expect(
      createUserTool(input({ workflow: { a: 1 } }), file),
    ).rejects.toThrow(UserToolsStoreError);
    await expect(
      createUserTool(
        input({ params: [{ nodeId: "99", input: "text", kind: "prompt" }] }),
        file,
      ),
    ).rejects.toThrow(/does not match/);
    await expect(
      createUserTool(
        input({ params: [{ nodeId: "13", input: "text", kind: "evil" }] }),
        file,
      ),
    ).rejects.toThrow(/unknown kind/);
  });

  it("drops non-https source urls and strips the graph from summaries", async () => {
    const tool = await createUserTool(
      input({ source: { type: "civitai", url: "javascript:alert(1)" } }),
      file,
    );
    expect(tool.source.url).toBeUndefined();
    const summary = summarizeUserTool(tool);
    expect("workflow" in summary).toBe(false);
    expect(summary.params.length).toBeGreaterThan(0);
  });

  it("refuses to overwrite a corrupt or newer file", async () => {
    await writeFile(path.join(dir, "bad.json"), "{nope");
    await expect(
      createUserTool(input(), path.join(dir, "bad.json")),
    ).rejects.toThrow(SyntaxError);
    expect(await readFile(path.join(dir, "bad.json"), "utf8")).toBe("{nope");

    await writeFile(
      path.join(dir, "newer.json"),
      JSON.stringify({ version: 99, tools: [] }),
    );
    await expect(listUserTools(path.join(dir, "newer.json"))).rejects.toThrow(
      /newer Adrift/,
    );
  });

  it("returns null / false for bad ids", async () => {
    expect(await getUserTool("../etc", file)).toBeNull();
    expect(await updateUserTool("../etc", { name: "x" }, file)).toBeNull();
    expect(await deleteUserTool("", file)).toBe(false);
  });

  it("offers only icons that exist", () => {
    expect(USER_TOOL_ICONS.length).toBeGreaterThan(5);
  });
});

describe("applyUserToolParams", () => {
  const tool = () => {
    const workflow = t2iGraph();
    return {
      name: "Fox",
      workflow,
      params: discoverParams(workflow, objectInfo() as ObjectInfoIndex),
    };
  };

  it("applies exposed values, clamps numbers and leaves the saved graph alone", () => {
    const t = tool();
    const { workflow, used } = applyUserToolParams(t, {
      values: {
        "2.text": "a blue fox",
        "5.steps": 99999,
        "5.cfg": "4.5",
        "4.width": 640.4,
        "5.seed": 5,
      },
      rand: () => 0.5,
    });
    expect(workflow["2"].inputs.text).toBe("a blue fox");
    expect(workflow["5"].inputs.steps).toBe(10000);
    expect(workflow["5"].inputs.cfg).toBe(4.5);
    expect(workflow["4"].inputs.width).toBe(640);
    expect(workflow["5"].inputs.seed).toBe(5);
    expect(t.workflow["2"].inputs.text).toBe("a red fox");
    expect(promptLine(t, used)).toBe("a blue fox");
  });

  it("randomizes empty and unexposed seeds", () => {
    const t = tool();
    const a = applyUserToolParams(t, { rand: () => 0.25 });
    expect(a.workflow["5"].inputs.seed).toBe(
      Math.floor(0.25 * 1125899906842624),
    );
    t.params.find((p) => p.kind === "seed")!.exposed = false;
    const b = applyUserToolParams(t, {
      values: { "5.seed": 3 },
      rand: () => 0.5,
    });
    expect(b.workflow["5"].inputs.seed).toBe(
      Math.floor(0.5 * 1125899906842624),
    );
  });

  it("ignores values for params that are not exposed", () => {
    const t = tool();
    const { workflow } = applyUserToolParams(t, {
      values: { "5.denoise": 0.1, "5.sampler_name": "x" },
    });
    expect(workflow["5"].inputs.denoise).toBe(1);
    expect(workflow["5"].inputs.sampler_name).toBe("euler");
  });

  it("requires every exposed media input and rejects bad types", () => {
    const workflow = editGraph();
    const t = {
      name: "Ink",
      workflow,
      params: discoverParams(workflow, objectInfo() as ObjectInfoIndex),
    };
    expect(() => applyUserToolParams(t, {})).toThrow(UserToolInputError);
    const ok = applyUserToolParams(t, {
      media: { "10.image": "up_1.png [input]" },
    });
    expect(ok.workflow["10"].inputs.image).toBe("up_1.png [input]");
    expect(() =>
      applyUserToolParams(t, {
        media: { "10.image": "a.png" },
        values: { "13.text": 5 },
      }),
    ).toThrow(/must be text/);
    expect(() =>
      applyUserToolParams(t, {
        media: { "10.image": "a.png" },
        values: { "16.denoise": "abc" },
      }),
    ).toThrow(/must be a number/);
  });
});

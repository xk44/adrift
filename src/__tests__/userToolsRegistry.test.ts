import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import {
  filterUserTools,
  MY_TOOLS_GROUP,
  userToolEditorEntries,
  userToolLightboxEntries,
  userToolSubtitle,
  userToolWorkflowOptions,
} from "@/lib/userTools/registry";
import { isUserToolSelection } from "@/lib/userTools/types";
import type { UserToolParam, UserToolSummary } from "@/lib/userTools/types";
import { createUserTool } from "@/lib/userTools/store";
import { loadWorkflowFromSelection } from "@/lib/comfy/workflows";
import { discoverParams } from "@/lib/userTools/analyze";
import type { ObjectInfoIndex } from "@/lib/oj/inputSpec";
import { runUserToolApi } from "@/lib/userTools/client";
import { editGraph, objectInfo } from "./fixtures/userToolsGraphs";

function param(kind: UserToolParam["kind"], exposed = true): UserToolParam {
  return {
    key: `1.${kind}`,
    nodeId: "1",
    input: kind,
    kind,
    label: kind,
    exposed,
  };
}

function summary(
  id: string,
  over: Partial<UserToolSummary> = {},
): UserToolSummary {
  return {
    id,
    name: `Tool ${id}`,
    icon: "Brush",
    category: "Edit",
    workflowType: "i2i",
    output: "image",
    params: [param("prompt")],
    source: { type: "file" },
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const t2i = summary("a", { name: "Fox maker", category: "Image", workflowType: "t2i" });
const edit = summary("b", {
  name: "Ink wash",
  params: [param("image"), param("prompt")],
});
const inpaint = summary("c", {
  name: "Fill",
  params: [param("image"), param("mask")],
});
const animate = summary("d", {
  name: "Animate",
  output: "video",
  params: [param("image")],
});
const hiddenImage = summary("e", { params: [param("image", false)] });
const clip = summary("f", { params: [param("video")], output: "video" });
const all = [t2i, edit, inpaint, animate, hiddenImage, clip];

describe("user tool registry merge", () => {
  it("lists image/clip tools in the lightbox panel under My tools", () => {
    const rows = userToolLightboxEntries(all);
    expect(rows.map((r) => r.key)).toEqual([
      "user:b",
      "user:c",
      "user:d",
      "user:f",
    ]);
    expect(rows[0]).toMatchObject({
      group: MY_TOOLS_GROUP,
      icon: "Brush",
      media: ["image"],
      target: { kind: "open", toolKey: "user:b" },
    });
    expect(rows[3].media).toEqual(["video"]);
    expect(userToolLightboxEntries(null)).toEqual([]);
  });

  it("lists image-in tools as editor edit functions with output + mask", () => {
    const rows = userToolEditorEntries(all);
    expect(rows.map((r) => [r.key, r.output, r.mask])).toEqual([
      ["user:b", "image", null],
      ["user:c", "image", "inpaint"],
      ["user:d", "video", null],
    ]);
  });

  it("offers every tool as a workflow assignment, sorted by name", () => {
    expect(userToolWorkflowOptions([edit, t2i])).toEqual([
      { value: "user:a", label: "Fox maker" },
      { value: "user:b", label: "Ink wash" },
    ]);
  });

  it("filters by words and category", () => {
    expect(filterUserTools(all, "ink", null).map((t) => t.id)).toEqual(["b"]);
    expect(filterUserTools(all, "", "Image").map((t) => t.id)).toEqual(["a"]);
    expect(filterUserTools(all, "my tools", null)).toHaveLength(all.length);
    expect(filterUserTools(all, "fox ink", null)).toEqual([]);
  });

  it("writes plain subtitles", () => {
    expect(userToolSubtitle(t2i)).toBe("Makes an image from a prompt");
    expect(userToolSubtitle(animate)).toBe("Turns an image into a clip");
    expect(userToolSubtitle({ ...edit, description: "Mine" })).toBe("Mine");
  });
});

describe("user:<id> workflow selections", () => {
  let dir: string;
  const prev = process.env.ADRIFT_USER_TOOLS_FILE;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "adrift-user-sel-"));
    process.env.ADRIFT_USER_TOOLS_FILE = path.join(dir, "user_tools.json");
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.ADRIFT_USER_TOOLS_FILE;
    else process.env.ADRIFT_USER_TOOLS_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  });

  it("recognizes only well-formed user selections", () => {
    expect(isUserToolSelection("user:abc-123")).toBe(true);
    expect(isUserToolSelection("user:")).toBe(false);
    expect(isUserToolSelection("user:../x")).toBe(false);
    expect(isUserToolSelection("saved:x.json")).toBe(false);
    expect(isUserToolSelection(undefined)).toBe(false);
  });

  it("loads a copy of the saved graph and explains deleted tools", async () => {
    const workflow = editGraph();
    const tool = await createUserTool({
      name: "Ink",
      icon: "Brush",
      category: "Edit",
      workflowType: "i2i",
      output: "image",
      workflow,
      params: discoverParams(workflow, objectInfo() as ObjectInfoIndex),
      source: { type: "file" },
    });
    const a = await loadWorkflowFromSelection(`user:${tool.id}`);
    expect(a["10"].class_type).toBe("LoadImage");
    a["10"].inputs.image = "changed.png";
    const b = await loadWorkflowFromSelection(`user:${tool.id}`);
    expect(b["10"].inputs.image).toBe("photo.png");
    await expect(loadWorkflowFromSelection("user:missing")).rejects.toThrow(
      /was deleted/,
    );
  });
});

describe("runUserToolApi", () => {
  it("sends gallery images by run, uploads others and returns the run", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url === "/api/comfy/upload") {
        return { ok: true, status: 200, json: async () => ({ ref: "up.mp4 [input]" }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, run: { id: "r1" } }),
      };
    });
    const run = await runUserToolApi({
      fetchImpl,
      id: "t1",
      values: { "2.text": "hi" },
      media: {
        "10.image": {
          kind: "image",
          image: {
            id: "i",
            source: "gallery",
            previewUrl: "",
            label: "",
            width: 1,
            height: 1,
            runId: "run9",
            jobIndex: 2,
          } as never,
        },
        "11.video": {
          kind: "video",
          video: { id: "v", previewUrl: "", dataUrl: "data:video/mp4;base64,AA", label: "c.mp4" } as never,
        },
      },
      clientId: "c",
    });
    expect(run).toEqual({ id: "r1" });
    const runCall = calls.find((c) => c.url === "/api/user-tools/t1/run")!;
    expect(runCall.body).toMatchObject({
      values: { "2.text": "hi" },
      media: { "10.image": { run_id: "run9", job_index: 2 } },
      client_id: "c",
    });
    expect((runCall.body as { media: Record<string, unknown> }).media["11.video"]).toBe("up.mp4 [input]");
  });

  it("surfaces server errors in plain words", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ ok: false, error: "That image is not ready yet." }),
    }));
    await expect(
      runUserToolApi({ fetchImpl, id: "t1", values: {}, media: {} }),
    ).rejects.toThrow("That image is not ready yet.");
  });
});

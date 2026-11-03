/**
 * User tools in the UI (static render, no DOM library): My tools section,
 * lightbox / editor panel merge, Workflows assignment options, the Explore
 * import button, the runner form, plus the runner form logic and store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UserToolParam, UserToolSummary } from "@/lib/userTools/types";
import { useUserToolsStore } from "@/store/userToolsStore";
import { MyToolsSection } from "@/components/tools/userTools/MyToolsSection";
import { UserToolAssignmentOptions } from "@/components/tools/userTools/UserToolAssignmentOptions";
import { UserToolRunner } from "@/components/tools/userTools/UserToolRunner";
import { ImportIntoAdriftButton } from "@/components/civitai/ImportIntoAdriftButton";
import { LightboxToolsPanel } from "@/components/LightboxToolsPanel";
import { EditorToolsPanel } from "@/components/editor/EditorToolsPanel";
import {
  formValuesToSend,
  initialFormValues,
  missingMediaMessage,
} from "@/lib/userTools/runnerForm";
import {
  civitaiWorkflowImportUrl,
  isCivitaiWorkflowModel,
} from "@/lib/userTools/registry";
import type { CivitaiModel } from "@/lib/civitai";

// Static render reads zustand's server snapshot (initial state); read the
// live state instead so tests can seed tools with setState.
vi.mock("@/store/userToolsStore", async (orig) => {
  const mod = await orig<typeof import("@/store/userToolsStore")>();
  return {
    ...mod,
    useUserTools: () => mod.useUserToolsStore.getState().tools,
  };
});

const p = (
  key: string,
  kind: UserToolParam["kind"],
  extra: Partial<UserToolParam> = {},
): UserToolParam => ({
  key,
  nodeId: key.split(".")[0],
  input: key.split(".")[1],
  kind,
  label: kind === "image" ? "Your photo" : kind,
  exposed: true,
  ...extra,
});

const ink: UserToolSummary = {
  id: "ink-1",
  name: "Ink wash",
  icon: "Brush",
  category: "Edit",
  workflowType: "i2i",
  output: "image",
  params: [
    p("10.image", "image", { default: "photo.png" }),
    p("13.text", "prompt", { label: "Prompt", default: "ink wash" }),
    p("5.seed", "seed", { label: "Seed", default: 7 }),
    p("5.steps", "steps", { label: "Steps", default: 20 }),
    p("5.cfg", "cfg", { label: "CFG", default: 4, exposed: false }),
  ],
  source: { type: "file" },
  createdAt: "",
  updatedAt: "",
};
const fox: UserToolSummary = {
  ...ink,
  id: "fox-2",
  name: "Fox maker",
  category: "Image",
  workflowType: "t2i",
  params: [p("2.text", "prompt", { label: "Prompt" })],
};

beforeEach(() => {
  useUserToolsStore.setState({ tools: [ink, fox], pendingImportUrl: null });
});
afterEach(() => {
  useUserToolsStore.setState({ tools: null, pendingImportUrl: null });
  vi.unstubAllGlobals();
});

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el);

describe("user tools UI", () => {
  it("shows My tools with search and category filters", () => {
    const out = html(
      createElement(MyToolsSection, { query: "", only: null, onOpen: () => {} }),
    );
    expect(out).toContain("My tools");
    expect(out).toContain('data-testid="tool-card-user:ink-1"');
    expect(out).toContain("Fox maker");
    expect(out).toContain("Turns an image into an image");
    const edit = html(
      createElement(MyToolsSection, { query: "", only: "Edit", onOpen: () => {} }),
    );
    expect(edit).not.toContain("Fox maker");
    expect(
      html(createElement(MyToolsSection, { query: "zzz", only: null, onOpen: () => {} })),
    ).toBe("");
  });

  it("adds image tools to the lightbox and editor panels", () => {
    const lb = html(
      createElement(LightboxToolsPanel, {
        media: "image",
        external: false,
        onRun: () => {},
        isRunning: () => false,
        onOpenTool: () => {},
      } as never),
    );
    expect(lb).toContain("My tools");
    expect(lb).toContain("Ink wash");
    expect(lb).not.toContain("Fox maker");
    const ed = html(createElement(EditorToolsPanel, { onClose: () => {} }));
    expect(ed).toContain("Ink wash");
    expect(ed).not.toContain("Fox maker");
  });

  it("offers user tools as Workflows assignments", () => {
    const out = html(
      createElement("select", null, createElement(UserToolAssignmentOptions)),
    );
    expect(out).toContain('<optgroup label="My tools">');
    expect(out).toContain('value="user:fox-2"');
    useUserToolsStore.setState({ tools: [] });
    expect(html(createElement(UserToolAssignmentOptions))).toBe("");
  });

  it("puts Import into Adrift on Civitai workflow cards only", () => {
    const wf = { id: 9, name: "Flow", type: "Workflows" } as CivitaiModel;
    expect(
      html(createElement(ImportIntoAdriftButton, { model: wf, versionId: 3, source: "com" })),
    ).toContain("Import into Adrift");
    expect(
      html(
        createElement(ImportIntoAdriftButton, {
          model: { ...wf, type: "LORA" } as CivitaiModel,
          source: "com",
        }),
      ),
    ).toBe("");
    expect(isCivitaiWorkflowModel({ type: "workflows" })).toBe(true);
    expect(civitaiWorkflowImportUrl("red", 9, 3)).toBe(
      "https://civitai.red/models/9?modelVersionId=3",
    );
    expect(civitaiWorkflowImportUrl("com", 9)).toBe("https://civitai.com/models/9");
  });

  it("renders a runner field per exposed param", () => {
    const out = html(createElement(UserToolRunner, { id: "ink-1", onBack: () => {} }));
    expect(out).toContain("Ink wash");
    expect(out).toContain("Your photo");
    expect(out).toContain("ink wash</textarea>");
    expect(out).toContain('placeholder="Random"');
    expect(out).not.toContain(">CFG<");
    expect(out).toContain("Add your photo.");
    const gone = html(createElement(UserToolRunner, { id: "nope", onBack: () => {} }));
    expect(gone).toContain("Tool not found");
  });
});

describe("runner form", () => {
  it("starts from the graph values with a random seed", () => {
    expect(initialFormValues(ink.params)).toEqual({
      "13.text": "ink wash",
      "5.seed": "",
      "5.steps": 20,
    });
  });

  it("sends prompts as text and skips blank numbers", () => {
    expect(
      formValuesToSend(ink.params, {
        "13.text": "",
        "5.seed": "",
        "5.steps": "12",
        "5.cfg": 9,
      }),
    ).toEqual({ "13.text": "", "5.steps": 12 });
  });

  it("names the first missing media input", () => {
    expect(missingMediaMessage(ink.params, () => false)).toBe("Add your photo.");
    expect(missingMediaMessage(ink.params, () => true)).toBeNull();
  });
});

describe("user tools store", () => {
  it("upserts, removes and hands over an Explore import once", () => {
    const s = useUserToolsStore.getState();
    s.upsert({ ...ink, name: "Ink 2" });
    s.remove("fox-2");
    expect(useUserToolsStore.getState().tools?.map((t) => t.name)).toEqual(["Ink 2"]);
    s.requestImport("https://civitai.com/models/1");
    expect(useUserToolsStore.getState().consumeImport()).toBe(
      "https://civitai.com/models/1",
    );
    expect(useUserToolsStore.getState().consumeImport()).toBeNull();
  });

  it("loads from the API and falls back to empty when it fails", async () => {
    useUserToolsStore.setState({ tools: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, tools: [fox] }) })),
    );
    await useUserToolsStore.getState().load();
    expect(useUserToolsStore.getState().tools).toEqual([fox]);

    useUserToolsStore.setState({ tools: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })),
    );
    await useUserToolsStore.getState().load();
    expect(useUserToolsStore.getState().tools).toEqual([]);
  });
});

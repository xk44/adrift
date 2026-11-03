import { beforeEach, describe, expect, it } from "vitest";
import { runProvenance } from "@/lib/runProvenance";
import {
  provenancePrefill,
  provenanceToolKey,
  toolPageHref,
} from "@/lib/tools/provenanceTool";
import { toolFromSearch } from "@/lib/tools/hubVisuals";
import { EXPAND_KEY } from "@/lib/tools/toolNames";
import { useToolHandoffStore } from "@/store/toolHandoffStore";

const action = (id: string, via?: string) => ({
  action_source_run_id: "run-src",
  action_provenance: { kind: "action", id, ...(via ? { via } : {}) },
});
const tool = (id: string, options: Record<string, unknown> = {}) => ({
  tool_id: id,
  tool_options: options,
  action_source_run_id: "run-src",
  action_provenance: { kind: "tool", id, label: id },
});
const keyOf = (params: Record<string, unknown>) =>
  provenanceToolKey(runProvenance(params), params);

describe("provenanceToolKey", () => {
  it("maps catalog tool runs to their card", () => {
    expect(keyOf(tool("krea2-inpaint"))).toBe("catalog:krea2-inpaint");
  });

  it("folds outpaint backends into the Expand card", () => {
    expect(keyOf(tool("krea2-outpaint"))).toBe(EXPAND_KEY);
  });

  it("prefers the Tools page card that sent the action (via)", () => {
    expect(keyOf(action("upscale_creative", "upscale"))).toBe("action:upscale");
  });

  it("maps lightbox variants to their card", () => {
    expect(keyOf(action("upscale_subtle"))).toBe("action:upscale");
    expect(keyOf(action("zoom_2x"))).toBe(EXPAND_KEY);
    expect(keyOf(action("pan_left"))).toBe(EXPAND_KEY);
    expect(keyOf(action("adetailer"))).toBe("action:enhance_faces");
    expect(keyOf(action("remove_object"))).toBe("action:remove_object");
  });

  it("has no card for lightbox-only actions or unknown tools", () => {
    expect(keyOf(action("vary_strong"))).toBeNull();
    expect(keyOf(action("remix_subtle"))).toBeNull();
    expect(keyOf(tool("no-such-tool"))).toBeNull();
    expect(provenanceToolKey(null)).toBeNull();
  });

  it("builds a deep link the Tools page resolves", () => {
    const href = toolPageHref("catalog:krea2-inpaint");
    expect(href).toBe("/tools?tool=catalog%3Akrea2-inpaint");
    const search = href.slice(href.indexOf("?"));
    expect(toolFromSearch(search, ["catalog:krea2-inpaint"])).toBe(
      "catalog:krea2-inpaint",
    );
  });
});

describe("provenancePrefill", () => {
  it("restores valid enum choices and drops stale ones", () => {
    const params = tool("qwen21-camera", {
      azimuth: "right",
      elevation: "not-a-value",
      fast: true,
      steps: 12,
    });
    const out = provenancePrefill(runProvenance(params), params, "a cat");
    expect(out.picks).toEqual({ azimuth: "right" });
    // qwen21-camera has no fast mode, and its prompt is templated.
    expect(out.fast).toBeUndefined();
    expect(out.text).toBeUndefined();
    expect(out.steps).toBe(12);
  });

  it("restores the prompt when the tool sends it as typed", () => {
    const params = tool("krea2-anypaint", { expand: "widen_50" });
    const out = provenancePrefill(
      runProvenance(params),
      params,
      "a green sofa",
    );
    expect(out).toEqual({
      picks: { expand: "widen_50" },
      text: "a green sofa",
    });
  });

  it("restores nothing for action runs", () => {
    const params = action("remove_object");
    expect(provenancePrefill(runProvenance(params), params, "x")).toEqual({});
  });
});

describe("prefill hand-off store", () => {
  beforeEach(() => useToolHandoffStore.setState({ prefill: null }));

  it("is taken once by the matching card", () => {
    const now = Date.now();
    useToolHandoffStore.getState().offerPrefill({
      toolKey: "catalog:krea2-inpaint",
      settings: { text: "a lamp" },
      at: now,
    });
    const store = useToolHandoffStore.getState();
    expect(store.takePrefill("catalog:other", now)).toBeNull();
    expect(store.takePrefill("catalog:krea2-inpaint", now)?.settings).toEqual({
      text: "a lamp",
    });
    expect(store.takePrefill("catalog:krea2-inpaint", now)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import registry from "@/lib/tools/editToolRegistry.json";
import { buildHubCards } from "@/lib/tools/hub";
import { setupHint, prettyModelFile } from "@/lib/tools/setupHint";
import {
  buildToolCards,
  catalogIcon,
  missingModelsReason,
  type CatalogTool,
} from "@/lib/tools/toolsPage";
import { TOOL_ICONS } from "@/components/tools/ToolCover";

describe("setupHint", () => {
  it("is null when there is nothing to explain", () => {
    expect(setupHint(null)).toBeNull();
    expect(setupHint("  ")).toBeNull();
  });

  it("names the card's model for missing weight files", () => {
    const reason = missingModelsReason([
      "diffusion_models/fibo2_edit_turbo_bf16.safetensors",
    ]);
    expect(setupHint(reason, "Bria FIBO 2.0")).toBe(
      "Needs Bria FIBO 2.0 model",
    );
    expect(setupHint(reason, "Bria FIBO 2.0 · open weights")).toBe(
      "Needs Bria FIBO 2.0 model",
    );
  });

  it("falls back to the first file name plus a count", () => {
    const reason = missingModelsReason([
      "diffusion_models/trellis_2_int8_convrot.safetensors",
      "vae/a.safetensors",
      "vae/b.safetensors",
      "diffusion_models/c.safetensors",
      "vae/d.safetensors",
    ]);
    expect(setupHint(reason)).toBe("Needs trellis_2_int8_convrot +4");
    expect(setupHint(missingModelsReason(["loras/x/only.safetensors"]))).toBe(
      "Needs only",
    );
  });

  it("reports node-only gaps as custom nodes", () => {
    const reason = missingModelsReason([
      "node:TripoSRModelLoader",
      "node:TripoSRSampler",
    ]);
    expect(setupHint(reason, "TripoSR")).toBe("Needs custom nodes");
  });

  it("maps the other availability sentences", () => {
    expect(setupHint("The flux3 pack isn't installed on this server.")).toBe(
      "Needs the flux3 pack",
    );
    expect(setupHint("Needs custom nodes: comfyui-trellis2")).toBe(
      "Needs comfyui-trellis2 nodes",
    );
    expect(
      setupHint(
        "Needs ComfyUI custom nodes (ComfyUI-KJNodes: ImageResizeKJv2). Install them and restart ComfyUI.",
      ),
    ).toBe("Needs ComfyUI-KJNodes nodes");
    expect(
      setupHint(
        "LoRA not installed: qwen-head-swap. Put it in models/loras/edit_tools.",
      ),
    ).toBe("Needs qwen-head-swap LoRA");
    expect(
      setupHint(
        "Qwen-Image 2.1 base model or workflow is not installed (needs X).",
      ),
    ).toBe("Needs Qwen-Image 2.1 model");
    expect(
      setupHint("Needs one of: Krea 2, Qwen Edit 2511 (none installed)."),
    ).toBe("Needs Krea 2 model");
    expect(setupHint("Wan 2.2 isn't installed on this server.")).toBe(
      "Needs Wan 2.2 model",
    );
    expect(
      setupHint(
        "Needs a Krea 2 edit LoRA (grounded family). Install one from the Edit tab's LoRA list.",
      ),
    ).toBe("Needs an edit LoRA");
    expect(
      setupHint("Couldn't check which models are installed on this server."),
    ).toBe("Couldn't check models");
    expect(
      setupHint("Not set up on this server yet (workflow not registered)."),
    ).toBe("Not set up yet");
    expect(setupHint("No text-to-image pack is installed.")).toBe(
      "Needs an image pack",
    );
  });

  it("keeps short unknown reasons and condenses long ones", () => {
    expect(setupHint("Coming soon.")).toBe("Coming soon");
    const long =
      "Something unusual happened while checking this tool on the server.";
    expect(setupHint(long, "SeedVR2")).toBe("Needs SeedVR2");
    expect(setupHint(long)).toBe("Needs setup");
  });

  it("prettyModelFile strips folders and weight extensions", () => {
    expect(prettyModelFile("vae\\split/wan_2.1_vae.safetensors")).toBe(
      "wan_2.1_vae",
    );
    expect(prettyModelFile("model.gguf")).toBe("model");
  });
});

describe("cover icons", () => {
  it("every edit-registry category maps to a real cover icon", () => {
    const categories = new Set(
      (registry.tools as { category: string }[]).map((t) => t.category),
    );
    for (const c of categories) {
      const icon = catalogIcon(c);
      expect(icon, c).not.toBe("Wrench");
      expect(TOOL_ICONS[icon], `${c} -> ${icon}`).toBeDefined();
    }
  });

  it("every hub card icon resolves (no silent Wrench fallback)", () => {
    const toolCards = buildToolCards({
      catalog: [] as CatalogTool[],
      packIds: new Set(),
      editLoras: { families: {}, loras: [] },
      modelStatus: { tools: {} },
    });
    const cards = buildHubCards({
      toolCards,
      ctx: {
        catalog: [],
        packIds: new Set(),
        editLoras: { families: {}, loras: [] },
      },
    });
    expect(cards.length).toBeGreaterThan(50);
    const unknown = cards
      .filter((c) => !TOOL_ICONS[c.icon])
      .map((c) => `${c.key}:${c.icon}`);
    expect(unknown).toEqual([]);
  });
});

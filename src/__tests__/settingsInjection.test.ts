/**
 * Settings → Prompt Injection Tests
 * ===================================
 * Tests for settings-to-prompt merging, flag override logic,
 * LoRA trigger injection, and param extraction.
 *
 * Covers the logic in useImagine.buildPrompt (pure extraction),
 * parser.parseImagineInput, and triggers.injectTriggerWords.
 *
 * Run with: npx vitest run src/__tests__/settingsInjection.test.ts
 */

import { describe, it, expect, vi } from "vitest";
import { parseImagineInput } from "@/lib/oj/parser";
import { injectTriggerWords } from "@/lib/oj/triggers";

// ---------------------------------------------------------------------------
// Pure re-implementation of useImagine.buildPrompt for unit testing
// (the real one lives inside a hook with Zustand deps)
// ---------------------------------------------------------------------------

interface BuildPromptSettings {
  aspect?: string;
  stylize?: number;
  weird?: number;
  chaos?: number;
  modelMode?: string;
  quality?: number;
  model?: string;
  vae?: string;
  loras?: Array<{ name: string; strength: number }>;
  sampler?: string;
  scheduler?: string;
  steps?: number;
  cfg?: number;
  autoInjectTriggerWords?: boolean;
}

function buildPrompt(
  basePrompt: string,
  settings: BuildPromptSettings,
  opts: {
    resolveAlias?: (name: string, type: string) => string | undefined;
    defaultModel?: string;
    defaultVae?: string;
    defaultLoras?: Array<{ name: string; strength: number }>;
    getTriggersForLora?: (filename: string) => string[];
  } = {},
): string {
  const {
    resolveAlias = (_name: string, _type: string) => undefined,
    defaultModel,
    defaultVae,
    defaultLoras = [],
    getTriggersForLora = () => [],
  } = opts;

  const parts: string[] = [basePrompt.trim()];

  if (
    settings.aspect !== "1:1" &&
    settings.aspect &&
    !basePrompt.includes("--ar") &&
    !basePrompt.includes("--aspect")
  ) {
    parts.push(`--ar ${settings.aspect}`);
  }
  if (
    settings.stylize !== undefined &&
    settings.stylize !== 100 &&
    !basePrompt.includes("--stylize") &&
    !basePrompt.includes("--s ")
  ) {
    parts.push(`--stylize ${settings.stylize}`);
  }
  if (
    settings.weird !== undefined &&
    settings.weird > 0 &&
    !basePrompt.includes("--weird") &&
    !basePrompt.includes("--w ")
  ) {
    parts.push(`--weird ${settings.weird}`);
  }
  if (
    settings.chaos !== undefined &&
    settings.chaos > 0 &&
    !basePrompt.includes("--chaos") &&
    !basePrompt.includes("--c ")
  ) {
    parts.push(`--chaos ${settings.chaos}`);
  }
  if (settings.modelMode === "Raw" && !basePrompt.includes("--raw")) {
    parts.push("--raw");
  }
  if (
    settings.quality !== undefined &&
    settings.quality !== 1 &&
    !basePrompt.includes("--quality") &&
    !basePrompt.includes("--q ")
  ) {
    parts.push(`--quality ${settings.quality}`);
  }

  const resolvedModel = settings.model
    ? (resolveAlias(settings.model, "checkpoint") ?? settings.model)
    : defaultModel
      ? (resolveAlias(defaultModel, "checkpoint") ?? defaultModel)
      : undefined;

  const resolvedVae = settings.vae
    ? (resolveAlias(settings.vae, "vae") ?? settings.vae)
    : defaultVae
      ? (resolveAlias(defaultVae, "vae") ?? defaultVae)
      : undefined;

  const resolvedLoras = (
    settings.loras && settings.loras.length > 0 ? settings.loras : defaultLoras
  ).map((l) => ({
    ...l,
    name: resolveAlias(l.name, "lora") ?? l.name,
  }));

  if (
    resolvedModel &&
    !basePrompt.includes("--model") &&
    !basePrompt.includes("--v ")
  ) {
    parts.push(`--model ${resolvedModel}`);
  }
  if (resolvedVae && !basePrompt.includes("--vae")) {
    parts.push(`--vae ${resolvedVae}`);
  }
  if (resolvedLoras.length > 0 && !basePrompt.includes("--lora")) {
    const loraStr = resolvedLoras
      .filter((l) => l.name)
      .map((l) => (l.strength === 1.0 ? l.name : `${l.name}::${l.strength}`))
      .join(" ");
    if (loraStr) {
      parts.push(`--lora ${loraStr}`);
    }
  }
  if (settings.sampler && !basePrompt.includes("--sampler")) {
    parts.push(`--sampler ${settings.sampler}`);
  }
  if (settings.scheduler && !basePrompt.includes("--scheduler")) {
    parts.push(`--scheduler ${settings.scheduler}`);
  }
  if (settings.steps && !basePrompt.includes("--steps")) {
    parts.push(`--steps ${settings.steps}`);
  }
  if (settings.cfg && !basePrompt.includes("--cfg")) {
    parts.push(`--cfg ${settings.cfg}`);
  }

  if (settings.autoInjectTriggerWords !== false && resolvedLoras.length > 0) {
    parts[0] = injectTriggerWords(parts[0], resolvedLoras, getTriggersForLora);
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// 1. Settings → prompt string
// ---------------------------------------------------------------------------

describe("buildPrompt: settings → prompt string", () => {
  it("appends --ar when aspect is not 1:1 and not already in prompt", () => {
    const result = buildPrompt("a cat", { aspect: "16:9" });
    expect(result).toContain("--ar 16:9");
  });

  it("does not add --ar when the prompt already uses the --aspect alias", () => {
    const result = buildPrompt("a cat --aspect 4:3", { aspect: "16:9" });
    expect(result).not.toContain("--ar 16:9");
    expect(result).toContain("--aspect 4:3");
  });

  it("appends --stylize when not default (100) and not in prompt", () => {
    const result = buildPrompt("a cat", { stylize: 500 });
    expect(result).toContain("--stylize 500");
  });

  it("appends --chaos when > 0 and not in prompt", () => {
    const result = buildPrompt("a cat", { chaos: 20 });
    expect(result).toContain("--chaos 20");
  });

  it("appends --model when set", () => {
    const result = buildPrompt("a cat", { model: "sdxl.safetensors" });
    expect(result).toContain("--model sdxl.safetensors");
  });

  it("builds full prompt with aspect + stylize + chaos + model", () => {
    const result = buildPrompt("a cat", {
      aspect: "16:9",
      stylize: 500,
      chaos: 20,
      model: "sdxl.safetensors",
    });
    expect(result).toContain("--ar 16:9");
    expect(result).toContain("--stylize 500");
    expect(result).toContain("--chaos 20");
    expect(result).toContain("--model sdxl.safetensors");
    expect(result.startsWith("a cat")).toBe(true);
  });

  it("does NOT append --ar 1:1 (default aspect)", () => {
    const result = buildPrompt("a cat", { aspect: "1:1" });
    expect(result).not.toContain("--ar");
  });

  it("does NOT append --stylize 100 (default stylize)", () => {
    const result = buildPrompt("a cat", { stylize: 100 });
    expect(result).not.toContain("--stylize");
  });

  it("does NOT append --chaos 0 (default chaos)", () => {
    const result = buildPrompt("a cat", { chaos: 0 });
    expect(result).not.toContain("--chaos");
  });

  it("appends --raw when modelMode is Raw", () => {
    const result = buildPrompt("a cat", { modelMode: "Raw" });
    expect(result).toContain("--raw");
  });

  it("does not append --raw when modelMode is not Raw", () => {
    const result = buildPrompt("a cat", { modelMode: "Standard" });
    expect(result).not.toContain("--raw");
  });
});

// ---------------------------------------------------------------------------
// 2. User flags in prompt override settings
// ---------------------------------------------------------------------------

describe("buildPrompt: user prompt flags win over settings", () => {
  it("user --ar 1:1 in prompt overrides settings aspect 16:9", () => {
    const result = buildPrompt("a cat --ar 1:1", { aspect: "16:9" });
    // should NOT add a second --ar
    const arMatches = result.match(/--ar/g) ?? [];
    expect(arMatches).toHaveLength(1);
    expect(result).toContain("--ar 1:1");
    expect(result).not.toContain("--ar 16:9");
  });

  it("user --stylize 200 in prompt overrides settings stylize 500", () => {
    const result = buildPrompt("a cat --stylize 200", { stylize: 500 });
    const sMatches = result.match(/--stylize/g) ?? [];
    expect(sMatches).toHaveLength(1);
    expect(result).toContain("--stylize 200");
    expect(result).not.toContain("--stylize 500");
  });

  it("user --chaos 5 in prompt overrides settings chaos 80", () => {
    const result = buildPrompt("a cat --chaos 5", { chaos: 80 });
    const cMatches = result.match(/--chaos/g) ?? [];
    expect(cMatches).toHaveLength(1);
    expect(result).toContain("--chaos 5");
    expect(result).not.toContain("--chaos 80");
  });

  it("user --model existing.safetensors in prompt overrides settings model", () => {
    const result = buildPrompt("a cat --model other.safetensors", {
      model: "sdxl.safetensors",
    });
    const modelMatches = result.match(/--model/g) ?? [];
    expect(modelMatches).toHaveLength(1);
    expect(result).toContain("--model other.safetensors");
  });

  it("user --lora existing in prompt prevents settings loras from appending", () => {
    const result = buildPrompt("a cat --lora custom_lora", {
      loras: [{ name: "anime.safetensors", strength: 0.8 }],
    });
    const loraMatches = result.match(/--lora/g) ?? [];
    expect(loraMatches).toHaveLength(1);
    expect(result).toContain("--lora custom_lora");
  });
});

// ---------------------------------------------------------------------------
// 3. LoRA trigger injection when autoInjectTriggerWords is true
// ---------------------------------------------------------------------------

describe("buildPrompt: LoRA trigger injection", () => {
  const loras = [{ name: "anime.safetensors", strength: 0.8 }];
  const getTriggersForLora = (filename: string) =>
    filename === "anime.safetensors" ? ["anime style"] : [];

  it("prepends trigger words when autoInjectTriggerWords is true (default)", () => {
    const result = buildPrompt(
      "a portrait",
      { loras, autoInjectTriggerWords: true },
      { getTriggersForLora },
    );
    expect(result).toContain("anime style");
    // Trigger should appear before prompt text
    expect(result.indexOf("anime style")).toBeLessThan(
      result.indexOf("a portrait"),
    );
  });

  it("prepends trigger words even when autoInjectTriggerWords is undefined (default on)", () => {
    const result = buildPrompt("a portrait", { loras }, { getTriggersForLora });
    expect(result).toContain("anime style");
  });

  it("does not duplicate trigger words already present in prompt", () => {
    const result = buildPrompt(
      "anime style portrait",
      { loras, autoInjectTriggerWords: true },
      { getTriggersForLora },
    );
    const count = (result.match(/anime style/g) ?? []).length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Trigger injection skip when disabled
// ---------------------------------------------------------------------------

describe("buildPrompt: trigger injection disabled", () => {
  const loras = [{ name: "anime.safetensors", strength: 0.8 }];
  const getTriggersForLora = (filename: string) =>
    filename === "anime.safetensors" ? ["anime style"] : [];

  it("does NOT inject trigger words when autoInjectTriggerWords is false", () => {
    const result = buildPrompt(
      "a portrait",
      { loras, autoInjectTriggerWords: false },
      { getTriggersForLora },
    );
    expect(result).not.toContain("anime style");
  });

  it("still appends --lora flag even when trigger injection is disabled", () => {
    const result = buildPrompt(
      "a portrait",
      { loras, autoInjectTriggerWords: false },
      { getTriggersForLora },
    );
    expect(result).toContain("--lora anime.safetensors::0.8");
  });
});

// ---------------------------------------------------------------------------
// 5. Negative prompt extraction via parseImagineInput
// ---------------------------------------------------------------------------

describe("parseImagineInput: negative prompt (--no)", () => {
  it("extracts --no as negative prompt array", () => {
    const result = parseImagineInput("a cat --no blurry, ugly");
    expect(result.params.no).toBeDefined();
    const no = result.params.no as string[];
    // joined value contains the terms
    expect(no.join(" ")).toContain("blurry");
    expect(no.join(" ")).toContain("ugly");
  });

  it("strips --no from the clean prompt text", () => {
    const result = parseImagineInput("a cat --no blurry, ugly");
    expect(result.prompt).toBe("a cat");
  });

  it("handles multiple --no flags", () => {
    const result = parseImagineInput("a cat --no blurry --no ugly");
    const no = result.params.no as string[];
    expect(Array.isArray(no)).toBe(true);
    expect(no.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Seed handling via parseImagineInput
// ---------------------------------------------------------------------------

describe("parseImagineInput: seed extraction", () => {
  it("extracts --seed as numeric param", () => {
    const result = parseImagineInput("a cat --seed 12345");
    expect(result.params.seed).toBe(12345);
  });

  it("strips --seed from clean prompt text", () => {
    const result = parseImagineInput("a cat --seed 12345");
    expect(result.prompt).toBe("a cat");
  });

  it("seed combined with other params", () => {
    const result = parseImagineInput(
      "a cat --ar 16:9 --seed 99999 --stylize 300",
    );
    expect(result.params.seed).toBe(99999);
    expect(result.params.ar).toBe("16:9");
    expect(result.params.stylize).toBe(300);
    expect(result.prompt).toBe("a cat");
  });
});

// ---------------------------------------------------------------------------
// Bonus: injectTriggerWords unit tests (pure function)
// ---------------------------------------------------------------------------

describe("injectTriggerWords", () => {
  it("prepends trigger words not already in prompt", () => {
    const result = injectTriggerWords(
      "a portrait",
      [{ name: "anime.safetensors", strength: 0.8 }],
      (f) => (f === "anime.safetensors" ? ["anime style"] : []),
    );
    expect(result).toBe("anime style, a portrait");
  });

  it("does not prepend trigger already present (case-insensitive)", () => {
    const result = injectTriggerWords(
      "Anime Style portrait",
      [{ name: "anime.safetensors", strength: 0.8 }],
      (f) => (f === "anime.safetensors" ? ["anime style"] : []),
    );
    expect(result).toBe("Anime Style portrait");
  });

  it("handles multiple loras with multiple triggers", () => {
    const result = injectTriggerWords(
      "a portrait",
      [
        { name: "anime.safetensors", strength: 0.8 },
        { name: "detail.safetensors", strength: 0.5 },
      ],
      (f) => {
        if (f === "anime.safetensors") return ["anime style"];
        if (f === "detail.safetensors") return ["highly detailed"];
        return [];
      },
    );
    expect(result).toContain("anime style");
    expect(result).toContain("highly detailed");
    expect(result).toContain("a portrait");
  });

  it("deduplicates triggers across multiple loras", () => {
    const result = injectTriggerWords(
      "a portrait",
      [
        { name: "a.safetensors", strength: 1.0 },
        { name: "b.safetensors", strength: 1.0 },
      ],
      () => ["shared trigger"],
    );
    const count = (result.match(/shared trigger/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("returns prompt unchanged when lora has no triggers", () => {
    const result = injectTriggerWords(
      "a portrait",
      [{ name: "no-triggers.safetensors", strength: 1.0 }],
      () => [],
    );
    expect(result).toBe("a portrait");
  });

  it("returns prompt unchanged when loras array is empty", () => {
    const result = injectTriggerWords("a portrait", [], () => []);
    expect(result).toBe("a portrait");
  });
});

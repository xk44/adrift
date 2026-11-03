import { describe, expect, it } from "vitest";
import { createPickedModel } from "@/hooks/useFirstRunStatus";

const aliases: Record<string, string> = { juggernaut: "juggernautXL_v9.safetensors" };
const resolve = (a: string) => aliases[a] ?? null;

describe("createPickedModel (what the first-run check verifies)", () => {
  it("resolves a Settings default alias to its file", () => {
    expect(createPickedModel({ modelVersion: "custom" }, "juggernaut", resolve)).toBe(
      "juggernautXL_v9.safetensors",
    );
  });

  it("keeps a plain filename and prefers an explicit settings.model", () => {
    expect(createPickedModel({ modelVersion: "v7" }, "a.safetensors", resolve)).toBe(
      "a.safetensors",
    );
    expect(
      createPickedModel({ modelVersion: "custom", model: "juggernaut" }, "a.safetensors", resolve),
    ).toBe("juggernautXL_v9.safetensors");
  });

  it("engine-managed versions bring their own models: nothing to check", () => {
    expect(createPickedModel({ modelVersion: "krea2", model: "turbo" }, "a.safetensors", resolve)).toBeNull();
  });

  it("nothing picked", () => {
    expect(createPickedModel({ modelVersion: "custom" }, null, resolve)).toBeNull();
  });
});

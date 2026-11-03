import { describe, it, expect } from "vitest";
import { readinessBreakdown } from "@/lib/tools/toolsReadiness";
import { setupHint } from "@/lib/tools/setupHint";

const card = (
  key: string,
  over: Partial<{
    available: boolean;
    unverified: boolean;
    checking: boolean;
    kind: string;
    unavailableReason: string | null;
    model: string | null;
  }> = {},
) => ({
  key,
  id: key,
  title: key.toUpperCase(),
  kind: "action",
  available: false,
  ...over,
});

describe("readinessBreakdown", () => {
  const cards = [
    card("ok", { available: true }),
    card("beta_b", { available: true, unverified: true }),
    card("beta_a", { available: true, unverified: true }),
    card("ph", { kind: "placeholder" }),
    card("busy", { checking: true }),
    card("n1", { unavailableReason: "The qwen-layered pack isn't installed." }),
    card("n2", { unavailableReason: "The qwen-layered pack isn't installed." }),
    card("m1", {
      unavailableReason:
        "Model not installed: diffusion_models/fibo2_edit_turbo_bf16.safetensors. Download it.",
    }),
    card("x", { unavailableReason: null }),
  ];
  const r = readinessBreakdown(cards, (c) =>
    setupHint(c.unavailableReason, c.model),
  );

  it("groups need-setup tools by what is missing, biggest first", () => {
    expect(r.needSetup.map((g) => [g.hint, g.cards.map((c) => c.key)])).toEqual([
      ["Needs the qwen-layered pack", ["n1", "n2"]],
      ["Needs fibo2_edit_turbo_bf16", ["m1"]],
      ["Needs setup", ["x"]],
    ]);
  });

  it("lists beta tools by title and skips placeholders and checking", () => {
    expect(r.beta.map((c) => c.key)).toEqual(["beta_a", "beta_b"]);
    const all = [...r.needSetup.flatMap((g) => g.cards), ...r.beta].map(
      (c) => c.key,
    );
    expect(all).not.toContain("ph");
    expect(all).not.toContain("busy");
    expect(all).not.toContain("ok");
  });
});

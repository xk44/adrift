import { describe, it, expect } from "vitest";
import { SA3_PICK, staleSa3PickResets } from "@/lib/tools/sa3Tools";

const opts = (o: Partial<{ loras: string[]; quality: boolean; reachable: boolean }>) => ({
  loras: [],
  quality: true,
  reachable: true,
  ...o,
});

describe("staleSa3PickResets", () => {
  it("clears a LoRA pick that is no longer installed", () => {
    expect(
      staleSa3PickResets({ [SA3_PICK.lora]: "audio/gone.safetensors" }, opts({ loras: ["audio/kept.safetensors"] })),
    ).toEqual([[SA3_PICK.lora, ""]]);
  });

  it("keeps a LoRA pick that exists", () => {
    expect(
      staleSa3PickResets({ [SA3_PICK.lora]: "audio/kept.safetensors" }, opts({ loras: ["audio/kept.safetensors"] })),
    ).toEqual([]);
  });

  it("drops Quality to Fast without the Quality checkpoint", () => {
    expect(staleSa3PickResets({ [SA3_PICK.speed]: "quality" }, opts({ quality: false }))).toEqual([
      [SA3_PICK.speed, "fast"],
    ]);
  });

  it("does nothing while the server's options are unknown", () => {
    expect(
      staleSa3PickResets(
        { [SA3_PICK.lora]: "audio/x.safetensors", [SA3_PICK.speed]: "quality" },
        { loras: [], quality: false, reachable: false },
      ),
    ).toEqual([]);
  });

  it("ignores an empty LoRA pick", () => {
    expect(staleSa3PickResets({ [SA3_PICK.lora]: "" }, opts({}))).toEqual([]);
  });
});

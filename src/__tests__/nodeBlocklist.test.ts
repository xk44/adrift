import { describe, expect, it } from "vitest";

import {
  blocklistCount,
  blocklistSlugs,
  matchBlockedPackId,
  partitionBlockedPackIds,
} from "@/lib/comfy/nodeBlocklist";

describe("nodeBlocklist", () => {
  it("bundles the full sweep blocklist", () => {
    expect(blocklistCount()).toBe(37);
    expect(blocklistSlugs()).toContain("mvnt-app/comfyui-mvnt");
  });

  it("blocks an exact GitHub URL regardless of case", () => {
    const m = matchBlockedPackId("https://github.com/mvnt-app/ComfyUI-MVNT");
    expect(m).not.toBeNull();
    expect(m?.slug).toBe("mvnt-app/comfyui-mvnt");
    expect(m?.matchedOn).toBe("url");
  });

  it("blocks a GitHub URL with a trailing slash or .git suffix", () => {
    expect(
      matchBlockedPackId("https://github.com/mvnt-app/ComfyUI-MVNT/"),
    ).not.toBeNull();
    expect(
      matchBlockedPackId("https://github.com/mvnt-app/ComfyUI-MVNT.git"),
    ).not.toBeNull();
  });

  it("blocks a bare CNR id by basename", () => {
    const m = matchBlockedPackId("ComfyUI-MVNT");
    expect(m).not.toBeNull();
    expect(m?.matchedOn).toBe("basename");
    expect(m?.slug).toBe("mvnt-app/comfyui-mvnt");
  });

  it("does NOT block a same-basename repo from a different owner via URL", () => {
    // owner is authoritative for URLs — a benign fork under another owner is fine
    expect(
      matchBlockedPackId("https://github.com/someoneelse/ComfyUI-MVNT"),
    ).toBeNull();
  });

  it("does not block clean pack ids", () => {
    expect(matchBlockedPackId("comfyui-clean-nodes")).toBeNull();
    expect(
      matchBlockedPackId("https://github.com/comfyanonymous/ComfyUI"),
    ).toBeNull();
    expect(matchBlockedPackId("")).toBeNull();
    expect(matchBlockedPackId("   ")).toBeNull();
  });

  it("partitions a mixed batch", () => {
    const { allowed, blocked } = partitionBlockedPackIds([
      "comfyui-clean-nodes",
      "https://github.com/mvnt-app/ComfyUI-MVNT",
      "ComfyUI-DiscordWebhook",
    ]);
    expect(allowed).toEqual(["comfyui-clean-nodes"]);
    expect(blocked.map((b) => b.slug).sort()).toEqual([
      "dayuppy/comfyui-discordwebhook",
      "mvnt-app/comfyui-mvnt",
    ]);
  });
});

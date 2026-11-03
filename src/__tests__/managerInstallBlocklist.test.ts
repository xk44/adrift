import { afterEach, describe, expect, it, vi } from "vitest";

import { queueComfyManagerInstall } from "@/lib/comfy/manager";

/**
 * Security regression guard: blocklisted packs must NEVER reach ComfyUI-Manager.
 * queueComfyManagerInstall is the single install choke point; a blocked id must
 * be refused before any network call is made for it.
 */
describe("queueComfyManagerInstall blocklist enforcement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a blocklisted pack and never fetches for it", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    const result = await queueComfyManagerInstall(
      ["https://github.com/mvnt-app/ComfyUI-MVNT"],
      { comfyBaseUrl: "http://127.0.0.1:8188" },
    );

    expect(result.queued).toEqual([]);
    expect(result.blocked.map((b) => b.slug)).toEqual([
      "mvnt-app/comfyui-mvnt",
    ]);
    expect(result.failed).toHaveLength(1);
    // No install/start POST should have been attempted for a fully-blocked batch.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("installs a clean pack while refusing a blocked one in the same batch", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const result = await queueComfyManagerInstall(
      ["comfyui-clean-nodes", "ComfyUI-MVNT"],
      { comfyBaseUrl: "http://127.0.0.1:8188" },
    );

    expect(result.queued).toEqual(["comfyui-clean-nodes"]);
    expect(result.blocked.map((b) => b.slug)).toEqual([
      "mvnt-app/comfyui-mvnt",
    ]);
    // The clean pack's install endpoint was hit; nothing references the blocked slug.
    expect(calls.some((c) => c.includes("/manager/queue/install"))).toBe(true);
    expect(calls.join(" ").toLowerCase()).not.toContain("mvnt");
  });
});

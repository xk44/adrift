import { describe, expect, it, vi } from "vitest";

describe("environment defaults", () => {
  it("defaults ComfyUI to localhost", async () => {
    vi.resetModules();
    const { env } = await import("@/lib/env");
    expect(env.COMFY_HTTP_URL).toMatch(/^https?:\/\//);
  });
});

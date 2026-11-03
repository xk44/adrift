/**
 * A failed submit must name the backend it actually targeted: H3 jobs go to
 * the warm backend, not COMFY_HTTP_URL.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://127.0.0.1:8188" },
}));
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  assertPromptValid: vi.fn().mockResolvedValue(undefined),
  getObjectInfoCached: vi.fn().mockResolvedValue(null), // model-variant fallback: no-op
  applyOptionalNodeBypass: vi.fn(async (prompt: unknown) => ({ prompt, bypassed: [] })),
}));

import { queuePrompt } from "@/lib/comfy/http";
import type { Workflow } from "@/types";

const WF = { "1": { class_type: "KSampler", inputs: {} } } as unknown as Workflow;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("queuePrompt network errors", () => {
  it("names the warm backend when that was the target", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(queuePrompt(WF, "c1", "http://127.0.0.1:8190")).rejects.toThrow(
      "Cannot connect to ComfyUI at http://127.0.0.1:8190. Is it running?",
    );
  });

  it("names COMFY_HTTP_URL by default", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(queuePrompt(WF, "c1")).rejects.toThrow(
      "Cannot connect to ComfyUI at http://127.0.0.1:8188.",
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "@/lib/env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("env path getters", () => {
  it.each([
    "KREA_MOODBOARDS_DIR",
    "MOODBOARD_IMPORT_ROOT",
    "COMFYUI_OUTPUT_DIR",
  ] as const)("%s reads the current value on each access", (key) => {
    vi.stubEnv(key, "");
    expect(env[key]).toBe("");
    vi.stubEnv(key, "  /tmp/some/dir  ");
    expect(env[key]).toBe("/tmp/some/dir");
  });
});

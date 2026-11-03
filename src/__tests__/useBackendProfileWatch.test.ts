import { afterEach, describe, expect, it, vi } from "vitest";
import { watchBackendProfile } from "@/components/models/useBackendProfile";
import type { BackendProfile } from "@/lib/models/compat";

const PROFILE = { displayName: "Test GPU" } as unknown as BackendProfile;

afterEach(() => {
  vi.useRealTimers();
});

describe("watchBackendProfile", () => {
  it("re-checks while offline and stops once the GPU is known", async () => {
    vi.useFakeTimers();
    const get = vi
      .fn(async (): Promise<BackendProfile | null> => null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(PROFILE);
    const seen: (BackendProfile | null)[] = [];
    watchBackendProfile((p) => seen.push(p), get, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([null]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([null, PROFILE]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("stop() cancels the pending retry and drops late results", async () => {
    vi.useFakeTimers();
    const get = vi
      .fn(async (): Promise<BackendProfile | null> => null)
      .mockResolvedValue(null);
    const seen: (BackendProfile | null)[] = [];
    const stop = watchBackendProfile((p) => seen.push(p), get, 1000);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(get).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([null]);
  });
});

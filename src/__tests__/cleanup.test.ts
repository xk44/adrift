/**
 * Unit tests for cleanupStaleFiles (src/lib/cleanup.ts)
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Mock fs/promises before importing cleanup.ts
// vi.hoisted ensures fns are available inside the hoisted vi.mock factory.
// ---------------------------------------------------------------------------

const { mockReaddir, mockStat, mockUnlink } = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockStat: vi.fn(),
  mockUnlink: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    readdir: mockReaddir,
    stat: mockStat,
    unlink: mockUnlink,
  },
}));

import { cleanupStaleFiles } from "@/lib/cleanup";

const NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("cleanupStaleFiles", () => {
  it("returns 0 when directories are missing (readdir throws)", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const result = await cleanupStaleFiles();
    expect(result.deleted).toBe(0);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it("removes files older than maxAge", async () => {
    const oldMtime = NOW - 25 * 60 * 60 * 1000; // 25h ago > 24h limit
    mockReaddir.mockResolvedValue(["old.png"]);
    mockStat.mockResolvedValue({
      mtimeMs: oldMtime,
      size: 1024,
      isFile: () => true,
    });
    mockUnlink.mockResolvedValue(undefined);

    const result = await cleanupStaleFiles();
    expect(mockUnlink).toHaveBeenCalled();
    expect(result.deleted).toBeGreaterThan(0);
    expect(result.freedBytes).toBeGreaterThan(0);
  });

  it("skips files newer than maxAge", async () => {
    const recentMtime = NOW - 1 * 60 * 60 * 1000; // 1h ago < 24h limit
    mockReaddir.mockResolvedValue(["new.png"]);
    mockStat.mockResolvedValue({
      mtimeMs: recentMtime,
      size: 512,
      isFile: () => true,
    });

    const result = await cleanupStaleFiles();
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
  });

  it("skips a file when stat throws", async () => {
    mockReaddir.mockResolvedValue(["bad.png"]);
    mockStat.mockRejectedValue(new Error("EPERM"));

    const result = await cleanupStaleFiles();
    expect(result.deleted).toBe(0);
  });

  it("counts removed files across both dirs", async () => {
    const oldMtime = NOW - 8 * 24 * 60 * 60 * 1000; // 8 days > 7-day thumbnail limit
    mockReaddir.mockResolvedValue(["stale.png"]);
    mockStat.mockResolvedValue({
      mtimeMs: oldMtime,
      size: 2048,
      isFile: () => true,
    });
    mockUnlink.mockResolvedValue(undefined);

    const result = await cleanupStaleFiles();
    expect(result.deleted).toBe(2);
  });

  it("partial unlink failures don't inflate count", async () => {
    const oldMtime = NOW - 25 * 60 * 60 * 1000;
    mockReaddir
      .mockResolvedValueOnce(["a.png", "b.png"])
      .mockResolvedValueOnce([]);
    mockStat.mockResolvedValue({
      mtimeMs: oldMtime,
      size: 512,
      isFile: () => true,
    });
    mockUnlink
      .mockResolvedValueOnce(undefined) // a.png removed
      .mockRejectedValueOnce(new Error("EBUSY")); // b.png fails silently

    const result = await cleanupStaleFiles();
    expect(result.deleted).toBe(1);
    expect(result.errors).toBe(1);
  });
});

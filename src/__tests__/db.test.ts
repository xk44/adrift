/**
 * Unit tests for src/lib/db.ts — mocks better-sqlite3 entirely.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock better-sqlite3 before importing db.ts
// ---------------------------------------------------------------------------

const mockRun = vi.fn();
const mockAll = vi.fn((): unknown[] => []);
const mockExec = vi.fn();
const mockPragma = vi.fn();
const mockPrepare = vi.fn(() => ({ run: mockRun, all: mockAll }));

vi.mock("better-sqlite3", () => ({
  default: vi.fn(() => ({
    pragma: mockPragma,
    exec: mockExec,
    prepare: mockPrepare,
  })),
}));

// Import after mock is set up
import {
  insertPrompt,
  insertRun,
  insertJob,
  updateJobStatus,
  insertOutput,
  getRecentPrompts,
  getRunsByPrompt,
  getRunRowsById,
  getOutputsByJob,
  getDB,
} from "@/lib/db";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrepare.mockReturnValue({ run: mockRun, all: mockAll });
  mockAll.mockReturnValue([]);
});

describe("getDB", () => {
  it("returns a db instance (mock)", () => {
    const db = getDB();
    expect(db).toBeDefined();
  });
});

describe("insertPrompt", () => {
  it("calls prepare + run with correct args", () => {
    insertPrompt("p1", "a cat", '{"ar":"16:9"}', "workflows/t2i.json");
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("INSERT"));
    expect(mockRun).toHaveBeenCalledWith(
      "p1",
      "a cat",
      '{"ar":"16:9"}',
      "workflows/t2i.json",
    );
  });

  it("passes null for optional params when omitted", () => {
    insertPrompt("p2", "a dog");
    expect(mockRun).toHaveBeenCalledWith("p2", "a dog", null, null);
  });
});

describe("insertRun", () => {
  it("calls run with id, promptId, nodeCount", () => {
    insertRun("r1", "p1", 12);
    expect(mockRun).toHaveBeenCalledWith(
      "r1", "p1", 12, null, null, null, null,
    );
  });

  it("passes null for nodeCount when omitted", () => {
    insertRun("r2", "p2");
    expect(mockRun).toHaveBeenCalledWith(
      "r2", "p2", null, null, null, null, null,
    );
  });

  it("persists mobile-history run fields", () => {
    insertRun("r3", "p3", 3, {
      parsedPrompt: "a cat",
      params: { ar: "16:9" },
      width: 1536,
      height: 864,
    });
    expect(mockRun).toHaveBeenCalledWith(
      "r3", "p3", 3, "a cat", '{"ar":"16:9"}', 1536, 864,
    );
  });
});

describe("insertJob", () => {
  it("passes all four arguments", () => {
    insertJob("j1", "r1", 42, "comfy-abc");
    expect(mockRun).toHaveBeenCalledWith("j1", "r1", 42, "comfy-abc");
  });

  it("passes null for optional seed/comfyId", () => {
    insertJob("j2", "r2");
    expect(mockRun).toHaveBeenCalledWith("j2", "r2", null, null);
  });
});

describe("updateJobStatus", () => {
  it("sets completed_at for 'done' status", () => {
    updateJobStatus("j1", "done");
    const args = mockRun.mock.calls[0];
    expect(args[0]).toBe("done");
    expect(args[2]).toBeGreaterThan(0); // completed_at set
  });

  it("sets completed_at for 'error' status", () => {
    updateJobStatus("j1", "error", "oops");
    const args = mockRun.mock.calls[0];
    expect(args[1]).toBe("oops");
    expect(args[2]).toBeGreaterThan(0);
  });

  it("passes null completed_at for in-progress status", () => {
    updateJobStatus("j1", "running");
    const args = mockRun.mock.calls[0];
    expect(args[2]).toBeNull();
  });
});

describe("insertOutput", () => {
  it("passes all args to run including outputType", () => {
    insertOutput("j1", "img.png", "output", 1024, 768, "image");
    expect(mockRun).toHaveBeenCalledWith(
      "j1",
      "img.png",
      "output",
      1024,
      768,
      "image",
    );
  });

  it("defaults subfolder to empty string and outputType to image", () => {
    insertOutput("j1", "img.png");
    const args = mockRun.mock.calls[0];
    expect(args[2]).toBe("");
    expect(args[5]).toBe("image");
  });
});

describe("query helpers", () => {
  it("getRecentPrompts returns mock rows", () => {
    mockAll.mockReturnValueOnce([{ id: "p1", text: "cat" }]);
    const rows = getRecentPrompts(10);
    expect(rows).toHaveLength(1);
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining("prompts"),
    );
  });

  it("getRunsByPrompt queries by promptId", () => {
    mockAll.mockReturnValueOnce([]);
    getRunsByPrompt("p1");
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("runs"));
  });

  it("getRunRowsById selects one run's rows by id", () => {
    mockAll.mockReturnValueOnce([]);
    expect(getRunRowsById("run-x")).toEqual([]);
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining("WHERE r.id = ?"));
    expect(mockAll).toHaveBeenCalledWith("run-x");
  });

  it("getOutputsByJob queries by jobId", () => {
    mockAll.mockReturnValueOnce([]);
    getOutputsByJob("j1");
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining("outputs"),
    );
  });
});

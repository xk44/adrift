/**
 * Style Export / Import Tests
 * ============================
 * Tests for GET /api/style/export and POST /api/style/import.
 * fs/promises is mocked so no real disk I/O occurs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { resetRateLimits } from "@/lib/rateLimit";

// ---------------------------------------------------------------------------
// fs mock — must be hoisted before route imports
// ---------------------------------------------------------------------------

const fsMock = {
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
};

vi.mock("fs/promises", () => ({ default: fsMock }));

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const CODES_DB = {
  version: 1,
  codes: [
    {
      code: "1234567890",
      name: "anime vibes",
      tags: ["anime"],
      createdAt: 1700000000000,
      useCount: 5,
      isFavorite: true,
    },
    {
      code: "9876543210",
      name: "cyberpunk",
      tags: ["sci-fi"],
      createdAt: 1700000001000,
      useCount: 2,
      isFavorite: false,
    },
  ],
};

const LORAS_DB = {
  version: 1,
  loras: [
    {
      shortcode: "anime",
      filename: "anime_style_v2.safetensors",
      displayName: "Anime Style",
      tags: ["anime"],
      defaultStrength: 0.8,
      useCount: 10,
      isFavorite: true,
    },
  ],
  curatedSets: ["anime-pack"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exportRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/style/export${query}`);
}

function importRequest(body: unknown, query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/style/import${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Export tests
// ---------------------------------------------------------------------------

describe("GET /api/style/export", () => {
  beforeEach(() => {
    fsMock.readFile.mockImplementation((filePath: string) => {
      if (String(filePath).includes("style_codes")) {
        return Promise.resolve(JSON.stringify(CODES_DB));
      }
      if (String(filePath).includes("lora_shortcodes")) {
        return Promise.resolve(JSON.stringify(LORAS_DB));
      }
      return Promise.reject(new Error("Unknown file"));
    });
  });

  it("returns JSON blob with codes and loras", async () => {
    const { GET } = await import("@/app/api/style/export/route");
    const res = await GET(exportRequest());

    expect(res.status).toBe(200);
    const text = await res.text();
    const data = JSON.parse(text);

    expect(data.version).toBe(1);
    expect(data.styleCodes).toHaveLength(2);
    expect(data.loraShortcodes).toHaveLength(1);
    expect(data.stats.totalCodes).toBe(2);
    expect(data.stats.totalLoras).toBe(1);
  });

  it("type=codes only includes styleCodes, no loraShortcodes", async () => {
    const { GET } = await import("@/app/api/style/export/route");
    const res = await GET(exportRequest("?type=codes"));
    const data = JSON.parse(await res.text());

    expect(data.styleCodes).toBeDefined();
    expect(data.loraShortcodes).toBeUndefined();
  });

  it("type=loras only includes loraShortcodes, no styleCodes", async () => {
    const { GET } = await import("@/app/api/style/export/route");
    const res = await GET(exportRequest("?type=loras"));
    const data = JSON.parse(await res.text());

    expect(data.loraShortcodes).toBeDefined();
    expect(data.styleCodes).toBeUndefined();
  });

  it("favorites=true filters to only favorite codes", async () => {
    const { GET } = await import("@/app/api/style/export/route");
    const res = await GET(exportRequest("?type=codes&favorites=true"));
    const data = JSON.parse(await res.text());

    expect(data.styleCodes).toHaveLength(1);
    expect(data.styleCodes[0].code).toBe("1234567890");
  });

  it("returns Content-Disposition attachment header", async () => {
    const { GET } = await import("@/app/api/style/export/route");
    const res = await GET(exportRequest());

    const cd = res.headers.get("Content-Disposition");
    expect(cd).toContain("attachment");
    expect(cd).toContain(".json");
  });
});

// ---------------------------------------------------------------------------
// Import tests
// ---------------------------------------------------------------------------

describe("POST /api/style/import", () => {
  beforeEach(() => {
    resetRateLimits();
    // By default return empty DBs (nothing pre-existing)
    fsMock.readFile.mockImplementation((filePath: string) => {
      if (String(filePath).includes("style_codes")) {
        return Promise.resolve(JSON.stringify({ version: 1, codes: [] }));
      }
      if (String(filePath).includes("lora_shortcodes")) {
        return Promise.resolve(
          JSON.stringify({ version: 1, loras: [], curatedSets: [] }),
        );
      }
      return Promise.reject(new Error("Unknown file"));
    });
    fsMock.writeFile.mockResolvedValue(undefined);
  });

  it("merge mode adds new entries without overwriting existing", async () => {
    // Pre-existing DB has code 1234567890
    fsMock.readFile.mockImplementation((filePath: string) => {
      if (String(filePath).includes("style_codes")) {
        return Promise.resolve(
          JSON.stringify({
            version: 1,
            codes: [
              {
                code: "1234567890",
                name: "existing",
                createdAt: 1,
                useCount: 99,
                isFavorite: false,
              },
            ],
          }),
        );
      }
      return Promise.resolve(
        JSON.stringify({ version: 1, loras: [], curatedSets: [] }),
      );
    });

    const importPayload = {
      version: 1,
      styleCodes: [
        // duplicate — should be skipped
        {
          code: "1234567890",
          name: "new-name",
          createdAt: 2,
          useCount: 0,
          isFavorite: false,
        },
        // new entry — should be imported
        {
          code: "1111111111",
          name: "brand-new",
          createdAt: 3,
          useCount: 0,
          isFavorite: false,
        },
      ],
    };

    const { POST } = await import("@/app/api/style/import/route");
    const res = await POST(importRequest(importPayload, "?mode=merge"));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.imported.styleCodes).toBe(1);
    expect(body.skipped.styleCodes).toBe(1);

    // The written DB should preserve the existing entry
    const writtenContent = fsMock.writeFile.mock.calls.find(([p]: [string]) =>
      String(p).includes("style_codes"),
    )?.[1] as string;
    const written = JSON.parse(writtenContent);
    const codes = written.codes as Array<{ code: string; name: string }>;
    const existing = codes.find((c) => c.code === "1234567890");
    expect(existing?.name).toBe("existing"); // not overwritten
    expect(codes.some((c) => c.code === "1111111111")).toBe(true);
  });

  it("replace mode overwrites existing data", async () => {
    const importPayload = {
      version: 1,
      styleCodes: [
        {
          code: "5555555555",
          name: "replacement",
          createdAt: 1,
          useCount: 0,
          isFavorite: false,
        },
      ],
    };

    const { POST } = await import("@/app/api/style/import/route");
    const res = await POST(importRequest(importPayload, "?mode=replace"));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.imported.styleCodes).toBe(1);

    // In replace mode the DB is rebuilt from scratch — only the imported entry present
    const writtenContent = fsMock.writeFile.mock.calls.findLast(
      ([p]: [string]) => String(p).includes("style_codes"),
    )?.[1] as string;
    const written = JSON.parse(writtenContent);
    expect(written.codes).toHaveLength(1);
    expect(written.codes[0].code).toBe("5555555555");
  });

  it("rejects invalid import data (missing version)", async () => {
    const { POST } = await import("@/app/api/style/import/route");
    const res = await POST(importRequest({ styleCodes: [] }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("rejects import data with no arrays", async () => {
    const { POST } = await import("@/app/api/style/import/route");
    const res = await POST(importRequest({ version: 1 }));

    expect(res.status).toBe(400);
  });

  it("rejects a non-array styleCodes field", async () => {
    const { POST } = await import("@/app/api/style/import/route");
    const res = await POST(
      importRequest({ version: 1, styleCodes: { code: "1234567890" } }),
    );

    expect(res.status).toBe(400);
  });

  it("rejects arrays over the 10000-entry cap", async () => {
    const { POST } = await import("@/app/api/style/import/route");
    const oversized = Array.from({ length: 10001 }, (_, i) => ({
      code: String(1000000000 + i),
      name: `c${i}`,
    }));
    const res = await POST(
      importRequest({ version: 1, styleCodes: oversized }),
    );

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Round-trip test
// ---------------------------------------------------------------------------

describe("round-trip: export → import → re-export produces same codes", () => {
  it("codes survive a full round-trip", async () => {
    // Clear accumulated mock calls and rate limits from prior tests
    fsMock.writeFile.mockClear();
    resetRateLimits();

    // Step 1: export reads CODES_DB
    fsMock.readFile.mockImplementation((filePath: string) => {
      if (String(filePath).includes("style_codes")) {
        return Promise.resolve(JSON.stringify(CODES_DB));
      }
      return Promise.resolve(
        JSON.stringify({ version: 1, loras: [], curatedSets: [] }),
      );
    });

    const { GET } = await import("@/app/api/style/export/route");
    const exportRes = await GET(exportRequest("?type=codes"));
    const exportedData = JSON.parse(await exportRes.text());

    expect(exportedData.styleCodes).toHaveLength(2);

    // Step 2: import the exported data (empty DB target)
    fsMock.readFile.mockResolvedValue(
      JSON.stringify({ version: 1, codes: [] }),
    );

    const { POST } = await import("@/app/api/style/import/route");
    const importRes = await POST(importRequest(exportedData, "?mode=replace"));
    const importResult = await importRes.json();
    expect(importResult.ok).toBe(true);
    expect(importResult.imported.styleCodes).toBe(2);

    // Step 3: re-export reads what was written
    const writtenContent = fsMock.writeFile.mock.calls.findLast(
      ([p]: [string]) => String(p).includes("style_codes"),
    )?.[1] as string;
    const writtenDB = JSON.parse(writtenContent);

    // Re-export by mocking readFile to return the written DB
    fsMock.readFile.mockImplementation((filePath: string) => {
      if (String(filePath).includes("style_codes")) {
        return Promise.resolve(writtenContent);
      }
      return Promise.resolve(
        JSON.stringify({ version: 1, loras: [], curatedSets: [] }),
      );
    });

    const reExportRes = await GET(exportRequest("?type=codes"));
    const reExported = JSON.parse(await reExportRes.text());

    // Same codes present
    const originalCodes = exportedData.styleCodes
      .map((c: { code: string }) => c.code)
      .sort();
    const roundTrippedCodes = reExported.styleCodes
      .map((c: { code: string }) => c.code)
      .sort();
    expect(roundTrippedCodes).toEqual(originalCodes);
  });
});

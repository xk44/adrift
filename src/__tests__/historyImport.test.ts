/**
 * ComfyUI /history import: entry mapping, DB dedupe (real SQLite in a temp
 * dir), and the GET-only route.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({
  env: {
    ADMIN_API_KEY: "test-admin-key",
    COMFY_HTTP_URL: "http://127.0.0.1:8188",
  },
}));
vi.mock("@/lib/rateLimit", () => ({
  withRateLimit: () => ({ ok: true }),
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cj-histimport-"));
const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);

type DbModule = typeof import("@/lib/db");
type ImportModule = typeof import("@/lib/jobs/historyImport");
let db: DbModule;
let hi: ImportModule;

beforeAll(async () => {
  db = await import("@/lib/db");
  hi = await import("@/lib/jobs/historyImport");
});
afterAll(() => {
  cwdSpy.mockRestore();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const T0 = 1_760_000_000_000; // ms

function entry(
  opts: {
    status?: string;
    cj?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
  } = {},
) {
  return {
    prompt: [
      3,
      "ignored",
      {
        "3": {
          class_type: "KSampler",
          inputs: { seed: 1234, positive: ["6", 0], negative: ["7", 0] },
        },
        "5": {
          class_type: "EmptyLatentImage",
          inputs: { width: 832, height: 1216, batch_size: 1 },
        },
        "6": { class_type: "CLIPTextEncode", inputs: { text: "a red fox" } },
        "7": { class_type: "CLIPTextEncode", inputs: { text: "blurry" } },
        "9": { class_type: "SaveImage", inputs: {} },
      },
      opts.cj ? { extra_pnginfo: { cj: { v: 1, params: opts.cj } } } : {},
      ["9"],
    ],
    outputs: opts.outputs ?? {
      "9": {
        images: [
          { filename: "fox_00001_.png", subfolder: "", type: "output" },
          { filename: "preview.png", subfolder: "", type: "temp" },
        ],
      },
    },
    status: {
      status_str: opts.status ?? "success",
      completed: (opts.status ?? "success") === "success",
      messages: [
        ["execution_start", { prompt_id: "x", timestamp: T0 }],
        ["execution_success", { prompt_id: "x", timestamp: T0 + 9_000 }],
      ],
    },
  };
}

describe("historyEntryToImport", () => {
  it("maps graph prompt/seed/size, timestamps and saved outputs only", () => {
    const item = hi.historyEntryToImport("pid-graph", entry())!;
    expect(item).toMatchObject({
      comfyPromptId: "pid-graph",
      text: "a red fox",
      seed: 1234,
      width: 832,
      height: 1216,
      createdAt: Math.floor(T0 / 1000),
      completedAt: Math.floor(T0 / 1000) + 9,
      outputs: [
        { filename: "fox_00001_.png", subfolder: "", mediaType: "image" },
      ],
    });
    expect(item.params).toMatchObject({
      imported_from: "comfyui_history",
      comfy_prompt_id: "pid-graph",
    });
  });

  it("prefers the Adrift cj chunk and strips secrets from it", () => {
    const item = hi.historyEntryToImport(
      "pid-cj",
      entry({ cj: { fullPrompt: "a fox --ar 2:3", seed: 9, api_key: "sk" } }),
    )!;
    expect(item.text).toBe("a fox --ar 2:3");
    expect(item.seed).toBe(9);
    expect(item.params).not.toHaveProperty("api_key");
  });

  it("keeps VHS videos and skips failed / output-less entries", () => {
    const vid = hi.historyEntryToImport(
      "pid-vid",
      entry({
        outputs: {
          "9": {
            gifs: [
              {
                filename: "c.mp4",
                subfolder: "v",
                type: "output",
                format: "video/h264-mp4",
              },
            ],
          },
        },
      }),
    )!;
    expect(vid.outputs).toEqual([
      { filename: "c.mp4", subfolder: "v", mediaType: "video" },
    ]);
    expect(
      hi.historyEntryToImport("pid-err", entry({ status: "error" })),
    ).toBeNull();
    expect(
      hi.historyEntryToImport(
        "pid-text",
        entry({ outputs: { "9": { text: ["hi"] } } }),
      ),
    ).toBeNull();
  });
});

describe("importComfyHistory (SQLite)", () => {
  it("imports once, dedupes by prompt_id, and shows up in recent rows", () => {
    // An Adrift-submitted job already tracks this ComfyUI prompt.
    db.insertPrompt("req-1", "mine");
    db.insertRun("run-1", "req-1");
    db.insertJob("run-1:0", "run-1", 1, "pid-existing");

    const history = {
      "pid-new": entry(),
      "pid-existing": entry(),
      "pid-failed": entry({ status: "error" }),
    };
    const first = hi.importComfyHistory(history);
    expect(first).toMatchObject({
      scanned: 3,
      imported: 1,
      skipped_existing: 1,
      skipped_unusable: 1,
      imported_ids: ["pid-new"],
    });
    const again = hi.importComfyHistory(history);
    expect(again).toMatchObject({ imported: 0, skipped_existing: 2 });

    const rows = db
      .getRecentRunRows(50, 0)
      .filter((r) => r.prompt_id_comfy === "pid-new");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: "comfy-pid-new",
      prompt: "a red fox",
      job_status: "done",
      seed: 1234,
      width: 832,
      height: 1216,
      created_at: Math.floor(T0 / 1000),
      output_filename: "fox_00001_.png",
      output_type: "output",
      output_media: "image",
    });
  });
});

describe("POST /api/jobs/import-history", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  function req(body: unknown, admin = true) {
    return new NextRequest("http://localhost/api/jobs/import-history", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(admin ? { authorization: "Bearer test-admin-key" } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("requires admin", async () => {
    const { POST } = await import("@/app/api/jobs/import-history/route");
    const res = await POST(req({}, false));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only GETs /history (clamped max_items) and imports", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ "pid-route": entry() }), { status: 200 }),
    );
    const { POST } = await import("@/app/api/jobs/import-history/route");
    const res = await POST(req({ max_items: 5000 }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toMatchObject({ ok: true, max_items: 200, imported: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8188/history?max_items=200");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("rejects a bad max_items and maps upstream failures to 502", async () => {
    const { POST } = await import("@/app/api/jobs/import-history/route");
    expect((await POST(req({ max_items: 0 }))).status).toBe(400);
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    expect((await POST(req({}))).status).toBe(502);
  });
});

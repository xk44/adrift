import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const requireAdmin = vi.fn();
const withRateLimit = vi.fn();
const fetchHistory = vi.fn();
const getRecentRunRows = vi.fn();
const getRunRowsById = vi.fn();
const getOutputsByJob = vi.fn();
const updateJobStatus = vi.fn();
const insertOutput = vi.fn();

vi.mock("@/lib/auth", () => ({ requireAdmin }));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit }));
vi.mock("@/lib/comfy/http", () => ({ fetchHistory }));
vi.mock("@/lib/db", () => ({
  getRecentRunRows,
  getRunRowsById,
  getOutputsByJob,
  updateJobStatus,
  insertOutput,
}));

const doneRow = {
  run_id: "run-1",
  prompt: "amber lantern",
  parsed_prompt: "amber lantern",
  params: '{"ar":"1:1"}',
  width: 1024,
  height: 1024,
  created_at: 1_700_000_000,
  job_id: "run-1:0",
  seed: 42,
  job_status: "done",
  progress: 1,
  prompt_id_comfy: "comfy-1",
  job_error: null,
  output_filename: "amber.png",
  output_subfolder: "nested",
  output_type: "output",
};

function request(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/jobs/recent${query}`);
}

describe("GET /api/jobs/recent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdmin.mockReturnValue({ ok: true });
    withRateLimit.mockReturnValue({ ok: true });
    getOutputsByJob.mockReturnValue([]);
  });

  it("returns persisted runs in the ImagineRun wire shape", async () => {
    getRecentRunRows.mockReturnValue([doneRow]);
    const { GET } = await import("@/app/api/jobs/recent/route");
    const res = await GET(request());
    expect(await res.json()).toMatchObject({
      ok: true,
      nextOffset: null,
      runs: [{
        run_id: "run-1", prompt: "amber lantern", parsedPrompt: "amber lantern",
        width: 1024, height: 1024, params: { ar: "1:1" },
        jobs: [{ index: 0, seed: 42, status: "done", progress: 1,
          images: ["/api/comfy/image?filename=amber.png&subfolder=nested&type=output"],
          prompt_id: "comfy-1" }],
      }],
    });
    expect(getRecentRunRows).toHaveBeenCalledWith(21, 0);
  });

  it("lazy-reconciles a completed queued job before returning it", async () => {
    const pending = { ...doneRow, job_status: "queued", output_filename: null };
    getRecentRunRows
      .mockReturnValueOnce([pending])
      .mockReturnValueOnce([doneRow]);
    fetchHistory.mockResolvedValue({
      status: { completed: true, status_str: "success" },
      outputs: { "9": { images: [{ filename: "amber.png", subfolder: "nested", type: "output" }] } },
    });
    const { GET } = await import("@/app/api/jobs/recent/route");
    const data = await (await GET(request())).json();
    expect(updateJobStatus).toHaveBeenCalledWith("run-1:0", "done", undefined);
    expect(insertOutput).toHaveBeenCalledWith("run-1:0", "amber.png", "nested", undefined, undefined, "image");
    expect(data.runs[0].jobs[0]).toMatchObject({ status: "done", images: [expect.stringContaining("amber.png")] });
  });

  it("sets nextOffset when the limit has another persisted run", async () => {
    getRecentRunRows.mockReturnValue([
      doneRow,
      { ...doneRow, run_id: "run-2", job_id: "run-2:0", prompt: "second" },
    ]);
    const { GET } = await import("@/app/api/jobs/recent/route");
    const data = await (await GET(request("?limit=1&offset=3"))).json();
    expect(data).toMatchObject({ nextOffset: 4, runs: [{ run_id: "run-1" }] });
    expect(getRecentRunRows).toHaveBeenCalledWith(2, 3);
  });

  it("returns a single run by run_id", async () => {
    getRunRowsById.mockReturnValue([{ ...doneRow, run_id: "run-old", job_id: "run-old:0" }]);
    const { GET } = await import("@/app/api/jobs/recent/route");
    const data = await (await GET(request("?run_id=run-old"))).json();
    expect(data).toMatchObject({
      ok: true,
      nextOffset: null,
      runs: [{ run_id: "run-old", status: "done", jobs: [{ index: 0, status: "done" }] }],
    });
    expect(getRunRowsById).toHaveBeenCalledWith("run-old");
    expect(getRecentRunRows).not.toHaveBeenCalled();
  });

  it("returns no runs for an unknown run_id", async () => {
    getRunRowsById.mockReturnValue([]);
    const { GET } = await import("@/app/api/jobs/recent/route");
    const data = await (await GET(request("?run_id=gone"))).json();
    expect(data).toMatchObject({ ok: true, runs: [], nextOffset: null });
  });

  it("rejects a malformed run_id", async () => {
    const { GET } = await import("@/app/api/jobs/recent/route");
    const res = await GET(request("?run_id=" + encodeURIComponent("x' OR 1=1")));
    expect(res.status).toBe(400);
    expect(getRunRowsById).not.toHaveBeenCalled();
  });

  it("enforces the admin auth gate", async () => {
    requireAdmin.mockReturnValue({
      ok: false,
      response: NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 }),
    });
    const { GET } = await import("@/app/api/jobs/recent/route");
    const res = await GET(request());
    expect(res.status).toBe(401);
    expect(getRecentRunRows).not.toHaveBeenCalled();
  });
});

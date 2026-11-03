import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deleteFromQueue = vi.fn();
const getComfyCapabilities = vi.fn();

vi.mock("@/lib/env", () => ({
  env: {
    ADMIN_API_KEY: "test-admin-key",
    COMFY_HTTP_URL: "http://127.0.0.1:8188",
  },
}));

vi.mock("@/lib/rateLimit", () => ({
  withRateLimit: () => ({ ok: true }),
}));

vi.mock("@/lib/comfy/http", () => ({
  deleteFromQueue,
}));

vi.mock("@/lib/comfy/capabilities", () => ({
  getComfyCapabilities,
}));

const runningQueue = () =>
  new Response(
    JSON.stringify({
      queue_running: [[7, "prompt-running", {}, {}, []]],
      queue_pending: [],
    }),
    { status: 200 },
  );

function makeRequest(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/jobs/cancel", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/jobs/cancel", () => {
  beforeEach(() => {
    deleteFromQueue.mockReset();
    getComfyCapabilities.mockReset();
    getComfyCapabilities.mockResolvedValue({
      reachable: true,
      comfyuiVersion: "0.42.0",
      interruptPromptId: true,
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  it("requires admin auth before reading the ComfyUI queue", async () => {
    const { POST } = await import("@/app/api/jobs/cancel/route");
    const fetchMock = vi.mocked(fetch);

    const res = await POST(makeRequest({ prompt_id: "prompt-1" }));
    const data = await res.json();

    expect(res.status).toBe(401);
    expect(data).toMatchObject({ ok: false, error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deleteFromQueue).not.toHaveBeenCalled();
  });

  it("validates prompt_id before contacting ComfyUI", async () => {
    const { POST } = await import("@/app/api/jobs/cancel/route");
    const fetchMock = vi.mocked(fetch);

    const res = await POST(
      makeRequest({ prompt_id: " " }, { authorization: "Bearer test-admin-key" }),
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toBe("Missing prompt_id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes a queued prompt from ComfyUI queue", async () => {
    const { POST } = await import("@/app/api/jobs/cancel/route");
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          queue_running: [],
          queue_pending: [[12, "prompt-queued", {}, {}, []]],
        }),
        { status: 200 },
      ),
    );

    const res = await POST(
      makeRequest(
        { prompt_id: "prompt-queued" },
        { authorization: "Bearer test-admin-key" },
      ),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      action: "queue-delete",
      prompt_id: "prompt-queued",
    });
    expect(deleteFromQueue).toHaveBeenCalledWith("prompt-queued");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("interrupts an actively running prompt", async () => {
    const { POST } = await import("@/app/api/jobs/cancel/route");
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            queue_running: [[7, "prompt-running", {}, {}, []]],
            queue_pending: [],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const res = await POST(
      makeRequest(
        { prompt_id: "prompt-running" },
        { authorization: "Bearer test-admin-key" },
      ),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      action: "interrupt",
      prompt_id: "prompt-running",
    });
    expect(deleteFromQueue).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:8188/interrupt",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt_id: "prompt-running" }),
      }),
    );
  });

  it("asks for confirmation instead of a global interrupt on pre-0.3.57 servers", async () => {
    getComfyCapabilities.mockResolvedValue({
      reachable: true,
      comfyuiVersion: "0.3.40",
      interruptPromptId: false,
    });
    const { POST } = await import("@/app/api/jobs/cancel/route");
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(runningQueue());

    const res = await POST(
      makeRequest(
        { prompt_id: "prompt-running" },
        { authorization: "Bearer test-admin-key" },
      ),
    );
    const data = await res.json();

    expect(data).toMatchObject({
      ok: true,
      action: "confirm-global-interrupt",
      comfyui_version: "0.3.40",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no /interrupt
  });

  it("does the global interrupt on an old server once confirmed", async () => {
    getComfyCapabilities.mockResolvedValue({
      reachable: true,
      comfyuiVersion: "0.3.40",
      interruptPromptId: false,
    });
    const { POST } = await import("@/app/api/jobs/cancel/route");
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(runningQueue())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const res = await POST(
      makeRequest(
        { prompt_id: "prompt-running", confirm_global: true },
        { authorization: "Bearer test-admin-key" },
      ),
    );
    const data = await res.json();

    expect(data).toMatchObject({ ok: true, action: "interrupt" });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://127.0.0.1:8188/interrupt",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("returns not-found when the prompt is in neither queue", async () => {
    const { POST } = await import("@/app/api/jobs/cancel/route");
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          queue_running: [],
          queue_pending: [[1, "other-prompt", {}, {}, []]],
        }),
        { status: 200 },
      ),
    );

    const res = await POST(
      makeRequest(
        { prompt_id: "missing-prompt" },
        { authorization: "Bearer test-admin-key" },
      ),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      action: "not-found",
      prompt_id: "missing-prompt",
    });
    expect(deleteFromQueue).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a gateway error when ComfyUI queue lookup fails", async () => {
    const { POST } = await import("@/app/api/jobs/cancel/route");
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    const res = await POST(
      makeRequest(
        { prompt_id: "prompt-1" },
        { authorization: "Bearer test-admin-key" },
      ),
    );
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data).toMatchObject({ ok: false, error: "ComfyUI returned 500" });
    expect(deleteFromQueue).not.toHaveBeenCalled();
  });
});

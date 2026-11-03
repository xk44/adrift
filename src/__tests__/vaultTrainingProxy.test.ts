import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const fetchMock = vi.fn();

type RouteModule = typeof import("@/app/api/vault/[...path]/route");
type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function request(path: string, init: NextRequestInit = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, init);
}

async function loadRoute(): Promise<RouteModule> {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({
    env: {
      ADMIN_API_KEY: "",
      COMFY_HTTP_URL: "http://127.0.0.1:8188",
      COMFY_ROOT: "/tmp/adrift-test-comfyui",
      COMFY_DEFAULT_CHECKPOINT: "",
      CIVITAI_API_URL: "https://civitai.com/api/v1",
      CIVITAI_API_KEY: "",
      CIVITAI_API_KEY_ENCRYPTED: "",
      SECRETS_PASSPHRASE: "",
      STYLEVAULT_API_URL: "http://127.0.0.1:8000",
      NODE_ENV: "test",
    },
  }));
  return import("@/app/api/vault/[...path]/route");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A service that answers, with or without a trainer installed. */
function mockService(hasTrainer: boolean) {
  fetchMock.mockImplementation(async (url: string) =>
    url.endsWith("/training/backends")
      ? json({ backends: [{ name: "ai-toolkit", installed: hasTrainer }] })
      : json({}),
  );
}

function jobPosts() {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/training/jobs"));
}

describe("/api/vault training proxy", () => {
  it("forwards GET /training/backends to StyleVault", async () => {
    const backends = [{ name: "ai-toolkit", installed: true }];
    fetchMock.mockResolvedValueOnce(json({ backends }));
    const { GET } = await loadRoute();

    const res = await GET(request("/api/vault/training/backends"), {
      params: Promise.resolve({ path: ["training", "backends"] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ backends });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/training/backends",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("forwards training deploy POST bodies", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          deployed_path: "/tmp/loras/ink.safetensors",
          lora_name: "ink.safetensors",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { POST } = await loadRoute();

    const res = await POST(
      request("/api/vault/training/jobs/job-123/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lora_dir: "/tmp/adrift-test-comfyui/models/loras/styles" }),
      }),
      {
        params: Promise.resolve({
          path: ["training", "jobs", "job-123", "deploy"],
        }),
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lora_name: "ink.safetensors" });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:8000/training/jobs/job-123/deploy",
    );
    expect(init.method).toBe("POST");
    await expect(new Response(init.body).json()).resolves.toEqual({
      lora_dir: "/tmp/adrift-test-comfyui/models/loras/styles",
    });
  });

  it.each([
    ["~/ComfyUI/models/loras"],
    ["/etc"],
    ["/tmp/adrift-test-comfyui/models/checkpoints"],
    ["/tmp/adrift-test-comfyui/models/loras/../../custom_nodes"],
    ["/tmp/adrift-test-comfyui/models/loras-evil"],
    ["relative/loras"],
  ])("rejects deploy lora_dir outside COMFY_ROOT/models/loras: %s", async (dir) => {
    const { POST } = await loadRoute();
    const res = await POST(
      request("/api/vault/training/jobs/job-123/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lora_dir: dir }),
      }),
      { params: Promise.resolve({ path: ["training", "jobs", "job-123", "deploy"] }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/COMFY_ROOT\/models\/loras/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards a deploy without lora_dir untouched (StyleVault default folder)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ lora_name: "a.safetensors" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { POST } = await loadRoute();
    const res = await POST(
      request("/api/vault/training/jobs/job-9/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ink" }),
      }),
      { params: Promise.resolve({ path: ["training", "jobs", "job-9", "deploy"] }) },
    );
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    await expect(new Response(init.body).json()).resolves.toEqual({ name: "ink" });
  });

  function trainingPost(body: string) {
    return request("/api/vault/training/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  }
  const jobsParams = { params: Promise.resolve({ path: ["training", "jobs"] }) };

  it("refuses a client-supplied dataset.images_dir (StyleVault would write captions there)", async () => {
    vi.stubEnv("CJ_VAULT_DATASET_ROOTS", "");
    const { POST } = await loadRoute();
    const res = await POST(
      trainingPost(JSON.stringify({ dataset: { images_dir: "~/.ssh" }, name: "x" })),
      jobsParams,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("refuses non-JSON bodies that smuggle images_dir", async () => {
    const { POST } = await loadRoute();
    const res = await POST(trainingPost('{"dataset":{"images_dir":"/etc"'), jobsParams);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows images_dir inside CJ_VAULT_DATASET_ROOTS, but not traversal out of it", async () => {
    vi.stubEnv("CJ_VAULT_DATASET_ROOTS", "/data/datasets");
    mockService(true);
    const { POST } = await loadRoute();
    const ok = await POST(
      trainingPost(JSON.stringify({ dataset: { images_dir: "/data/datasets/ink" } })),
      jobsParams,
    );
    expect(ok.status).toBe(200);
    const sent = jobPosts()[0]?.[1] as RequestInit;
    await expect(new Response(sent.body).json()).resolves.toEqual({
      dataset: { images_dir: "/data/datasets/ink" },
    });
    for (const dir of ["/data/datasets/../../etc", "/data/datasets-evil", "data/datasets/x"]) {
      const res = await POST(
        trainingPost(JSON.stringify({ dataset: { images_dir: dir } })),
        jobsParams,
      );
      expect(res.status, dir).toBe(400);
    }
    vi.unstubAllEnvs();
  });

  it("forwards cluster-based training jobs untouched", async () => {
    mockService(true);
    const { POST } = await loadRoute();
    const res = await POST(
      trainingPost(JSON.stringify({ dataset: { cluster_id: "c1" } })),
      jobsParams,
    );
    expect(res.status).toBe(200);
    expect(jobPosts()).toHaveLength(1);
  });

  it("does not send a job to a service with no trainer", async () => {
    mockService(false);
    const { POST } = await loadRoute();
    const res = await POST(
      trainingPost(JSON.stringify({ dataset: { cluster_id: 1 } })),
      jobsParams,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("library service");
    expect(jobPosts()).toHaveLength(0);
  });

  it("lists local trainers when the service has none", async () => {
    fetchMock.mockResolvedValueOnce(json({ backends: [] }));
    const { GET } = await loadRoute();
    const res = await GET(request("/api/vault/training/backends"), {
      params: Promise.resolve({ path: ["training", "backends"] }),
    });
    expect(res.status).toBe(200);
    const names = (await res.json()).backends.map((b: { name: string }) => b.name);
    expect(names).toEqual(["musubi-tuner", "ai-toolkit"]);
  });

  // JSON.parse refuses NaN, Python's json.loads takes it: both must see one body.
  it("refuses a body that only Python would parse", async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      trainingPost('{"run_name":"x","params":{"lr":NaN}}'),
      jobsParams,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only allows the rate action on assets", async () => {
    fetchMock.mockImplementation(async () => json({}));
    const { POST } = await loadRoute();
    for (const action of ["open", "reveal", "delete"]) {
      const res = await POST(
        request(`/api/vault/assets/42/${action}`, { method: "POST" }),
        { params: Promise.resolve({ path: ["assets", "42", action] }) },
      );
      expect(res.status, action).toBeGreaterThanOrEqual(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    const rated = await POST(
      request("/api/vault/assets/42/rate", {
        method: "POST",
        body: JSON.stringify({ rating: 1 }),
        headers: { "Content-Type": "application/json" },
      }),
      { params: Promise.resolve({ path: ["assets", "42", "rate"] }) },
    );
    expect(rated.status).toBe(200);
  });

  it("does not rate limit a page of thumbnails", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response("x", { status: 200, headers: { "Content-Type": "image/webp" } }),
    );
    const { GET } = await loadRoute();
    for (let i = 0; i < 150; i++) {
      const res = await GET(request(`/api/vault/assets/${i}/thumb`), {
        params: Promise.resolve({ path: ["assets", String(i), "thumb"] }),
      });
      expect(res.status).toBe(200);
    }
  });

  it("caps chunked training bodies without Content-Length", async () => {
    const { POST } = await loadRoute();
    const big = new Uint8Array(2_097_153).fill(32);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(big.subarray(0, 1_000_000));
        c.enqueue(big.subarray(1_000_000));
        c.close();
      },
    });
    const res = await POST(
      request("/api/vault/training/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stream,
        duplex: "half",
      } as NextRequestInit),
      jobsParams,
    );
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves HTML/SVG from StyleVault as an inert sandboxed download", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<svg onload=alert(1)>", {
        status: 200,
        headers: { "Content-Type": "image/svg+xml" },
      }),
    );
    const { GET } = await loadRoute();
    const res = await GET(request("/api/vault/assets/a1/file"), {
      params: Promise.resolve({ path: ["assets", "a1", "file"] }),
    });
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("passes image and JSON content types through with nosniff", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("x", { status: 200, headers: { "Content-Type": "image/webp" } }),
    );
    const { GET } = await loadRoute();
    const res = await GET(request("/api/vault/assets/a1/thumb"), {
      params: Promise.resolve({ path: ["assets", "a1", "thumb"] }),
    });
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

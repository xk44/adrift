/**
 * POST/GET /api/civitai/download against a real temp ComfyUI root.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const h = vi.hoisted(() => ({ root: "", wildcards: "" }));

vi.mock("@/lib/civitai", () => ({
  fetchCivitaiModelVersion: vi.fn(),
  sourceFromNsfw: (nsfw?: boolean) => (nsfw ? "red" : "com"),
}));
vi.mock("@/lib/civitaiConfig", () => ({
  getCivitaiApiKey: vi.fn().mockResolvedValue("secret-key"),
  getCivitaiConfig: vi.fn().mockResolvedValue({ showNsfw: false }),
}));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/env", () => ({
  env: {
    get COMFY_ROOT() {
      return h.root;
    },
    COMFY_HTTP_URL: "http://127.0.0.1:8188",
    CIVITAI_API_URL: "https://civitai.com/api/v1",
  },
}));
vi.mock("@/lib/wildcardsFs", () => ({ wildcardRoot: () => h.wildcards }));

import { fetchCivitaiModelVersion } from "@/lib/civitai";
import { getCivitaiConfig } from "@/lib/civitaiConfig";
import { GET, POST } from "@/app/api/civitai/download/route";

const mockFetchVersion = vi.mocked(fetchCivitaiModelVersion);
const BYTES = new TextEncoder().encode("fake-model-bytes");
const SHA = createHash("sha256").update(BYTES).digest("hex").toUpperCase();

function version(overrides: Record<string, unknown> = {}, files?: unknown[]) {
  return {
    id: 12345,
    name: "v1.0",
    modelId: 100,
    downloadUrl: "https://civitai.com/api/download/models/12345",
    trainedWords: ["trigger"],
    baseModel: "SDXL",
    model: { name: "M", type: "LORA" },
    files: files ?? [
      {
        id: 1,
        name: "mymodel.safetensors",
        sizeKB: BYTES.byteLength / 1024,
        downloadUrl: "https://civitai.com/api/download/models/12345?type=Model",
        hashes: { SHA256: SHA },
        primary: true,
        type: "Model",
      },
      {
        id: 2,
        name: "old.pt",
        sizeKB: BYTES.byteLength / 1024,
        downloadUrl:
          "https://civitai.com/api/download/models/12345?type=Model&format=PickleTensor",
        type: "Model",
      },
      {
        id: 3,
        name: "data.zip",
        sizeKB: 1,
        downloadUrl:
          "https://civitai.com/api/download/models/12345?type=Training%20Data",
        type: "Training Data",
      },
    ],
    images: [],
    ...overrides,
  } as never;
}

function okBody(): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(BYTES);
        c.close();
      },
    }),
    { status: 200 },
  );
}

function req(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/civitai/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BODY = {
  modelVersionId: 12345,
  filename: "mymodel.safetensors",
  targetDir: "loras",
};
let fetchMock: Mock;

beforeEach(() => {
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-civ-"));
  h.wildcards = path.join(h.root, "adrift-wildcards");
  mockFetchVersion.mockReset();
  mockFetchVersion.mockResolvedValue(version());
  vi.mocked(getCivitaiConfig).mockResolvedValue({ showNsfw: false } as never);
  fetchMock = vi.fn(async () => okBody());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe("POST /api/civitai/download", () => {
  it("downloads the bound file into the folder for its type", async () => {
    const res = await POST(req(BODY));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toMatchObject({
      ok: true,
      dest: "loras",
      sha256: SHA,
      trainedWords: ["trigger"],
    });
    const file = path.join(
      fs.realpathSync(h.root),
      "models",
      "loras",
      "mymodel.safetensors",
    );
    expect(data.path).toBe(file);
    expect(fs.readFileSync(file)).toEqual(Buffer.from(BYTES));
    // Uses the file's own URL, with the key only on civitai.com.
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://civitai.com/api/download/models/12345?type=Model",
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer secret-key",
    );
    expect(
      fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".part")),
    ).toEqual([]);
  });

  it("resolves the version with nsfw/source rules", async () => {
    await POST(req({ ...BODY, nsfw: true }));
    expect(mockFetchVersion).toHaveBeenLastCalledWith(12345, true, "red");
    await POST(req({ ...BODY, nsfw: false, source: "red" }));
    expect(mockFetchVersion).toHaveBeenLastCalledWith(12345, false, "red");
    vi.mocked(getCivitaiConfig).mockResolvedValue({ showNsfw: true } as never);
    await POST(req({ ...BODY, filename: "mymodel.safetensors" }));
    expect(mockFetchVersion).toHaveBeenLastCalledWith(12345, true, "red");
  });

  it("validates input", async () => {
    for (const [body, pattern] of [
      [{ ...BODY, modelVersionId: undefined }, /modelVersionId/],
      [{ ...BODY, modelVersionId: "12345" }, /modelVersionId/],
      [{ ...BODY, filename: undefined }, /filename/],
      [{ ...BODY, filename: "../../../etc/passwd" }, /filename/i],
      [{ ...BODY, targetDir: "../../etc" }, /targetDir/],
      [{ ...BODY, targetDir: "custom_nodes" }, /targetDir/],
    ] as const) {
      const res = await POST(req(body as Record<string, unknown>));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(pattern);
    }
    const bad = new NextRequest("http://localhost/api/civitai/download", {
      method: "POST",
      body: "not-json",
    });
    expect((await POST(bad)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a filename that isn't one of the version's files", async () => {
    const res = await POST(req({ ...BODY, filename: "payload.safetensors" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(
      /isn't part of this model version/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("server-checks the folder against Civitai's reported type", async () => {
    const res = await POST(req({ ...BODY, targetDir: "checkpoints" }));
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data).toMatchObject({ expectedDir: "loras" });
    expect(data.error).toMatch(/belongs in models\/loras/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses browse-only files with the reason", async () => {
    const res = await POST(req({ ...BODY, filename: "data.zip" }));
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.browseOnly).toBe(true);
    mockFetchVersion.mockResolvedValue(
      version({ model: { type: "AestheticGradient" } }),
    );
    const res2 = await POST(req(BODY));
    expect((await res2.json()).error).toMatch(/no loader/);
  });

  it.each([
    ["DoRA", "loras"],
    ["Hypernetwork", "hypernetworks"],
    ["MotionModule", "animatediff_models"],
    ["UNet", "diffusion_models"],
    ["TextEncoder", "text_encoders"],
    ["CLIPVision", "clip_vision"],
  ])("%s lands in models/%s", async (type, dir) => {
    mockFetchVersion.mockResolvedValue(version({ model: { type } }));
    const res = await POST(req({ ...BODY, targetDir: dir }));
    expect(res.status).toBe(200);
    expect(
      fs.existsSync(path.join(h.root, "models", dir, "mymodel.safetensors")),
    ).toBe(true);
  });

  it("puts detection, poses, wildcards and workflows where they load", async () => {
    const cases: Array<[string, string, string, string]> = [
      [
        "Detection",
        "face_yolov8m-seg.pt",
        "ultralytics/segm",
        path.join(h.root, "models", "ultralytics", "segm"),
      ],
      ["Poses", "pose.png", "poses", path.join(h.root, "input", "poses")],
      ["Wildcards", "Hair Colors.txt", "wildcards", h.wildcards],
      [
        "Workflows",
        "flow.json",
        "workflows",
        path.join(h.root, "user", "default", "workflows"),
      ],
    ];
    for (const [type, name, dest, dir] of cases) {
      mockFetchVersion.mockResolvedValue(
        version({ model: { type } }, [
          {
            id: 9,
            name,
            sizeKB: BYTES.byteLength / 1024,
            downloadUrl: "https://civitai.com/api/download/models/1",
            type: "Model",
            primary: true,
          },
        ]),
      );
      fetchMock.mockImplementation(async () => okBody());
      const res = await POST(
        req({ ...BODY, filename: name, targetDir: dest, acceptPickle: true }),
      );
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(path.dirname(data.path)).toBe(fs.realpathSync(dir));
    }
    expect(fs.existsSync(path.join(h.wildcards, "hair-colors.txt"))).toBe(true);
  });

  it("accepts latent_upscale_models for files that belong there by extension", async () => {
    mockFetchVersion.mockResolvedValue(version({ model: undefined }));
    const res = await POST(
      req({ ...BODY, targetDir: "latent_upscale_models" }),
    );
    expect(res.status).toBe(200);
  });

  it("asks before downloading a pickle file", async () => {
    const res = await POST(req({ ...BODY, filename: "old.pt" }));
    const data = await res.json();
    expect(res.status).toBe(409);
    expect(data.needsPickleAck).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const ok = await POST(
      req({ ...BODY, filename: "old.pt", fileId: 2, acceptPickle: true }),
    );
    expect(ok.status).toBe(200);
  });

  it("skips an identical file and refuses to silently replace a different one", async () => {
    expect((await POST(req(BODY))).status).toBe(200);
    const again = await (await POST(req(BODY))).json();
    expect(again).toMatchObject({ ok: true, skipped: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const file = path.join(h.root, "models", "loras", "mymodel.safetensors");
    fs.writeFileSync(file, "something else entirely");
    const conflict = await POST(req(BODY));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).conflict).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("something else entirely");

    const replaced = await POST(req({ ...BODY, overwrite: true }));
    expect(replaced.status).toBe(200);
    expect(fs.readFileSync(file)).toEqual(Buffer.from(BYTES));
  });

  it("follows a model-type folder linked to another drive", async () => {
    const elsewhere = path.join(h.root, "big-drive-loras");
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(h.root, "models"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(h.root, "models", "loras"));
    const res = await POST(req(BODY));
    expect(res.status).toBe(200);
    expect(fs.readdirSync(elsewhere)).toEqual(["mymodel.safetensors"]);
  });

  it("refuses a symlinked sub-folder below the model-type folder", async () => {
    mockFetchVersion.mockResolvedValue(
      version({ model: { name: "M", type: "Detection" } }, [
        {
          id: 9,
          name: "face_yolov8n.safetensors",
          sizeKB: BYTES.byteLength / 1024,
          downloadUrl: "https://civitai.com/api/download/models/12345",
          hashes: { SHA256: SHA },
          primary: true,
          type: "Model",
        },
      ]),
    );
    const outside = path.join(h.root, "elsewhere");
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(h.root, "models", "ultralytics"), {
      recursive: true,
    });
    fs.symlinkSync(outside, path.join(h.root, "models", "ultralytics", "bbox"));
    const res = await POST(
      req({
        modelVersionId: 12345,
        filename: "face_yolov8n.safetensors",
        targetDir: "ultralytics/bbox",
      }),
    );
    expect(res.status).toBe(400);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses a symlink sitting at the final path", async () => {
    const dir = path.join(h.root, "models", "loras");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(
      path.join(h.root, "victim"),
      path.join(dir, "mymodel.safetensors"),
    );
    const res = await POST(req({ ...BODY, overwrite: true }));
    expect(res.status).toBe(400);
    expect(fs.existsSync(path.join(h.root, "victim"))).toBe(false);
  });

  it("stops redirects to non-allowlisted hosts and keeps the key off the CDN", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("civitai.com")
        ? new Response(null, {
            status: 307,
            headers: { location: "https://bucket.r2.cloudflarestorage.com/x" },
          })
        : okBody(),
    );
    expect((await POST(req(BODY))).status).toBe(200);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBeUndefined();

    fs.rmSync(path.join(h.root, "models"), { recursive: true });
    fetchMock.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1.nip.io/x" },
        }),
    );
    const res = await POST(req(BODY));
    expect(res.status).toBe(502);
    expect(
      fs.existsSync(
        path.join(h.root, "models", "loras", "mymodel.safetensors"),
      ),
    ).toBe(false);
  });

  it("fails on checksum mismatch and saves nothing", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(new TextEncoder().encode("tampered-bytes!!"), {
          status: 200,
        }),
    );
    const res = await POST(req(BODY));
    expect(res.status).toBe(502);
    expect(fs.readdirSync(path.join(h.root, "models", "loras"))).toEqual([]);
  });

  it("caps bytes near Civitai's reported size", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(new Uint8Array(3 * 1024 * 1024), { status: 200 }),
    );
    const res = await POST(req(BODY));
    expect(res.status).toBe(413);
    expect(fs.readdirSync(path.join(h.root, "models", "loras"))).toEqual([]);
  });

  it("maps 401 to needsAuth", async () => {
    fetchMock.mockImplementation(
      async () => new Response("no", { status: 401 }),
    );
    const data = await (await POST(req(BODY))).json();
    expect(data).toMatchObject({ ok: false, needsAuth: true });
  });

  it("returns 404 when the version is missing", async () => {
    mockFetchVersion.mockResolvedValue(null);
    expect((await POST(req(BODY))).status).toBe(404);
  });
});

describe("GET /api/civitai/download progress", () => {
  it("reports progress for a finished download and rejects odd keys", async () => {
    await POST(req(BODY));
    const res = await GET(
      new NextRequest(
        "http://localhost/api/civitai/download?key=civitai:12345:mymodel.safetensors",
      ),
    );
    const data = await res.json();
    expect(data).toMatchObject({ ok: true, active: false, percent: 100 });
    const bad = await GET(
      new NextRequest("http://localhost/api/civitai/download?key=/etc/passwd"),
    );
    expect(bad.status).toBe(400);
  });
});

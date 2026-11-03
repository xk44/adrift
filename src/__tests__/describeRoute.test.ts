import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs/promises";
import os from "os";
import path from "path";

const fetchMock = vi.fn();

async function loadRoute(cwd: string, kreaRoot: string) {
  vi.resetModules();
  vi.stubEnv("KREA_MOODBOARDS_DIR", kreaRoot);
  vi.stubEnv("STYLEVAULT_API_URL", "http://stylevault.test");
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.stubGlobal("fetch", fetchMock);
  return import("@/app/api/describe/route");
}

function requestWithFile(file: File): NextRequest {
  const form = new FormData();
  form.set("image", file);
  return new NextRequest("http://localhost:3000/api/describe", {
    method: "POST",
    body: form,
  });
}

function requestWithSource(source: string): NextRequest {
  const form = new FormData();
  form.set("source", source);
  return new NextRequest("http://localhost:3000/api/describe", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("POST /api/describe", () => {
  it("forwards uploaded image bytes to StyleVault and returns four suggestions", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-describe-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    await fs.mkdir(cwd);
    await fs.mkdir(kreaRoot);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ caption: "a ceramic vase on a sunlit table." }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(
      requestWithFile(
        new File([new Uint8Array([1, 2, 3])], "vase.png", {
          type: "image/png",
        }),
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      caption: "a ceramic vase on a sunlit table.",
    });
    expect(body.suggestions).toHaveLength(4);
    expect(body.suggestions[0]).toContain("a ceramic vase on a sunlit table");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toContain("http://stylevault.test/caption/image");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "image/png" });
  });

  it("rejects absolute paths outside trusted roots before calling StyleVault", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-describe-"));
    const cwd = path.join(tmp, "app");
    const kreaRoot = path.join(tmp, "krea");
    const outside = path.join(tmp, "outside.png");
    await fs.mkdir(cwd);
    await fs.mkdir(kreaRoot);
    await fs.writeFile(outside, Buffer.from([1, 2, 3]));
    const { POST } = await loadRoute(cwd, kreaRoot);

    const res = await POST(requestWithSource(outside));

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses private, loopback and metadata source URLs (safeFetch) before calling StyleVault", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cj-describe-"));
    const { POST } = await loadRoute(tmp, path.join(tmp, "krea"));
    for (const src of [
      "http://169.254.169.254/latest/meta-data/iam.png",
      "http://127.0.0.1:3000/api/comfy/image?filename=a.png",
      "http://10.0.0.2/a.png",
    ]) {
      const res = await POST(requestWithSource(src));
      expect(res.status, src).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flattens a markdown caption sheet into one prose line", async () => {
    const { plainCaption } = await import("@/lib/describeCaption");
    const raw =
      "**Visual Prompt:**\n\n**Subject:** A round cartoon character in a pink dress\n\n" +
      "**Setting:** Flat blue sky over green ground.\n- **Style:** bold vector shapes";
    expect(plainCaption(raw)).toBe(
      "A round cartoon character in a pink dress. Flat blue sky over green ground. bold vector shapes.",
    );
    expect(plainCaption("a ceramic vase on a sunlit table.")).toBe("a ceramic vase on a sunlit table.");
  });
});

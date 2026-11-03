import { describe, expect, it, vi } from "vitest";
import {
  downloadCapped,
  isAllowedDownloadHost,
  parseCivitaiWorkflowUrl,
  pickWorkflowFile,
} from "@/lib/userTools/civitaiImport";

const R2 =
  "https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/file.zip?sig=1";

function res(
  status: number,
  body?: BodyInit | null,
  headers: Record<string, string> = {},
): Response {
  return new Response(body ?? null, { status, headers });
}

describe("parseCivitaiWorkflowUrl", () => {
  it("parses model, version and download urls", () => {
    expect(
      parseCivitaiWorkflowUrl(
        "https://civitai.com/models/123/cool-flow?modelVersionId=456",
      ),
    ).toEqual({
      source: "com",
      modelId: 123,
      versionId: 456,
    });
    expect(parseCivitaiWorkflowUrl("https://civitai.com/models/123")).toEqual({
      source: "com",
      modelId: 123,
    });
    expect(parseCivitaiWorkflowUrl("https://civitai.red/models/9/x")).toEqual({
      source: "red",
      modelId: 9,
    });
    expect(
      parseCivitaiWorkflowUrl("https://civitai.com/api/download/models/77"),
    ).toEqual({
      source: "com",
      versionId: 77,
    });
  });

  it("rejects other hosts, http and other paths", () => {
    expect(parseCivitaiWorkflowUrl("http://civitai.com/models/1")).toBeNull();
    expect(
      parseCivitaiWorkflowUrl("https://civitai.com.evil.io/models/1"),
    ).toBeNull();
    expect(parseCivitaiWorkflowUrl("https://evil.io/models/1")).toBeNull();
    expect(parseCivitaiWorkflowUrl("https://civitai.com/images/1")).toBeNull();
    expect(parseCivitaiWorkflowUrl("https://civitai.com/models/0")).toBeNull();
    expect(parseCivitaiWorkflowUrl("not a url")).toBeNull();
  });
});

describe("host allowlist", () => {
  it("allows civitai and its delivery buckets only", () => {
    expect(isAllowedDownloadHost("civitai.com")).toBe(true);
    expect(isAllowedDownloadHost("b2.civitai.com")).toBe(true);
    expect(isAllowedDownloadHost(new URL(R2).hostname)).toBe(true);
    expect(isAllowedDownloadHost("evil.r2.cloudflarestorage.com")).toBe(false);
    expect(isAllowedDownloadHost("civitai.com.evil.io")).toBe(false);
    expect(isAllowedDownloadHost("127.0.0.1")).toBe(false);
  });
});

describe("pickWorkflowFile", () => {
  it("prefers json, then zip, then png; skips model files", () => {
    const f = (name: string, primary = false) => ({
      name,
      sizeKB: 1,
      downloadUrl: `https://civitai.com/${name}`,
      primary,
    });
    expect(
      pickWorkflowFile([f("a.safetensors", true), f("b.zip"), f("c.json")])
        ?.name,
    ).toBe("c.json");
    expect(pickWorkflowFile([f("a.png"), f("b.zip")])?.name).toBe("b.zip");
    expect(pickWorkflowFile([f("archive", true)])?.name).toBe("archive");
    expect(pickWorkflowFile([])).toBeNull();
  });
});

describe("downloadCapped", () => {
  it("follows allowed redirects and sends the key to Civitai only", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      if (url.startsWith("https://civitai.com/")) {
        expect(h.Authorization).toBe("Bearer k");
        return res(307, null, { location: R2 });
      }
      expect(h.Authorization).toBeUndefined();
      return res(200, "hello");
    });
    const out = await downloadCapped(
      "https://civitai.com/api/download/models/1",
      {
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(Buffer.from(out).toString()).toBe("hello");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses redirects to other hosts", async () => {
    const fetchImpl = vi.fn(async () =>
      res(302, null, { location: "https://evil.io/x" }),
    );
    await expect(
      downloadCapped("https://civitai.com/api/download/models/1", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/not allowed: evil.io/);
  });

  it("stops after too many redirects", async () => {
    const fetchImpl = vi.fn(async () =>
      res(302, null, { location: "https://civitai.com/again" }),
    );
    await expect(
      downloadCapped("https://civitai.com/x", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Too many redirects/);
  });

  it("caps size by header and by stream", async () => {
    const big = vi.fn(async () =>
      res(200, "x", { "content-length": "999999999" }),
    );
    await expect(
      downloadCapped("https://civitai.com/x", {
        fetchImpl: big as unknown as typeof fetch,
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ status: 413 });
    const streamed = vi.fn(async () => res(200, "y".repeat(500)));
    await expect(
      downloadCapped("https://civitai.com/x", {
        fetchImpl: streamed as unknown as typeof fetch,
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("maps auth failures and idle timeouts to plain messages", async () => {
    const denied = vi.fn(async () => res(401, "no"));
    await expect(
      downloadCapped("https://civitai.com/x", {
        fetchImpl: denied as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/API key/);

    const stalled = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("a"));
          init?.signal?.addEventListener("abort", () =>
            controller.error(new Error("aborted")),
          );
        },
      });
      return res(200, body);
    });
    await expect(
      downloadCapped("https://civitai.com/x", {
        fetchImpl: stalled as unknown as typeof fetch,
        idleTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({ status: 504 });
  });
});

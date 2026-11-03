import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  DownloadError,
  downloadToFile,
  hostMatches,
} from "@/lib/net/downloadToFile";
import {
  SafeDestError,
  finalizeTemp,
  inspectDest,
  resolveContainedDir,
  uniqueName,
  validateLeafName,
} from "@/lib/fs/safeDest";
import {
  addProgress,
  finishProgress,
  getProgress,
  progressPercent,
  startProgress,
} from "@/lib/net/downloadProgress";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-dl-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function bodyResponse(
  chunks: Uint8Array[],
  init: ResponseInit & { contentLength?: number } = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
  const headers = new Headers(init.headers);
  if (init.contentLength !== undefined)
    headers.set("content-length", String(init.contentLength));
  return new Response(stream, { status: init.status ?? 200, headers });
}

const allowExample = (h: string) => hostMatches(h, ["example.com"]);

describe("hostMatches", () => {
  it("matches the domain and its subdomains only", () => {
    expect(hostMatches("example.com", ["example.com"])).toBe(true);
    expect(hostMatches("cdn.example.com", ["example.com"])).toBe(true);
    expect(hostMatches("evilexample.com", ["example.com"])).toBe(false);
    expect(hostMatches("example.com.evil.io", ["example.com"])).toBe(false);
  });
});

describe("downloadToFile", () => {
  it("writes the body, hashes it and reports progress", async () => {
    const dest = path.join(dir, "a.bin");
    const onBytes = vi.fn();
    const fetchImpl = vi.fn(async () =>
      bodyResponse([new Uint8Array([1, 2]), new Uint8Array([3])]),
    );
    const res = await downloadToFile({
      url: "https://example.com/f",
      dest,
      allowHost: allowExample,
      maxBytes: 10,
      onBytes,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.bytes).toBe(3);
    expect(fs.readFileSync(dest)).toEqual(Buffer.from([1, 2, 3]));
    expect(res.sha256).toMatch(/^[0-9A-F]{64}$/);
    expect(onBytes.mock.calls.map((c) => c[0])).toEqual([2, 1]);
  });

  it("follows redirects by hand, checks each host, and drops auth off-origin", async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      seen.push({ url, auth });
      if (url.startsWith("https://example.com/"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.com/blob" },
        });
      return bodyResponse([new Uint8Array([9])]);
    });
    await downloadToFile({
      url: "https://example.com/f",
      dest: path.join(dir, "b.bin"),
      allowHost: allowExample,
      headersFor: (u): Record<string, string> =>
        u.hostname === "example.com" ? { Authorization: "Bearer k" } : {},
      maxBytes: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(seen).toEqual([
      { url: "https://example.com/f", auth: "Bearer k" },
      { url: "https://cdn.example.com/blob", auth: undefined },
    ]);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("refuses redirects to other hosts or plain http, writing nothing", async () => {
    for (const location of [
      "https://169.254.169.254/latest",
      "http://cdn.example.com/x",
    ]) {
      const dest = path.join(dir, "c.bin");
      const fetchImpl = vi.fn(
        async () => new Response(null, { status: 302, headers: { location } }),
      );
      await expect(
        downloadToFile({
          url: "https://example.com/f",
          dest,
          allowHost: allowExample,
          maxBytes: 10,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).rejects.toMatchObject({ code: "host" });
      expect(fs.existsSync(dest)).toBe(false);
    }
  });

  it("rejects a declared or streamed size over the cap and removes the file", async () => {
    const dest = path.join(dir, "d.bin");
    await expect(
      downloadToFile({
        url: "https://example.com/f",
        dest,
        allowHost: allowExample,
        maxBytes: 2,
        fetchImpl: (async () =>
          bodyResponse([new Uint8Array(1)], {
            contentLength: 100,
          })) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(
      downloadToFile({
        url: "https://example.com/f",
        dest,
        allowHost: allowExample,
        maxBytes: 2,
        fetchImpl: (async () =>
          bodyResponse([
            new Uint8Array(2),
            new Uint8Array(2),
          ])) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("maps 401/403 to auth and requires 206 for ranges", async () => {
    await expect(
      downloadToFile({
        url: "https://example.com/f",
        dest: path.join(dir, "e.bin"),
        allowHost: allowExample,
        maxBytes: 10,
        fetchImpl: (async () =>
          new Response("no", { status: 401 })) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "auth", status: 401 });
    await expect(
      downloadToFile({
        url: "https://example.com/f",
        dest: path.join(dir, "e.bin"),
        allowHost: allowExample,
        maxBytes: 10,
        range: { start: 0, end: 1 },
        fetchImpl: (async () =>
          bodyResponse([new Uint8Array(5)])) as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "range_ignored" });
  });

  it("aborts with an idle error when the stream stalls", async () => {
    const dest = path.join(dir, "f.bin");
    const fetchImpl = (async (_u: string, init: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1]));
            init.signal?.addEventListener("abort", () =>
              c.error(new Error("aborted")),
            );
          },
        }),
      )) as unknown as typeof fetch;
    await expect(
      downloadToFile({
        url: "https://example.com/f",
        dest,
        allowHost: allowExample,
        maxBytes: 10,
        idleMs: 30,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "idle" });
    expect(fs.existsSync(dest)).toBe(false);
  });

  it("never overwrites an existing dest (wx)", async () => {
    const dest = path.join(dir, "g.bin");
    fs.writeFileSync(dest, "keep");
    await expect(
      downloadToFile({
        url: "https://example.com/f",
        dest,
        allowHost: allowExample,
        maxBytes: 10,
        fetchImpl: (async () =>
          bodyResponse([new Uint8Array([1])])) as unknown as typeof fetch,
      }),
    ).rejects.toThrow();
    expect(fs.readFileSync(dest, "utf8")).toBe("keep");
  });

  it("DownloadError carries code and status", () => {
    const e = new DownloadError("http", "x", 500);
    expect(e.code).toBe("http");
    expect(e.status).toBe(500);
  });
});

describe("safeDest", () => {
  it("validates leaf names and extensions", () => {
    expect(validateLeafName("a.safetensors", [".safetensors"])).toBe(
      "a.safetensors",
    );
    for (const bad of [
      "../a.safetensors",
      "x/a.safetensors",
      ".hidden.safetensors",
      "a\u0000.safetensors",
      "",
      " a.safetensors",
    ]) {
      expect(() => validateLeafName(bad, [".safetensors"])).toThrow(
        SafeDestError,
      );
    }
    expect(() => validateLeafName("a.exe", [".safetensors"])).toThrow(
      /isn't allowed/,
    );
  });

  it("allows a symlinked base but not a symlinked sub-folder escaping it", async () => {
    const realModels = path.join(dir, "drive", "models");
    fs.mkdirSync(realModels, { recursive: true });
    const linkedBase = path.join(dir, "models-link");
    fs.symlinkSync(realModels, linkedBase);
    const loras = await resolveContainedDir(linkedBase, ["loras"]);
    expect(loras).toBe(path.join(fs.realpathSync(realModels), "loras"));

    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(realModels, "vae"));
    await expect(
      resolveContainedDir(linkedBase, ["vae"]),
    ).rejects.toMatchObject({
      code: "escape",
    });
    await expect(resolveContainedDir(linkedBase, [".."])).rejects.toMatchObject(
      {
        code: "escape",
      },
    );
  });

  it("refuses symlinks at the final path and never overwrites silently", async () => {
    const target = path.join(dir, "real.txt");
    fs.writeFileSync(target, "x");
    const linkPath = path.join(dir, "link.txt");
    fs.symlinkSync(target, linkPath);
    await expect(inspectDest(linkPath)).rejects.toMatchObject({
      code: "symlink",
    });
    await expect(inspectDest(path.join(dir, "none"))).resolves.toEqual({
      kind: "missing",
    });

    const temp = path.join(dir, ".t.part");
    fs.writeFileSync(temp, "new");
    await expect(finalizeTemp(temp, target)).rejects.toMatchObject({
      code: "exists",
    });
    expect(fs.readFileSync(target, "utf8")).toBe("x");
    await finalizeTemp(temp, target, { overwrite: true });
    expect(fs.readFileSync(target, "utf8")).toBe("new");

    fs.writeFileSync(temp, "fresh");
    await finalizeTemp(temp, path.join(dir, "fresh.txt"));
    expect(fs.existsSync(temp)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "fresh.txt"), "utf8")).toBe("fresh");
    await expect(
      finalizeTemp(temp, linkPath, { overwrite: true }),
    ).rejects.toMatchObject({ code: "symlink" });
  });

  it("uniqueName picks the next free suffix", async () => {
    fs.writeFileSync(path.join(dir, "img.png"), "");
    fs.writeFileSync(path.join(dir, "img-2.png"), "");
    await expect(uniqueName(dir, "img.png")).resolves.toBe("img-3.png");
    await expect(uniqueName(dir, "new.png")).resolves.toBe("new.png");
  });
});

describe("download progress", () => {
  it("tracks bytes and percent", () => {
    startProgress("k1", 200);
    addProgress("k1", 50);
    expect(progressPercent(getProgress("k1")!)).toBe(25);
    finishProgress("k1");
    expect(getProgress("k1")?.done).toBe(true);
    expect(progressPercent({ received: 5, total: 0 })).toBe(-1);
    expect(getProgress("missing")).toBeNull();
  });
});

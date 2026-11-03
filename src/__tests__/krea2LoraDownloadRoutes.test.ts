/**
 * krea2-edit-loras/add and krea2-style-loras/download: HF-only hosts on every
 * redirect hop, byte cap, name validation, symlink-safe folder, error codes.
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
import fs from "fs";
import os from "os";
import path from "path";

const h = vi.hoisted(() => ({ root: "" }));
vi.mock("@/lib/env", () => ({
  env: {
    get COMFY_ROOT() {
      return h.root;
    },
  },
}));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));

import { POST as addEditLora } from "@/app/api/krea2-edit-loras/add/route";
import { POST as downloadStyleLora } from "@/app/api/krea2-style-loras/download/route";
import { getStyleLoraCatalog } from "@/lib/krea2/styleLoras";
import { HF_MAX_BYTES, validDisplayName } from "@/lib/net/hfFileDownload";

const HF = "https://huggingface.co/someone/repo/resolve/main/edit.safetensors";
let fetchMock: Mock;

function req(url: string, body: Record<string, unknown>) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const add = (body: Record<string, unknown>) =>
  addEditLora(req("http://localhost/api/krea2-edit-loras/add", body));
const style = (id: string) =>
  downloadStyleLora(
    req("http://localhost/api/krea2-style-loras/download", { id }),
  );
const loras = () => path.join(fs.realpathSync(h.root), "models", "loras");

beforeEach(() => {
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-krea2-"));
  // data/edit-loras.json resolves against cwd; keep it in the temp root.
  vi.spyOn(process, "cwd").mockReturnValue(h.root);
  fetchMock = vi.fn(
    async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(h.root, { recursive: true, force: true });
});

describe("validDisplayName", () => {
  it("accepts short single-line names only", () => {
    expect(validDisplayName("Relight")).toBe(true);
    expect(validDisplayName("")).toBe(false);
    expect(validDisplayName("a".repeat(81))).toBe(false);
    expect(validDisplayName("two\nlines")).toBe(false);
  });
});

describe("POST /api/krea2-edit-loras/add", () => {
  it("downloads into models/loras and records the entry", async () => {
    const res = await add({ url: HF, family: "krea2edit", name: "Edit" });
    expect(res.status).toBe(200);
    expect(fs.readFileSync(path.join(loras(), "edit.safetensors"))).toEqual(
      Buffer.from([1, 2, 3]),
    );
    const saved = JSON.parse(
      fs.readFileSync(path.join(h.root, "data", "edit-loras.json"), "utf8"),
    );
    expect(saved.loras[0]).toMatchObject({ file: "edit.safetensors" });
    // Leaves no temp files behind.
    expect(fs.readdirSync(loras())).toEqual(["edit.safetensors"]);
  });

  it("rejects bad names and non-HF / non-safetensors URLs", async () => {
    expect(
      (await add({ url: HF, family: "krea2edit", name: "x\u0007" })).status,
    ).toBe(400);
    expect(
      (await add({ url: HF, family: "krea2edit", name: "n".repeat(200) }))
        .status,
    ).toBe(400);
    for (const url of [
      "https://evil.example/a.safetensors",
      "http://huggingface.co/r/resolve/main/a.safetensors",
      "https://huggingface.co/r/resolve/main/a.ckpt",
      "https://huggingface.co/r/resolve/main/.hidden.safetensors",
    ]) {
      expect((await add({ url, family: "krea2edit" })).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a redirect off Hugging Face", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest" },
        }),
    );
    const res = await add({ url: HF, family: "krea2edit" });
    expect(res.status).toBe(502);
    expect(fs.readdirSync(loras())).toEqual([]);
  });

  it("follows a redirect to the HF CDN", async () => {
    fetchMock
      .mockImplementationOnce(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://cas-bridge.xethub.hf.co/x" },
          }),
      )
      .mockImplementationOnce(
        async () => new Response(new Uint8Array([9]), { status: 200 }),
      );
    expect((await add({ url: HF, family: "krea2edit" })).status).toBe(200);
  });

  it("caps size with 413", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(new Uint8Array(1), {
          status: 200,
          headers: { "content-length": String(HF_MAX_BYTES + 1) },
        }),
    );
    expect((await add({ url: HF, family: "krea2edit" })).status).toBe(413);
  });

  it("refuses a symlink at the final path inside loras", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-out-"));
    try {
      fs.mkdirSync(path.join(h.root, "models", "loras"), { recursive: true });
      fs.symlinkSync(
        path.join(outside, "victim"),
        path.join(h.root, "models", "loras", "edit.safetensors"),
      );
      const res = await add({ url: HF, family: "krea2edit" });
      expect(res.status).toBe(400);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports an existing file as already present without fetching", async () => {
    fs.mkdirSync(path.join(h.root, "models", "loras"), { recursive: true });
    fs.writeFileSync(
      path.join(h.root, "models", "loras", "edit.safetensors"),
      "x",
    );
    const data = await (await add({ url: HF, family: "krea2edit" })).json();
    expect(data.alreadyPresent).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/krea2-style-loras/download", () => {
  const id = getStyleLoraCatalog()[0]?.id ?? "";

  it("downloads a catalog LoRA", async () => {
    const res = await style(id);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      installed: true,
      alreadyPresent: false,
      bytes: 3,
    });
    const called = String(fetchMock.mock.calls[0][0]);
    expect(called.startsWith("https://huggingface.co/")).toBe(true);
  });

  it("rejects unknown ids", async () => {
    expect((await style("../../etc/passwd")).status).toBe(404);
  });

  it("maps a stalled or failed fetch to an error status and releases the lock", async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response("nope", { status: 500 }),
    );
    expect((await style(id)).status).toBe(502);
    // Lock released: the retry runs and succeeds.
    expect((await style(id)).status).toBe(200);
  });
});

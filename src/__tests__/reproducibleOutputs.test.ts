import { beforeEach, describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";

vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://127.0.0.1:8188" },
}));
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  assertPromptValid: vi.fn().mockResolvedValue(undefined),
  getObjectInfoCached: vi.fn().mockResolvedValue(null), // model-variant fallback: no-op
  applyOptionalNodeBypass: vi.fn(async (prompt: unknown) => ({ prompt, bypassed: [] })),
}));
vi.mock("@/lib/recipe/store", () => ({ saveRecipe: vi.fn() }));

import {
  queuePrompt,
  interruptPrompt,
  deleteFromQueue,
} from "@/lib/comfy/http";
import {
  buildExtraData,
  sanitizeCjParams,
  workflowFromHistory,
} from "@/lib/comfy/pnginfo";
import {
  readPngTextChunks,
  interpretMeta,
  readImportFile,
} from "@/lib/pngMeta";

function crcTable() {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const T = crcTable();
function crc(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = T[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function tEXt(k: string, v: string) {
  return chunk("tEXt", Buffer.concat([Buffer.from(k, "latin1"), Buffer.from([0]), Buffer.from(v, "utf8")]));
}
function iTXt(k: string, v: string) {
  return chunk(
    "iTXt",
    Buffer.concat([Buffer.from(k, "latin1"), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(v, "utf8")]),
  );
}
function makePng(extra: Buffer[]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const idat = deflateSync(Buffer.from([0, 0]));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      ...extra,
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

describe("extra_pnginfo payload", () => {
  it("builds cj params, strips secrets, includes UI workflow only when UI format", () => {
    const ui = { nodes: [{ id: 1 }], links: [] };
    const extra = buildExtraData({
      params: { fullPrompt: "a cat --ar 3:2", seed: 5, packId: "krea", apiKey: "x", civitai_token: "y", src: "data:image/png;base64,AAA" },
      uiWorkflow: ui,
    });
    expect(extra.extra_pnginfo.workflow).toBe(ui);
    expect(extra.extra_pnginfo.cj).toEqual({
      v: 1,
      params: { fullPrompt: "a cat --ar 3:2", seed: 5, packId: "krea" },
    });
    const api = buildExtraData({ params: {}, uiWorkflow: { "3": { class_type: "KSampler" } } });
    expect(api.extra_pnginfo).not.toHaveProperty("workflow");
    expect(sanitizeCjParams({ password: "p", ok: 1 })).toEqual({ ok: 1 });
  });

  it("queuePrompt always sends preview_method, merges extra_data, front only when requested", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ prompt_id: "p1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const wf = { "1": { class_type: "X", inputs: {} } } as never;
    await queuePrompt(wf, "c1");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      prompt: wf,
      client_id: "c1",
      extra_data: { preview_method: "auto" },
    });

    const extra = buildExtraData({ params: { seed: 1 } });
    await queuePrompt(wf, "c1", "http://h:1", { extraData: extra, front: true });
    expect(fetchMock.mock.calls[1][0]).toBe("http://h:1/prompt");
    const sent = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(sent).toEqual({
      prompt: wf,
      client_id: "c1",
      extra_data: {
        ...extra,
        extra_pnginfo: { ...extra.extra_pnginfo, adrift_recipe: expect.any(Object) },
        preview_method: "auto",
      },
      front: true,
    });
    expect(sent.extra_data.extra_pnginfo.adrift_recipe).toMatchObject({
      schema: "adrift.recipe",
      seeds: [1],
    });

    // A caller-set preview_method wins over the setting.
    await queuePrompt(wf, "c1", "http://h:1", { extraData: { preview_method: "none" } });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).extra_data).toEqual({ preview_method: "none" });
  });

  it("workflowFromHistory prefers embedded UI workflow, else API prompt", () => {
    const ui = { nodes: [{ id: 1 }] };
    expect(workflowFromHistory({ prompt: [1, "id", { a: 1 }, { extra_pnginfo: { workflow: ui } }, []] })).toEqual({ kind: "ui", workflow: ui });
    expect(workflowFromHistory({ prompt: [1, "id", { a: 1 }, {}, []] })).toEqual({ kind: "api", workflow: { a: 1 } });
    expect(workflowFromHistory({})).toBeNull();
  });
});

describe("PNG chunk parsing", () => {
  const cj = { v: 1, params: { fullPrompt: "a fox --ar 1:1", seed: 9 } };

  it("reads tEXt and iTXt chunks from a constructed PNG", () => {
    const png = makePng([tEXt("prompt", '{"3":{"class_type":"KSampler"}}'), tEXt("cj", JSON.stringify(cj)), iTXt("workflow", '{"nodes":[{"id":1}]}')]);
    const chunks = readPngTextChunks(png);
    expect(Object.keys(chunks).sort()).toEqual(["cj", "prompt", "workflow"]);
    expect(JSON.parse(chunks.cj)).toEqual(cj);
    expect(JSON.parse(chunks.workflow)).toEqual({ nodes: [{ id: 1 }] });
  });

  it("restores Adrift params when cj exists, else loads graph, else none", () => {
    const m = interpretMeta({ cj: JSON.stringify(cj), prompt: "{}" });
    expect(m).toMatchObject({ kind: "cj", promptText: "a fox --ar 1:1" });
    expect(interpretMeta({ workflow: '{"nodes":[]}' })).toEqual({ kind: "workflow", workflow: { nodes: [] } });
    expect(interpretMeta({ prompt: '{"1":{"class_type":"A"}}' }).kind).toBe("workflow");
    expect(interpretMeta({})).toEqual({ kind: "none" });
  });

  it("returns nothing for non-PNG and handles files end to end", async () => {
    expect(readPngTextChunks(new Uint8Array([1, 2, 3]))).toEqual({});
    const png = makePng([tEXt("cj", JSON.stringify(cj))]);
    const file = new File([png], "a.png", { type: "image/png" });
    expect((await readImportFile(file)).kind).toBe("cj");
    const json = new File([JSON.stringify({ "1": { class_type: "A", inputs: {} } })], "w.json");
    expect((await readImportFile(json)).kind).toBe("workflow");
  });
});

describe("queue management request shapes", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  });

  it("interruptPrompt POSTs {prompt_id}", async () => {
    await interruptPrompt("abc");
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8188/interrupt");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ prompt_id: "abc" });
  });

  it("deleteFromQueue POSTs {delete:[ids]} for string and array", async () => {
    await deleteFromQueue("a");
    await deleteFromQueue(["b", "c"]);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0][0]).toBe("http://127.0.0.1:8188/queue");
    expect(JSON.parse(calls[0][1]?.body as string)).toEqual({ delete: ["a"] });
    expect(JSON.parse(calls[1][1]?.body as string)).toEqual({ delete: ["b", "c"] });
  });
});

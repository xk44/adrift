/** HairDeck sidecar: config, request validation, Gradio client, save, routes. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  HAIRDECK_MAX_IMAGE_BYTES,
  hairdeckConfig,
  parseHairDeckRequest,
  type HairDeckRequest,
} from "@/lib/hairdeck/config";
import {
  HAIRDECK_FILE_LIMITS,
  HairDeckError,
  readResult,
  runHairDeck,
  selectResultFiles,
} from "@/lib/hairdeck/gradio";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const dataUrl = (mime: string, bytes: Uint8Array) =>
  `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
const BASE = "http://127.0.0.1:7860";

const REQ: HairDeckRequest = {
  image: { mime: "image/png", bytes: PNG },
  seed: 7,
  steps: 50,
  cfg: 2,
  variations: 2,
  chains: true,
};

describe("hairdeckConfig", () => {
  it("is unconfigured when the env is unset or blank", () => {
    expect(hairdeckConfig({})).toEqual({ configured: false });
    expect(hairdeckConfig({ HAIRDECK_BACKEND_URL: "  " })).toEqual({
      configured: false,
    });
  });

  it("normalizes a loopback URL and keeps a path prefix", () => {
    expect(
      hairdeckConfig({ HAIRDECK_BACKEND_URL: "http://127.0.0.1:7860/" }),
    ).toEqual({
      configured: true,
      url: BASE,
    });
    expect(
      hairdeckConfig({ HAIRDECK_BACKEND_URL: "http://localhost:7860/hd/" }),
    ).toEqual({
      configured: true,
      url: "http://localhost:7860/hd",
    });
    expect(
      hairdeckConfig({ HAIRDECK_BACKEND_URL: "http://[::1]:7860" }),
    ).toMatchObject({
      url: "http://[::1]:7860",
    });
  });

  it("refuses a LAN host unless HAIRDECK_ALLOW_REMOTE=1", () => {
    const lan = "http://192.168.0.10:7860";
    expect(hairdeckConfig({ HAIRDECK_BACKEND_URL: lan })).toMatchObject({
      url: null,
    });
    expect(
      hairdeckConfig({ HAIRDECK_BACKEND_URL: lan, HAIRDECK_ALLOW_REMOTE: "1" }),
    ).toEqual({ configured: true, url: lan });
  });

  it.each([
    "ftp://127.0.0.1/x",
    "http://user:pw@127.0.0.1:7860",
    "http://127.0.0.1:7860/?q=1",
    "not a url",
  ])("rejects %s", (u) => {
    const c = hairdeckConfig({ HAIRDECK_BACKEND_URL: u });
    expect(c).toMatchObject({ configured: true, url: null });
  });
});

describe("parseHairDeckRequest", () => {
  const ok = {
    image: dataUrl("image/png", PNG),
    seed: 3,
    steps: 10,
    cfg: 2.5,
    variations: 4,
    chains: false,
  };

  it("accepts a valid body and fills defaults", () => {
    const r = parseHairDeckRequest({
      image: dataUrl("image/jpeg", JPEG),
      seed: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      seed: 0,
      steps: 50,
      cfg: 2,
      variations: 1,
      chains: false,
    });
    expect(r.value.image.mime).toBe("image/jpeg");
    expect(parseHairDeckRequest(ok).ok).toBe(true);
  });

  it.each([
    ["not an object", null],
    ["unknown field", { ...ok, extra: 1 }],
    ["remote image URL", { ...ok, image: "http://example.com/a.png" }],
    ["gif", { ...ok, image: dataUrl("image/gif", PNG) }],
    ["mime/content mismatch", { ...ok, image: dataUrl("image/jpeg", PNG) }],
    [
      "non-image bytes",
      {
        ...ok,
        image: dataUrl("image/png", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
      },
    ],
    ["negative seed", { ...ok, seed: -1 }],
    ["fractional seed", { ...ok, seed: 1.5 }],
    ["steps 20", { ...ok, steps: 20 }],
    ["cfg off the 0.25 grid", { ...ok, cfg: 2.1 }],
    ["cfg too high", { ...ok, cfg: 4.25 }],
    ["5 variations", { ...ok, variations: 5 }],
    ["string chains", { ...ok, chains: "yes" }],
  ])("rejects %s", (_name, body) => {
    expect(parseHairDeckRequest(body).ok).toBe(false);
  });

  it("rejects an image over the size cap before decoding it", () => {
    const big = "A".repeat(Math.ceil((HAIRDECK_MAX_IMAGE_BYTES * 4) / 3) + 16);
    const r = parseHairDeckRequest({
      ...ok,
      image: `data:image/png;base64,${big}`,
    });
    expect(r).toMatchObject({
      ok: false,
      error: expect.stringContaining("larger"),
    });
  });
});

const fd = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  url: `http://evil.example/${path}`,
  meta: { _type: "gradio.FileData" },
  ...extra,
});

/** What the demo's generate endpoint returns (positions as in demo/app.py). */
function gradioReply(dir = "/tmp/gradio/abc") {
  return [
    fd(`${dir}/image.webp`),
    { __type__: "update", value: fd(`${dir}/hair_seed7.glb`) },
    { __type__: "update", value: fd(`${dir}/hair_seed8.glb`) },
    { __type__: "update", value: null },
    { __type__: "update", value: null },
    [
      fd(`${dir}/hair_seed7.glb`),
      fd(`${dir}/hair_seed7_nohead.glb`),
      fd(`${dir}/hair_seed7_nohead_chains.glb`),
      fd(`${dir}/cards_seed7.json`),
      fd(`${dir}/chains_seed7.json`),
      fd(`${dir}/hair_seed8.glb`),
      fd(`${dir}/cards_seed8.json`),
      fd(`${dir}/info.json`),
      fd(`${dir}/../../etc/hair_seed9.glb`),
    ],
    "<p>info</p>",
    null,
  ];
}

function sse(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

type Call = { url: string; init?: RequestInit };

function mockSidecar(reply: unknown[] | Response = gradioReply()) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === `${BASE}/gradio_api/upload`)
      return Response.json(["/tmp/gradio/up/portrait.png"]);
    if (url === `${BASE}/gradio_api/call/generate`)
      return Response.json({ event_id: "ev123" });
    if (url === `${BASE}/gradio_api/call/generate/ev123`)
      return reply instanceof Response
        ? reply
        : sse([
            "event: heartbeat\ndata: null\n\n",
            "event: generating\ndata: [null]\n\nevent: comp",
            `lete\ndata: ${JSON.stringify(reply)}\n\n`,
          ]);
    const m = /\/gradio_api\/file=(.*)$/.exec(url);
    if (m)
      return new Response(
        new TextEncoder().encode(`bytes:${decodeURIComponent(m[1])}`),
      );
    return new Response("nope", { status: 404 });
  });
  return { calls, fetchImpl };
}

describe("selectResultFiles", () => {
  it("keeps the preview plus whitelisted per-seed files, deduplicated, no traversal", () => {
    const picked = selectResultFiles(gradioReply());
    expect(picked.map((p) => [p.ref.name, p.kind, p.seed])).toEqual([
      ["image.webp", "preview", null],
      ["hair_seed7.glb", "mesh", 7],
      ["hair_seed8.glb", "mesh", 8],
      ["hair_seed7_nohead.glb", "mesh", 7],
      ["hair_seed7_nohead_chains.glb", "mesh", 7],
      ["cards_seed7.json", "cards", 7],
      ["chains_seed7.json", "chains", 7],
      ["cards_seed8.json", "cards", 8],
    ]);
  });

  it("caps the number of files", () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      fd(`/t/hair_seed${i}.glb`),
    );
    expect(selectResultFiles([null, many])).toHaveLength(
      HAIRDECK_FILE_LIMITS.maxFiles,
    );
  });
});

describe("runHairDeck", () => {
  it("uploads, calls generate with the demo's argument order, reads SSE and downloads by path", async () => {
    const { calls, fetchImpl } = mockSidecar();
    const files = await runHairDeck(BASE, REQ, { fetchImpl });

    const up = calls[0];
    expect(up.url).toBe(`${BASE}/gradio_api/upload`);
    const form = up.init?.body as FormData;
    const blob = form.get("files") as File;
    expect(blob.name).toBe("portrait.png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG);

    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      data: [
        {
          path: "/tmp/gradio/up/portrait.png",
          meta: { _type: "gradio.FileData" },
        },
        7,
        50,
        2,
        2,
        true,
        true,
      ],
    });
    for (const c of calls) expect(c.init?.redirect).toBe("error");

    const fileCalls = calls.filter((c) => c.url.includes("/gradio_api/file="));
    expect(
      fileCalls.every((c) =>
        c.url.startsWith(`${BASE}/gradio_api/file=/tmp/gradio/abc/`),
      ),
    ).toBe(true);
    expect(fileCalls.some((c) => c.url.includes("evil.example"))).toBe(false);
    expect(files.map((f) => f.name)).toContain("hair_seed7_nohead.glb");
    expect(files.find((f) => f.name === "info.json")).toBeUndefined();
    expect(new TextDecoder().decode(files[0].bytes)).toBe(
      "bytes:/tmp/gradio/abc/image.webp",
    );
  });

  it("encodes odd characters in file paths", async () => {
    const { calls, fetchImpl } = mockSidecar(gradioReply("/tmp/gradio/a b#c"));
    await runHairDeck(BASE, REQ, { fetchImpl });
    expect(
      calls.some((c) =>
        c.url.endsWith("/gradio_api/file=/tmp/gradio/a%20b%23c/hair_seed7.glb"),
      ),
    ).toBe(true);
  });

  it("surfaces a Gradio error event", async () => {
    const { fetchImpl } = mockSidecar(
      sse(['event: error\ndata: "CUDA out of memory"\n\n']),
    );
    await expect(runHairDeck(BASE, REQ, { fetchImpl })).rejects.toThrow(
      /CUDA out of memory/,
    );
  });

  it("fails when the reply has no mesh", async () => {
    const { fetchImpl } = mockSidecar([
      fd("/t/image.webp"),
      [fd("/t/cards_seed1.json")],
    ]);
    await expect(runHairDeck(BASE, REQ, { fetchImpl })).rejects.toThrow(
      /without a hair mesh/,
    );
  });

  it("refuses an oversized download", async () => {
    const { fetchImpl } = mockSidecar();
    const inner = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url: string, init?: RequestInit) =>
      url.includes("/gradio_api/file=")
        ? new Response("x", {
            headers: {
              "content-length": String(HAIRDECK_FILE_LIMITS.perFileBytes + 1),
            },
          })
        : inner(url, init),
    );
    await expect(runHairDeck(BASE, REQ, { fetchImpl })).rejects.toThrow(
      /too large/,
    );
  });

  it("maps HTTP failures and bad job ids to HairDeckError", async () => {
    const down = vi.fn(async () => new Response("x", { status: 500 }));
    await expect(
      runHairDeck(BASE, REQ, { fetchImpl: down }),
    ).rejects.toBeInstanceOf(HairDeckError);
    const { fetchImpl } = mockSidecar();
    const inner = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith("/call/generate")
        ? Response.json({ event_id: "../x" })
        : inner(url, init),
    );
    await expect(runHairDeck(BASE, REQ, { fetchImpl })).rejects.toThrow(
      /job id/,
    );
  });

  it("stops at the terminal event even if the stream stays open", async () => {
    const enc = new TextEncoder();
    const res = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode("event: complete\ndata: [1]\n\n"));
        },
      }),
    );
    await expect(readResult(res)).resolves.toEqual([1]);
  });
});

// ── save + routes ───────────────────────────────────────────────────────────

type Exec = { sql: string; args: unknown[] };
const executed: Exec[] = [];
const fakeDb = {
  prepare: (sql: string) => ({
    run: (...args: unknown[]) => {
      executed.push({ sql, args });
    },
  }),
  transaction: (fn: () => void) => () => fn(),
};
/** RecentRunRow join over what the fake DB recorded. */
function rowsFor(runId: string) {
  const run = executed.find(
    (e) => e.sql.includes("INSERT INTO runs") && e.args[0] === runId,
  );
  if (!run) return [];
  const jobs = executed.filter(
    (e) => e.sql.includes("INSERT INTO jobs") && e.args[1] === runId,
  );
  return jobs.flatMap((j) =>
    executed
      .filter(
        (e) => e.sql.includes("INSERT INTO outputs") && e.args[0] === j.args[0],
      )
      .map((o) => ({
        run_id: runId,
        prompt: "HairDeck hair cards",
        parsed_prompt: run.args[4],
        params: run.args[5],
        width: null,
        height: null,
        created_at: run.args[2],
        job_id: j.args[0],
        seed: j.args[2],
        job_status: "done",
        progress: 100,
        prompt_id_comfy: null,
        job_error: null,
        output_filename: o.args[1],
        output_subfolder: o.args[2],
        output_type: o.args[3],
        output_media: o.args[4],
      })),
  );
}

const runHairDeckMock = vi.fn();
const probeMock = vi.fn();

async function loadRoutes(envVars: Record<string, string | undefined>) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(envVars)) vi.stubEnv(k, v ?? "");
  vi.doMock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
  vi.doMock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
  vi.doMock("@/lib/db", () => ({
    getDB: () => fakeDb,
    getRunRowsById: rowsFor,
  }));
  vi.doMock("@/lib/comfy/http", () => ({ uploadImageToComfy: vi.fn() }));
  vi.doMock("@/lib/hairdeck/gradio", async (orig) => ({
    ...(await orig<typeof import("@/lib/hairdeck/gradio")>()),
    runHairDeck: runHairDeckMock,
    hairdeckProbe: probeMock,
  }));
  const status = await import("@/app/api/hairdeck/status/route");
  const generate = await import("@/app/api/hairdeck/generate/route");
  return { statusGET: status.GET, generatePOST: generate.POST };
}

const LOCAL = { host: "127.0.0.1:3000", "content-type": "application/json" };
const post = (body: unknown, headers: Record<string, string> = LOCAL) =>
  new NextRequest("http://127.0.0.1:3000/api/hairdeck/generate", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const validBody = {
  image: dataUrl("image/png", PNG),
  seed: 7,
  steps: 50,
  cfg: 2,
  variations: 2,
  chains: true,
};

const sidecarFiles = () => [
  { name: "image.webp", kind: "preview", seed: null, bytes: PNG },
  { name: "hair_seed7.glb", kind: "mesh", seed: 7, bytes: PNG },
  { name: "hair_seed7_nohead.glb", kind: "mesh", seed: 7, bytes: PNG },
  { name: "cards_seed7.json", kind: "cards", seed: 7, bytes: PNG },
  { name: "hair_seed8.glb", kind: "mesh", seed: 8, bytes: PNG },
];

describe("saveHairDeckResult", () => {
  beforeEach(() => {
    executed.length = 0;
  });

  it("records one run with a job per seed: preview image + that seed's meshes", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      getDB: () => fakeDb,
      getRunRowsById: rowsFor,
    }));
    const { saveHairDeckResult, HAIRDECK_SUBFOLDER } =
      await import("@/lib/hairdeck/save");
    const stored: string[] = [];
    const out = await saveHairDeckResult(sidecarFiles() as never, REQ, {
      now: new Date("2026-10-31T12:00:00Z"),
      store: async (_b, filename) => {
        stored.push(filename);
        return { subfolder: HAIRDECK_SUBFOLDER, type: "output" };
      },
    });
    expect(stored).toHaveLength(5);
    expect(
      stored.every((n) => /^hairdeck_20261031120000_[0-9a-f]{6}_/.test(n)),
    ).toBe(true);
    expect(
      out.seeds.map((s) => [s.seed, s.meshes.length, s.downloads.length]),
    ).toEqual([
      [7, 2, 3],
      [8, 1, 1],
    ]);
    const run = out.run!;
    expect(run.params).toMatchObject({
      tool: "hairdeck",
      seed: 7,
      variations: 2,
    });
    expect(
      run.jobs.map((j) => [j.index, j.seed, j.images.length, j.meshes?.length]),
    ).toEqual([
      [0, 7, 1, 2],
      [1, 8, 1, 1],
    ]);
    expect(run.jobs[0].meshes![0]).toContain(
      "subfolder=adrift_hairdeck&type=output",
    );
    const json = executed
      .filter((e) => e.sql.includes("INSERT INTO outputs"))
      .map((e) => e.args[1]);
    expect(json.some((n) => String(n).endsWith(".json"))).toBe(false);
  });
});

describe("/api/hairdeck routes", () => {
  beforeEach(() => {
    executed.length = 0;
    runHairDeckMock.mockReset();
    probeMock.mockReset();
  });

  it("status: not configured, misconfigured, reachable", async () => {
    let r = await loadRoutes({ HAIRDECK_BACKEND_URL: undefined });
    let res = await r.statusGET(
      new NextRequest("http://127.0.0.1:3000/api/hairdeck/status", {
        headers: LOCAL,
      }),
    );
    expect(await res.json()).toMatchObject({
      configured: false,
      reachable: false,
      local: true,
    });
    expect(probeMock).not.toHaveBeenCalled();

    r = await loadRoutes({ HAIRDECK_BACKEND_URL: "http://10.1.2.3:7860" });
    res = await r.statusGET(
      new NextRequest("http://127.0.0.1:3000/api/hairdeck/status", {
        headers: LOCAL,
      }),
    );
    const body = await res.json();
    expect(body).toMatchObject({ configured: true, reachable: false });
    expect(JSON.stringify(body)).not.toContain("10.1.2.3");

    probeMock.mockResolvedValue({ reachable: true });
    r = await loadRoutes({ HAIRDECK_BACKEND_URL: BASE });
    res = await r.statusGET(
      new NextRequest("http://127.0.0.1:3000/api/hairdeck/status", {
        headers: LOCAL,
      }),
    );
    expect(await res.json()).toMatchObject({
      configured: true,
      reachable: true,
    });
    expect(probeMock).toHaveBeenCalledWith(BASE);
  });

  it("generate: refuses non-local callers before anything else", async () => {
    const { generatePOST } = await loadRoutes({ HAIRDECK_BACKEND_URL: BASE });
    const res = await generatePOST(
      post(validBody, { ...LOCAL, "x-forwarded-for": "10.0.0.2" }),
    );
    expect(res.status).toBe(403);
    expect(runHairDeckMock).not.toHaveBeenCalled();
  });

  it("generate: 503 when the sidecar is not configured", async () => {
    const { generatePOST } = await loadRoutes({
      HAIRDECK_BACKEND_URL: undefined,
    });
    const res = await generatePOST(post(validBody));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/HAIRDECK_BACKEND_URL/);
  });

  it("generate: validates content type, size and body", async () => {
    const { generatePOST } = await loadRoutes({ HAIRDECK_BACKEND_URL: BASE });
    expect(
      (
        await generatePOST(
          post(validBody, {
            host: "127.0.0.1:3000",
            "content-type": "text/plain",
          }),
        )
      ).status,
    ).toBe(415);
    expect((await generatePOST(post("{"))).status).toBe(400);
    expect((await generatePOST(post({ ...validBody, steps: 7 }))).status).toBe(
      400,
    );
    expect(
      (await generatePOST(post("x".repeat(20 * 1024 * 1024)))).status,
    ).toBe(413);
    const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
    let sent = 0;
    const chunked = new NextRequest(
      "http://127.0.0.1:3000/api/hairdeck/generate",
      {
        method: "POST",
        headers: LOCAL,
        body: new ReadableStream<Uint8Array>({
          pull(c) {
            if (sent++ < 40) c.enqueue(chunk);
            else c.close();
          },
        }),
        duplex: "half",
      } as ConstructorParameters<typeof NextRequest>[1],
    );
    expect((await generatePOST(chunked)).status).toBe(413);
    expect(sent).toBeLessThan(40);
    expect(runHairDeckMock).not.toHaveBeenCalled();
  });

  it("generate: runs the job, saves outputs and returns the run", async () => {
    runHairDeckMock.mockResolvedValue(sidecarFiles());
    const { generatePOST } = await loadRoutes({
      HAIRDECK_BACKEND_URL: `${BASE}/`,
      COMFY_HTTP_URL: "http://192.0.2.1:8188",
    });
    const { uploadImageToComfy } = await import("@/lib/comfy/http");
    vi.mocked(uploadImageToComfy).mockImplementation(
      async (_b, filename, sub) => `${sub}/${filename} [input]`,
    );
    const res = await generatePOST(post(validBody));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(runHairDeckMock.mock.calls[0][0]).toBe(BASE);
    expect(runHairDeckMock.mock.calls[0][1]).toMatchObject({
      seed: 7,
      variations: 2,
      chains: true,
    });
    expect(body.run.jobs).toHaveLength(2);
    expect(body.seeds[0].meshes[0]).toContain("type=input");
  });

  it("generate: maps sidecar errors and rejects a second concurrent job", async () => {
    const { generatePOST } = await loadRoutes({ HAIRDECK_BACKEND_URL: BASE });
    // The route sees the module copy loaded after resetModules.
    const { HairDeckError: RouteError } = await import("@/lib/hairdeck/gradio");
    let release!: () => void;
    runHairDeckMock.mockImplementationOnce(
      () =>
        new Promise((_res, rej) => {
          release = () =>
            rej(
              new HairDeckError(
                "HairDeck did not answer the job in time.",
                504,
              ),
            );
        }),
    );
    const first = generatePOST(post(validBody));
    await vi.waitFor(() => expect(runHairDeckMock).toHaveBeenCalledTimes(1));
    const second = await generatePOST(post(validBody));
    expect(second.status).toBe(409);
    release();
    const r1 = await first;
    expect(r1.status).toBe(504);
    expect((await r1.json()).error).toMatch(/in time/);
  });
});

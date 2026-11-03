/**
 * scripts/adrift_td.py against a fake Adrift (local http server): the same
 * calls the app's own agent API expects, with no GPU job anywhere.
 */
import { spawnSync, spawn } from "child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../../scripts/adrift_td.py");
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]),
  Buffer.from([0, 0, 2, 0, 0, 0, 1, 0]),
]);

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

const python = ["python3", "python"].find(
  (c) => spawnSync(c, ["--version"]).status === 0,
);

describe.skipIf(!python)("adrift_td.py", () => {
  let server: http.Server;
  let url = "";
  let seen: Seen[] = [];
  let history: Record<string, unknown> | null = null;
  let pendingPolls = 0;
  const tmp = mkdtempSync(path.join(os.tmpdir(), "adrift-td-"));
  const image = path.join(tmp, "shot.png");

  const tools = [
    { id: "action:image_to_splat", kind: "action", name: "Image to splat", source: "image", available: true },
    { id: "action:make_music", kind: "action", name: "Make music", source: "none", available: true },
    { id: "catalog:cat_tool", kind: "catalog", name: "Cat tool", source: "image", available: true },
    { id: "action:off", kind: "action", name: "Off tool", source: "image", available: false, unavailableReason: "Missing a model" },
  ];

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  beforeAll(async () => {
    writeFileSync(image, PNG);
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const u = req.url ?? "";
        seen.push({
          method: req.method ?? "",
          url: u,
          headers: req.headers,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
        });
        if (u === "/api/tools/agent") return json(res, 200, { ok: true, tools });
        if (u === "/api/comfy/upload") return json(res, 200, { ok: true, ref: "shot.png [input]" });
        if (u === "/api/tools/agent/compile")
          return json(res, 200, {
            ok: true,
            action: "image_to_splat",
            params: { pack_id: "triposplat", mesh: "on" },
            overrides: { steps: 4 },
            tool_page_id: "image_to_splat",
          });
        if (u === "/api/jobs/seed-run")
          return json(res, 200, { run: { run_id: "run1", jobs: [{ index: 3 }] } });
        if (u === "/api/jobs/action" || u === "/api/jobs/tool")
          return json(res, 200, { run: { jobs: [{ prompt_id: "p1" }] } });
        if (u === "/api/jobs/cancel") return json(res, 200, { ok: true });
        if (u.startsWith("/api/comfy/history/")) {
          if (pendingPolls > 0 || !history) {
            pendingPolls -= 1;
            return json(res, 404, { error: "Not ready" });
          }
          return json(res, 200, history);
        }
        if (u.startsWith("/api/comfy/image?")) {
          res.writeHead(200);
          return res.end("file bytes");
        }
        return json(res, 500, { error: `unexpected ${u}` });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    seen = [];
    pendingPolls = 0;
    history = {
      status: { status_str: "success", completed: true, messages: [] },
      meshes: [{ filename: "a.ply", subfolder: "3d", type: "output" }],
      images: [
        { filename: "b.png", subfolder: "", type: "output" },
        { filename: "preview.png", subfolder: "", type: "temp" },
      ],
    };
  });

  /** Runs a snippet with spawn, not spawnSync: the fake server shares this event loop. */
  const py = (code: string): Promise<{ status: number | null; out: string; err: string }> =>
    new Promise((resolve) => {
      const child = spawn(python!, ["-I", "-c", code, SCRIPT, url, tmp, image]);
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (status) => resolve({ status, out, err }));
    });

  const prelude = `
import importlib.util, json, sys, time
spec = importlib.util.spec_from_file_location("adrift_td", sys.argv[1])
td = importlib.util.module_from_spec(spec); spec.loader.exec_module(td)
url, tmp, image = sys.argv[2:5]
client = td.Client(url, api_key="k3y")
`;
  const body = (p: string) => seen.find((s) => s.url === p)?.body;

  it("only imports the standard library", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const imports = [...src.matchAll(/^(?:import|from) (\w+)/gm)].map((m) => m[1]);
    const stdlib = spawnSync(python!, ["-I", "-c", "import sys;print(' '.join(sys.stdlib_module_names))"]);
    if (stdlib.status === 0) {
      const names = new Set(stdlib.stdout.toString().trim().split(" "));
      expect(imports.filter((n) => !names.has(n))).toEqual([]);
    }
    expect(imports.length).toBeGreaterThan(3);
  });

  it("runs an image tool through compile, seed and action, then downloads outputs", async () => {
    pendingPolls = 2;
    const r = await py(`${prelude}
print(json.dumps(client.run("action:image_to_splat", tmp + "/o1", image=image, options={"mesh": "on"}, poll=0.01)))`);
    expect(r.err).toBe("");
    const files = JSON.parse(r.out) as string[];
    expect(files.map((f) => path.basename(f))).toEqual(["b.png", "a.ply"]);
    expect(readFileSync(files[1], "utf8")).toBe("file bytes");
    expect(existsSync(`${files[1]}.part`)).toBe(false);

    expect(body("/api/tools/agent/compile")).toMatchObject({
      toolId: "action:image_to_splat",
      options: { mesh: "on" },
    });
    expect(body("/api/comfy/upload")?.image).toMatch(/^data:image\/png;base64,/);
    expect(body("/api/jobs/seed-run")).toEqual({
      ref: "shot.png [input]",
      width: 512,
      height: 256,
      prompt: "Image to splat",
    });
    expect(body("/api/jobs/action")).toMatchObject({
      run_id: "run1",
      job_index: 3,
      action: "image_to_splat",
      tool_page_id: "image_to_splat",
      params: { pack_id: "triposplat", mesh: "on" },
      workflow_control_overrides: { steps: 4 },
    });
    const first = seen[0];
    expect(first.headers.authorization).toBe("Bearer k3y");
    expect(first.headers.origin).toBe(url);
    expect(first.headers["x-requested-with"]).toBe("XMLHttpRequest");
    // Previews are skipped
    expect(seen.some((s) => s.url.includes("preview.png"))).toBe(false);
  });

  it("seeds a text-only run for a tool with no source", async () => {
    const r = await py(`${prelude}
print(client.submit("action:make_music", text="a tune"))`);
    expect(r.err).toBe("");
    expect(body("/api/jobs/seed-run")).toMatchObject({ text_only: true });
    expect(body("/api/comfy/upload")).toBeUndefined();
  });

  it("sends catalog tools to the tool route without the catalog prefix", async () => {
    const r = await py(`${prelude}
print(client.submit("catalog:cat_tool", image=image, text="hi", options={"a": 1}))`);
    expect(r.err).toBe("");
    expect(body("/api/jobs/tool")).toMatchObject({
      toolId: "cat_tool",
      images: ["shot.png [input]"],
      prompt: "hi",
      options: { a: 1 },
    });
  });

  it("start() returns before the job ends and reports through the Job", async () => {
    const r = await py(`${prelude}
job = client.start("action:image_to_splat", tmp + "/o2", image=image, poll=0.01)
early = job.done
while not job.done: time.sleep(0.01)
print(json.dumps({"early": early, "files": len(job.files), "error": job.error}))`);
    expect(r.err).toBe("");
    expect(JSON.parse(r.out)).toEqual({ early: false, files: 2, error: null });
  });

  it("start() puts failures on job.error rather than raising on the thread", async () => {
    history = {
      status: {
        status_str: "error",
        completed: false,
        messages: [["execution_error", { exception_message: "Out of memory" }]],
      },
    };
    const r = await py(`${prelude}
bad = client.start("action:image_to_splat", tmp + "/o3", image=image, poll=0.01)
off = client.start("action:off", tmp + "/o3", image=image, poll=0.01)
nope = client.start("action:nope", tmp + "/o3", image=image, poll=0.01)
no_file = client.start("action:image_to_splat", tmp + "/o3", poll=0.01)
for j in (bad, off, nope, no_file):
    while not j.done: time.sleep(0.01)
print(json.dumps([bad.error, off.error, nope.error, no_file.error]))`);
    expect(r.err).toBe("");
    expect(JSON.parse(r.out)).toEqual([
      "Out of memory",
      "Off tool isn't available: Missing a model",
      'Unknown tool "action:nope"',
      "Image to splat needs an input image",
    ]);
  });

  it("cancel() stops polling and cancels the job", async () => {
    history = null;
    const r = await py(`${prelude}
job = client.start("action:image_to_splat", tmp + "/o4", image=image, poll=0.01)
while not job.prompt_ids: time.sleep(0.01)
job.cancel()
while not job.done: time.sleep(0.01)
print(job.error)`);
    expect(r.err).toBe("");
    expect(r.out.trim()).toBe("Cancelled");
    expect(body("/api/jobs/cancel")).toEqual({ prompt_id: "p1" });
  });

  it("reads clip size and length from an MP4 header, and WebP size", () => {
    const code = `
import importlib.util, struct, sys
spec = importlib.util.spec_from_file_location("adrift_td", sys.argv[1])
m = importlib.util.module_from_spec(spec); sys.modules["adrift_td"] = m; spec.loader.exec_module(m)
box = lambda k, b: struct.pack(">I", 8 + len(b)) + k + b
mvhd = box(b"mvhd", bytes(12) + struct.pack(">II", 600, 3000) + bytes(80))
tkhd = lambda w, h: box(b"tkhd", bytes(76) + struct.pack(">II", w << 16, h << 16))
trak = lambda w, h: box(b"trak", tkhd(w, h))
clip = box(b"ftyp", b"isom") + box(b"moov", mvhd + trak(0, 0) + trak(1920, 1080))
print(m.mp4_info(clip), m.mp4_info(b"not a clip"), m.mp4_info(clip[:40]))
vp8x = b"RIFF" + bytes(4) + b"WEBPVP8X" + bytes(8) + (639).to_bytes(3, "little") + (479).to_bytes(3, "little")
print(m.image_size(vp8x))`;
    const r = spawnSync(python!, ["-I", "-c", code, SCRIPT]);
    expect(r.stderr.toString()).toBe("");
    expect(r.stdout.toString().trim().split("\n")).toEqual([
      "(1920, 1080, 5.0) (None, None, None) (None, None, None)",
      "(640, 480)",
    ]);
  });

  it("says plainly when Adrift isn't running", () => {
    const r = spawnSync(python!, ["-I", SCRIPT, "tools"], {
      env: { ...process.env, ADRIFT_URL: "http://127.0.0.1:9" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toContain("Can't reach Adrift at http://127.0.0.1:9");
  });
});

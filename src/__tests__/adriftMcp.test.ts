/**
 * scripts/adrift-mcp.mjs end to end: the stdio server is spawned against a
 * fake Adrift (local http server) and driven over JSON-RPC.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildAgentTools } from "@/lib/mcp/agentTools";

const SCRIPT = path.resolve(__dirname, "../../scripts/adrift-mcp.mjs");
const KEY = "test-admin-key";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown> | null;
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "adrift-mcp-"));
const outDir = path.join(tmp, "output");
mkdirSync(path.join(outDir, "tools"), { recursive: true });
writeFileSync(path.join(outDir, "tools", "up_00001_.png"), "png");

function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
const photo = path.join(tmp, "photo.png");
writeFileSync(photo, pngHeader(640, 480));

const agentTools = buildAgentTools().filter(
  (t) => t.id === "action:upscale" || t.kind === "catalog",
);
const catalogTool = agentTools.find(
  (t) =>
    t.kind === "catalog" &&
    t.inputSchema.required &&
    (t.inputSchema.properties as Record<string, { minItems?: number }>).images
      .minItems === 1 &&
    !(t.inputSchema.required as string[]).includes("mask"),
)!;
for (const t of agentTools) t.available = true;

let seen: Seen[] = [];
let statusCalls = 0;
let fake: http.Server;
let baseUrl = "";

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const run = (id: string, promptId: string) => ({
  run_id: id,
  status: "queued",
  jobs: [{ index: 0, prompt_id: promptId, status: "queued" }],
});

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body,
      });
      const u = new URL(req.url!, "http://x");
      const route = `${req.method} ${u.pathname}`;
      switch (route) {
        case "GET /api/tools/agent":
          return send(res, 200, { ok: true, tools: agentTools });
        case "POST /api/comfy/upload":
          return send(res, 200, { ok: true, ref: `${body.filename} [input]` });
        case "POST /api/tools/agent/compile":
          if (body.options?.mode === "bad")
            return send(res, 400, {
              ok: false,
              error:
                "options.mode must be one of: upscale_subtle, upscale_creative",
              details: { code: "BAD_INPUT" },
            });
          return send(res, 200, {
            ok: true,
            action: "upscale_subtle",
            params: { creativity: 35 },
            overrides: {},
            tool_page_id: "upscale",
            source: "image",
          });
        case "POST /api/jobs/seed-run":
          return send(res, 200, {
            ok: true,
            run: { run_id: "seed-1", jobs: [{ index: 0 }] },
          });
        case "POST /api/jobs/action":
          return send(res, 200, { ok: true, run: run("run-a", "p-action") });
        case "POST /api/jobs/tool":
          return send(res, 200, { ok: true, run: run("run-t", "p-tool") });
        case "POST /api/jobs/imagine":
          return send(res, 200, { ok: true, runs: [run("run-i", "p-img")] });
        case "GET /api/comfy/prompt-status": {
          statusCalls += 1;
          const ids = (u.searchParams.get("ids") ?? "").split(",");
          return send(res, 200, {
            ok: true,
            statuses: Object.fromEntries(
              ids.map((id) => [
                id,
                { state: statusCalls < 2 ? "running" : "done" },
              ]),
            ),
          });
        }
        case "GET /api/comfy/history/p-action":
          return send(res, 200, {
            ok: true,
            images: [
              {
                filename: "ComfyUI_temp_x.png",
                subfolder: "",
                type: "temp",
                url: "/api/comfy/image?filename=ComfyUI_temp_x.png&subfolder=&type=temp",
                nodeId: "5",
                classType: "PreviewImage",
              },
              {
                filename: "up_00001_.png",
                subfolder: "tools",
                type: "output",
                url: "/api/comfy/image?filename=up_00001_.png&subfolder=tools&type=output",
                nodeId: "9",
                classType: "SaveImage",
              },
            ],
            videos: [],
            audios: [],
            meshes: [],
            texts: [],
            status: { status_str: "success", completed: true, messages: [] },
          });
        case "GET /api/jobs/recent":
          return send(res, 200, { ok: true, runs: [] });
        case "GET /api/settings/dirs":
          return send(res, 200, {
            ok: true,
            comfyLocal: true,
            dirs: [{ key: "output", display: outDir }],
          });
        default:
          if (u.pathname.startsWith("/api/comfy/history/"))
            return send(res, 404, { ok: false, error: "History not found" });
          return send(res, 404, { ok: false, error: `no route ${route}` });
      }
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => fake.close(() => r())));

type Rpc = {
  id?: number | string | null;
  result?: any;
  error?: { code: number; message: string };
};

class Client {
  proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private waiters = new Map<unknown, (m: Rpc) => void>();
  private nextId = 1;
  stderr = "";

  constructor(env: Record<string, string>) {
    this.proc = spawn(process.execPath, [SCRIPT], {
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: os.homedir(), ...env },
    });
    this.proc.stderr.on("data", (c) => (this.stderr += c));
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (c: string) => {
      this.buf += c;
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        const msg = JSON.parse(line) as Rpc;
        const w = this.waiters.get(msg.id ?? null);
        if (w) {
          this.waiters.delete(msg.id ?? null);
          w(msg);
        }
      }
    });
  }

  raw(line: string, id: unknown): Promise<Rpc> {
    const p = new Promise<Rpc>((resolve) => this.waiters.set(id, resolve));
    this.proc.stdin.write(`${line}\n`);
    return p;
  }

  request(method: string, params?: unknown): Promise<Rpc> {
    const id = this.nextId++;
    return this.raw(JSON.stringify({ jsonrpc: "2.0", id, method, params }), id);
  }

  notify(method: string) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async call(name: string, args: Record<string, unknown> = {}) {
    const res = await this.request("tools/call", { name, arguments: args });
    expect(res.error).toBeUndefined();
    return res.result as {
      isError?: boolean;
      structuredContent: any;
      content: { type: string; text: string }[];
    };
  }

  async init() {
    const res = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

let client: Client | null = null;
function start(env: Record<string, string> = {}) {
  client = new Client({
    ADRIFT_URL: baseUrl,
    ADRIFT_MCP_POLL_MS: "20",
    ...env,
  });
  return client;
}

afterEach(() => {
  client?.close();
  client = null;
  seen = [];
  statusCalls = 0;
});

describe("adrift-mcp stdio server", () => {
  it("initializes and lists its tools", async () => {
    const c = start();
    const init = await c.init();
    expect(init.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "adrift" },
    });
    const old = await c.request("initialize", {
      protocolVersion: "1999-01-01",
    });
    expect(old.result.protocolVersion).toBe("2025-06-18");
    expect((await c.request("ping")).result).toEqual({});

    const list = await c.request("tools/list");
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_tools",
        "describe_tool",
        "run_tool",
        "job_status",
        "wait_for_job",
        "get_outputs",
        "generate_image",
      ]),
    );
    for (const t of list.result.tools)
      expect(t.inputSchema.type).toBe("object");
  });

  it("lists and describes Adrift tools with registry schemas and badges", async () => {
    const c = start();
    await c.init();
    const listed = await c.call("list_tools", { query: "upscale" });
    expect(listed.isError).toBeUndefined();
    const up = listed.structuredContent.tools.find(
      (t: { id: string }) => t.id === "action:upscale",
    );
    expect(up).toMatchObject({ category: expect.any(String), available: true });
    expect(up).toHaveProperty("vram");
    expect(up).toHaveProperty("commercial");
    expect(JSON.parse(listed.content[0].text).count).toBe(
      listed.structuredContent.count,
    );

    const desc = await c.call("describe_tool", { tool_id: "upscale" });
    expect(desc.structuredContent.id).toBe("action:upscale");
    expect(
      desc.structuredContent.input_schema.properties.options.properties.mode
        .enum,
    ).toEqual(["upscale_subtle", "upscale_creative", "upscale_redetail"]);
  });

  it("runs an action tool, waits, and returns outputs with local paths", async () => {
    const c = start({ ADMIN_API_KEY: KEY });
    await c.init();
    const ran = await c.call("run_tool", {
      tool_id: "action:upscale",
      inputs: { image: photo, options: { mode: "upscale_subtle" } },
    });
    expect(ran.isError).toBeUndefined();
    expect(ran.structuredContent).toMatchObject({
      tool_id: "action:upscale",
      run_id: "run-a",
      job_id: "p-action",
    });

    const upload = seen.find((s) => s.url === "/api/comfy/upload")!;
    expect(String(upload.body!.image)).toMatch(/^data:image\/png;base64,/);
    const seed = seen.find((s) => s.url === "/api/jobs/seed-run")!;
    expect(seed.body).toMatchObject({
      width: 640,
      height: 480,
      ref: expect.stringMatching(/ \[input\]$/),
    });
    const action = seen.find((s) => s.url === "/api/jobs/action")!;
    expect(action.body).toMatchObject({
      run_id: "seed-1",
      job_index: 0,
      action: "upscale_subtle",
      tool_page_id: "upscale",
      params: { creativity: 35 },
      client_id: expect.stringMatching(/^adrift-mcp-/),
    });
    expect(action.body).not.toHaveProperty("workflow_control_overrides");
    for (const s of seen.filter((x) => x.method === "POST")) {
      expect(s.headers.origin).toBe(baseUrl);
      expect(s.headers["x-requested-with"]).toBe("XMLHttpRequest");
      expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
    }

    const st = await c.call("job_status", { job_id: "p-action" });
    expect(st.structuredContent.jobs[0]).toEqual({
      job_id: "p-action",
      state: "running",
    });

    const waited = await c.call("wait_for_job", {
      job_id: "p-action",
      timeout_seconds: 5,
    });
    expect(waited.structuredContent.state).toBe("done");
    // Finished runs are reconciled so the gallery/DB/video QC catch up.
    const syncs = seen.filter((s) => s.url.startsWith("/api/jobs/recent"));
    expect(syncs.map((s) => s.url)).toEqual(["/api/jobs/recent?run_id=run-a"]);
    expect(syncs[0].headers.authorization).toBe(`Bearer ${KEY}`);
    const files = waited.structuredContent.outputs.files;
    expect(files).toHaveLength(2);
    const final = files.find((f: { final?: boolean }) => f.final);
    expect(final).toMatchObject({
      filename: "up_00001_.png",
      ref: "tools/up_00001_.png [output]",
      url: `${baseUrl}/api/comfy/image?filename=up_00001_.png&subfolder=tools&type=output`,
      local_path: path.join(outDir, "tools", "up_00001_.png"),
    });
    expect(
      files.find((f: { type: string }) => f.type === "temp"),
    ).not.toHaveProperty("local_path");

    const outs = await c.call("get_outputs", { job_id: "p-action" });
    expect(outs.structuredContent).toMatchObject({
      ready: true,
      status: "success",
    });
    expect(
      seen.filter((s) => s.url === "/api/jobs/recent?run_id=run-a"),
    ).toHaveLength(2);
  });

  it("runs a catalog tool, chaining an output ref as input", async () => {
    const c = start();
    await c.init();
    const ran = await c.call("run_tool", {
      tool_id: catalogTool.id,
      inputs: { images: ["prev.png [input]"], options: { seed: 7 } },
    });
    expect(ran.isError).toBeUndefined();
    expect(ran.structuredContent.job_id).toBe("p-tool");
    const sub = seen.find((s) => s.url === "/api/jobs/tool")!;
    expect(sub.body).toMatchObject({
      toolId: catalogTool.id.replace(/^catalog:/, ""),
      images: ["prev.png [input]"],
      options: { seed: 7 },
    });
    expect(seen.some((s) => s.url === "/api/comfy/upload")).toBe(false);
    expect(sub.headers.authorization).toBeUndefined();
  });

  it("generates an image through the Create path", async () => {
    const c = start();
    await c.init();
    const gen = await c.call("generate_image", {
      prompt: "a lighthouse --ar 16:9",
      batch_size: 2,
    });
    expect(gen.structuredContent.job_ids).toEqual(["p-img"]);
    expect(seen.find((s) => s.url === "/api/jobs/imagine")!.body).toMatchObject(
      {
        prompt: "a lighthouse --ar 16:9",
        batch_size: 2,
        client_id: expect.stringMatching(/^adrift-mcp-/),
      },
    );
  });

  it("reports protocol errors with JSON-RPC codes", async () => {
    const c = start();
    await c.init();
    expect((await c.raw("{not json", null)).error!.code).toBe(-32700);
    expect(
      (await c.raw(JSON.stringify({ id: 99, method: "ping" }), 99)).error!.code,
    ).toBe(-32600);
    expect((await c.request("resources/list")).error!.code).toBe(-32601);
    expect(
      (await c.request("tools/call", { name: "nope", arguments: {} })).error!
        .code,
    ).toBe(-32602);
    expect(
      (await c.request("tools/call", { name: "list_tools", arguments: [1] }))
        .error!.code,
    ).toBe(-32602);
  });

  it("returns tool failures as isError results", async () => {
    const c = start();
    await c.init();
    const missing = await c.call("run_tool", {
      tool_id: "action:upscale",
      inputs: {},
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toMatch(/missing required input "image"/);

    const unknownInput = await c.call("run_tool", {
      tool_id: "action:upscale",
      inputs: { image: photo, colour: "red" },
    });
    expect(unknownInput.content[0].text).toMatch(/unknown input "colour"/);

    const bad = await c.call("run_tool", {
      tool_id: "action:upscale",
      inputs: { image: photo, options: { mode: "bad" } },
    });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.details).toMatchObject({
      status: 400,
      code: "BAD_INPUT",
    });
    expect(seen.some((s) => s.url === "/api/jobs/action")).toBe(false);

    const nofile = await c.call("run_tool", {
      tool_id: "action:upscale",
      inputs: { image: path.join(tmp, "missing.png") },
    });
    expect(nofile.content[0].text).toMatch(/file not found/);

    const relative = await c.call("run_tool", {
      tool_id: "action:upscale",
      inputs: { image: "photo.png" },
    });
    expect(relative.content[0].text).toMatch(/absolute file path/);

    const unknownTool = await c.call("describe_tool", {
      tool_id: "action:nope",
    });
    expect(unknownTool.content[0].text).toMatch(/Unknown tool/);

    const notReady = await c.call("get_outputs", { job_id: "p-unknown" });
    expect(notReady.structuredContent.ready).toBe(false);
  });

  it("reports an unreachable Adrift as a tool error", async () => {
    const c = start({ ADRIFT_URL: "http://127.0.0.1:9" });
    await c.init();
    const res = await c.call("list_tools");
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not reachable/);
  });
});

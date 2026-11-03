#!/usr/bin/env node
/**
 * Tiny no-GPU mock ComfyUI for UI crawls and demos. No dependencies.
 *
 *   node scripts/mock-comfy/server.mjs [--port 18999] [--fake-root DIR]
 *
 * Binds 127.0.0.1 only. Serves the recorded test fixtures:
 *   GET  /object_info, /object_info/<class>   merged *.objectInfo.json fixtures
 *   GET  /models, /models/<folder>            weight names the pack graphs use
 *   GET  /queue, /system_stats, /features, /embeddings, /history[/<id>]
 *   WS   /ws                                  handshake + status / progress
 *   POST /prompt          fake run: ~2 s of WS progress, then a sample output
 *                         (a bundled public/tool-previews file) in /history
 *   GET  /view            serves that sample
 *   POST /upload/image, /interrupt, /free, /queue   accepted, nothing stored
 * Every other method answers 503. Unknown GETs answer 404. Nothing runs a
 * model. Every path also works under /api (ComfyUI serves both).
 *
 * --fake-root DIR writes zero-byte placeholder weights under DIR/models/...
 * (plus an empty DIR/custom_nodes) so the app, started with COMFY_ROOT=DIR,
 * reports every tool as installed. DIR must not exist yet or be empty-ish
 * scratch space; nothing outside DIR is touched.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = join(APP_DIR, "src/__tests__/fixtures");
const PACKS = join(APP_DIR, "public/workflows/packs");
const PREVIEWS = join(APP_DIR, "public/tool-previews");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(flag("--port", process.env.MOCK_COMFY_PORT || "18999"));
const FAKE_ROOT = flag("--fake-root", "");
const HOST = "127.0.0.1";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// object_info: merge every recorded fixture
const objectInfo = {};
const infoFiles = [
  ...readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json") && f.includes("objectInfo"))
    .map((f) => join(FIXTURES, f)),
  join(FIXTURES, "comfy-contract/object_info.json"),
];
for (const file of infoFiles) {
  let data;
  try {
    data = readJson(file);
  } catch {
    continue;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) continue;
  for (const [cls, spec] of Object.entries(data)) {
    if (cls.startsWith("_") || !spec || typeof spec !== "object") continue;
    if (!("input" in spec) && !("output" in spec)) continue;
    // First (largest, graphLint) fixture wins; later ones only fill gaps.
    if (!objectInfo[cls]) objectInfo[cls] = { name: cls, ...spec };
  }
}

// models: weight names referenced by the pack graphs
const INPUT_FOLDERS = {
  ckpt_name: ["checkpoints"],
  unet_name: ["diffusion_models", "unet"],
  lora_name: ["loras"],
  vae_name: ["vae"],
  clip_name: ["text_encoders", "clip"],
  clip_name1: ["text_encoders", "clip"],
  clip_name2: ["text_encoders", "clip"],
  clip_name3: ["text_encoders", "clip"],
  clip_name4: ["text_encoders", "clip"],
  control_net_name: ["controlnet"],
  style_model_name: ["style_models"],
  audio_encoder_name: ["audio_encoders"],
};
const CLASS_FOLDERS = {
  LatentUpscaleModelLoader: ["latent_upscale_models"],
  UpscaleModelLoader: ["upscale_models"],
  FrameInterpolationModelLoader: ["frame_interpolation"],
  CLIPVisionLoader: ["clip_vision"],
};
const WEIGHT_RE = /\.(safetensors|gguf|ckpt|pt|pth|bin|onnx|sft)$/i;
const models = new Map(); // folder -> Set<file>
const addModel = (folder, file) => {
  if (!models.has(folder)) models.set(folder, new Set());
  models.get(folder).add(file);
};
const usedValues = new Map(); // class_type -> input -> Set<value>
const used = (cls, key, value) => {
  if (!usedValues.has(cls)) usedValues.set(cls, new Map());
  const byInput = usedValues.get(cls);
  if (!byInput.has(key)) byInput.set(key, new Set());
  byInput.get(key).add(value);
};
function walkJson(dir, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkJson(p, out);
    else if (ent.name.endsWith(".json")) out.push(p);
  }
  return out;
}
for (const file of walkJson(PACKS, [])) {
  let graph;
  try {
    graph = readJson(file);
  } catch {
    continue;
  }
  if (!graph || typeof graph !== "object") continue;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : Object.values(graph);
  for (const node of nodes) {
    if (!node || typeof node !== "object" || !node.inputs) continue;
    const inputs = Array.isArray(node.inputs) ? {} : node.inputs;
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value !== "string" || !WEIGHT_RE.test(value)) continue;
      const folders = CLASS_FOLDERS[node.class_type] ??
        INPUT_FOLDERS[key] ?? ["other"];
      for (const f of folders) addModel(f, value.replace(/\\/g, "/"));
      used(node.class_type, key, value);
    }
  }
}
// Loader combos list every file the pack graphs pick, so the app's
// object_info model check (backendModels.missingAgainstObjectInfo) passes.
for (const [cls, byInput] of usedValues) {
  const spec = objectInfo[cls];
  if (!spec?.input) continue;
  for (const [key, values] of byInput) {
    for (const section of ["required", "optional"]) {
      const def = spec.input[section]?.[key];
      if (!Array.isArray(def)) continue;
      if (Array.isArray(def[0])) def[0] = [...new Set([...def[0], ...values])];
      else if (def[0] === "COMBO" && Array.isArray(def[1]?.options))
        def[1].options = [...new Set([...def[1].options, ...values])];
    }
  }
}
// Fixture combos (e.g. UNETLoader.unet_name) count as installed too.
for (const [cls, spec] of Object.entries(objectInfo)) {
  for (const [key, def] of Object.entries(spec.input?.required ?? {})) {
    const folders = CLASS_FOLDERS[cls] ?? INPUT_FOLDERS[key];
    if (!folders || !Array.isArray(def) || !Array.isArray(def[0])) continue;
    for (const v of def[0]) {
      if (typeof v === "string" && WEIGHT_RE.test(v))
        for (const f of folders) addModel(f, v);
    }
  }
}
const modelList = (folder) => [...(models.get(folder) ?? [])].sort();

if (FAKE_ROOT) {
  const root = resolve(FAKE_ROOT);
  mkdirSync(join(root, "custom_nodes"), { recursive: true });
  let n = 0;
  for (const [folder, files] of models) {
    for (const f of files) {
      const p = join(root, "models", folder, f);
      if (!p.startsWith(join(root, "models") + "/")) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "");
      n++;
    }
  }
  console.log(`[mock-comfy] fake root ${root}: ${n} placeholder weights`);
}

// fixed payloads
const fixture = (rel, fallback) => {
  try {
    return readJson(join(FIXTURES, rel));
  } catch {
    return fallback;
  }
};
const systemStats = fixture("comfy-contract/system_stats.json", {
  system: { os: "mock", comfyui_version: "mock" },
  devices: [],
});
const features = fixture("comfy-contract/features.json", {});

// fake runs: POST /prompt -> WS progress -> sample output in /history
const history = {}; // prompt_id -> history entry
const running = new Map(); // prompt_id -> queue row
let promptNumber = 0;
const previewFiles = existsSync(PREVIEWS) ? readdirSync(PREVIEWS) : [];
const VIDEO_SAVE = /VideoCombine|SaveVideo|SaveWEBM|SaveAnimated|CreateVideo/;
const SAVE = /^(Save|Preview)|VideoCombine|SaveVideo/;

/** "video/CJ_VaceExtend" -> "vace_extend" */
function prefixToken(prefix) {
  const last = String(prefix || "").split("/").pop() || "";
  return last
    .replace(/^(CJ|Adrift|cj|adrift)_/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/** Output node id + a bundled preview that roughly matches the graph. */
function pickSample(graph) {
  const nodes = Object.entries(graph || {}).filter(
    ([, n]) => n && typeof n === "object" && typeof n.class_type === "string",
  );
  const save =
    nodes.find(([, n]) => VIDEO_SAVE.test(n.class_type)) ??
    nodes.find(([, n]) => SAVE.test(n.class_type)) ??
    nodes[nodes.length - 1];
  const node = save?.[1];
  const prefix = node?.inputs?.filename_prefix;
  const video =
    Boolean(node && VIDEO_SAVE.test(node.class_type)) ||
    /^video\//.test(String(prefix || ""));
  const ext = video ? ".webm" : ".webp";
  const token = prefixToken(prefix);
  const byToken =
    token &&
    previewFiles.find(
      (f) => f.endsWith(ext) && f.replace(/\.\w+$/, "").endsWith(token),
    );
  const fallback = video ? "action--animate.webm" : "action--edit_photo.webp";
  const file =
    byToken || (previewFiles.includes(fallback) ? fallback : previewFiles[0]);
  return { nodeId: save?.[0] ?? "1", file, video };
}

const sockets = new Map(); // clientId -> Set<socket>
function wsSend(clientId, type, data) {
  const frame = wsFrame(JSON.stringify({ type, data }));
  // ComfyUI sends run events to the queuing client; Adrift's server queues
  // with its own id, so fall back to every open socket.
  const targets = sockets.get(clientId) ?? new Set([...sockets.values()].flatMap((s) => [...s]));
  for (const sock of targets) {
    try {
      sock.write(frame);
    } catch {
      /* closed */
    }
  }
}
const status = (remaining) => ({
  status: { exec_info: { queue_remaining: remaining } },
});

function fakeRun(body) {
  const prompt_id = randomUUID();
  const number = promptNumber++;
  const graph = body?.prompt && typeof body.prompt === "object" ? body.prompt : {};
  const clientId = typeof body?.client_id === "string" ? body.client_id : "";
  const { nodeId, file, video } = pickSample(graph);
  running.set(prompt_id, [number, prompt_id, graph, {}, [nodeId]]);
  const view = { filename: file, subfolder: "mock", type: "output" };
  const output = video
    ? { gifs: [{ ...view, format: "video/webm" }] }
    : { images: [view] };
  const steps = 8;
  let step = 0;
  wsSend(clientId, "status", status(1));
  wsSend(clientId, "execution_start", { prompt_id, timestamp: Date.now() });
  wsSend(clientId, "executing", { node: nodeId, display_node: nodeId, prompt_id });
  const tick = setInterval(() => {
    step++;
    wsSend(clientId, "progress", { value: step, max: steps, prompt_id, node: nodeId });
    if (step < steps) return;
    clearInterval(tick);
    history[prompt_id] = {
      prompt: [number, prompt_id, graph, {}, [nodeId]],
      outputs: { [nodeId]: output },
      status: { status_str: "success", completed: true, messages: [] },
      meta: { [nodeId]: { node_id: nodeId, display_node: nodeId } },
    };
    running.delete(prompt_id);
    wsSend(clientId, "executed", { node: nodeId, display_node: nodeId, output, prompt_id });
    wsSend(clientId, "executing", { node: null, prompt_id });
    wsSend(clientId, "execution_success", { prompt_id, timestamp: Date.now() });
    wsSend(clientId, "status", status(0));
    if (process.env.MOCK_COMFY_LOG) console.log("[mock-comfy] done", prompt_id, file);
  }, 250);
  return { prompt_id, number, node_errors: {} };
}

/** Read a request body (capped); resolves to a Buffer. */
function readBody(req, cap) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        fail(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

async function handlePost(req, res, p) {
  if (p === "/prompt") {
    let body;
    try {
      body = JSON.parse((await readBody(req, 20 * 1024 * 1024)).toString("utf8"));
    } catch {
      return send(res, 400, { error: "mock-comfy: bad prompt body" });
    }
    return send(res, 200, fakeRun(body));
  }
  if (p === "/upload/image" || p === "/upload/mask") {
    let name = "mock_upload.png";
    try {
      const raw = (await readBody(req, 200 * 1024 * 1024)).toString("latin1");
      name = /filename="([^"]+)"/.exec(raw)?.[1] ?? name;
    } catch {
      return send(res, 413, { error: "mock-comfy: upload too large" });
    }
    return send(res, 200, { name, subfolder: "", type: "input" });
  }
  if (p === "/interrupt" || p === "/free" || p === "/queue") {
    req.resume();
    return send(res, 200, {});
  }
  req.resume();
  return send(res, 503, {
    error: "mock-comfy: not supported",
    method: req.method,
    path: p,
  });
}

function view(res, url) {
  const name = url.searchParams.get("filename") || "";
  if (!previewFiles.includes(name)) return send(res, 404, { error: "not found" });
  const data = readFileSync(join(PREVIEWS, name));
  res.writeHead(200, {
    "content-type": name.endsWith(".webm") ? "video/webm" : "image/webp",
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
}

// http
function send(res, status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type":
      typeof body === "string" ? "text/plain" : "application/json",
    "cache-control": "no-store",
  });
  res.end(text);
}

function route(pathname) {
  const p = pathname.replace(/^\/api(?=\/)/, "").replace(/\/+$/, "") || "/";
  if (p === "/object_info") return [200, objectInfo];
  if (p.startsWith("/object_info/")) {
    const cls = decodeURIComponent(p.slice("/object_info/".length));
    return objectInfo[cls] ? [200, { [cls]: objectInfo[cls] }] : [200, {}];
  }
  if (p === "/models") return [200, [...models.keys()].sort()];
  if (p.startsWith("/models/"))
    return [200, modelList(decodeURIComponent(p.slice("/models/".length)))];
  if (p === "/queue")
    return [200, { queue_running: [...running.values()], queue_pending: [] }];
  if (p === "/system_stats") return [200, systemStats];
  if (p === "/features") return [200, features];
  if (p === "/embeddings") return [200, []];
  if (p === "/extensions") return [200, []];
  if (p === "/history") return [200, history];
  if (p.startsWith("/history/")) {
    const id = decodeURIComponent(p.slice("/history/".length));
    return [200, history[id] ? { [id]: history[id] } : {}];
  }
  if (p === "/userdata") return [200, []];
  if (p === "/") return [200, "mock-comfy: fixture server (fake runs, no GPU)"];
  return [404, { error: "mock-comfy: not recorded", path: p }];
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}`);
  const p = url.pathname.replace(/^\/api(?=\/)/, "").replace(/\/+$/, "") || "/";
  if (process.env.MOCK_COMFY_LOG) console.log(req.method, url.pathname);
  if (req.method === "POST") {
    handlePost(req, res, p).catch(() => send(res, 500, { error: "mock-comfy" }));
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    req.resume();
    return send(res, 503, { error: "mock-comfy: not supported", method: req.method, path: p });
  }
  if (p === "/view") return view(res, url);
  const [code, body] = route(url.pathname);
  send(res, code, body);
});

// minimal websocket (/ws): handshake + one status frame
function wsFrame(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  const head =
    len < 126
      ? Buffer.from([0x81, len])
      : len < 65536
        ? Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff])
        : Buffer.from([0x81, 127, 0, 0, 0, 0, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.concat([head, payload]);
}
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  const url = new URL(req.url || "/", `http://${HOST}`);
  if (!key || !/^\/(api\/)?ws$/.test(url.pathname)) {
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
      `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const sid = url.searchParams.get("clientId") || "mock";
  if (!sockets.has(sid)) sockets.set(sid, new Set());
  sockets.get(sid).add(socket);
  const forget = () => {
    sockets.get(sid)?.delete(socket);
    if (sockets.get(sid)?.size === 0) sockets.delete(sid);
  };
  socket.on("close", forget);
  socket.write(
    wsFrame(
      JSON.stringify({
        type: "status",
        data: { status: { exec_info: { queue_remaining: running.size } }, sid },
      }),
    ),
  );
  socket.on("data", (buf) => {
    // Opcode 0x8 = close: echo a close frame and hang up. Ignore the rest.
    if (buf.length && (buf[0] & 0x0f) === 0x8) {
      socket.end(Buffer.from([0x88, 0]));
    }
  });
  socket.on("error", () => socket.destroy());
});

server.listen(PORT, HOST, () => {
  console.log(
    `[mock-comfy] http://${HOST}:${PORT}  classes=${Object.keys(objectInfo).length}` +
      ` model folders=${models.size}  samples=${previewFiles.length}  (fake runs, no GPU)`,
  );
});

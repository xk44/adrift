/**
 * Replays a ComfyUI 0.42 WebSocket message sequence (fixtures/comfy-contract/
 * ws_sequence.json, built from server.py / execution.py / main.py /
 * comfy_execution/progress.py) through Adrift's two WS consumers:
 *
 *   - the SSE bridge  GET /api/comfy/progress
 *   - the client hook useComfyWS (handleMessage → generation store), whose
 *     completion fetch is served by the real /api/comfy/history route over
 *     the recorded history entry.
 *
 * The "BUG" cases were pinned as `it.fails` until fixed; they now guard the
 * fixes as regular tests. Latent previews (binary frames) are replayed into
 * the livePreviews registry.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Frame =
  | { type: string; data: Record<string, any> }
  | {
      binary: true;
      event: number;
      metadata?: Record<string, unknown>;
      image_type_num?: number;
      image_b64: string;
    };

interface Sequence {
  prompt_id: string;
  frames: Frame[];
  cached_nodes?: string[];
  node_count?: number;
}

const FIXTURES = join(__dirname, "fixtures/comfy-contract");
const ws = JSON.parse(
  readFileSync(join(FIXTURES, "ws_sequence.json"), "utf8"),
) as {
  comfyui_version: string;
  client_id: string;
  success: Sequence;
  error: Sequence;
  interrupted: Sequence;
};
const history = JSON.parse(
  readFileSync(join(FIXTURES, "history.json"), "utf8"),
) as Record<string, any>;
const successEntry = history[ws.success.prompt_id];

/** Encode a binary frame exactly as server.py encode_bytes / send_image_with_metadata. */
function binaryFrame(frame: Extract<Frame, { binary: true }>): ArrayBuffer {
  const image = Buffer.from(frame.image_b64, "base64");
  const header: number[] = [frame.event];
  let meta = Buffer.alloc(0);
  if (frame.event === 4) {
    meta = Buffer.from(JSON.stringify(frame.metadata ?? {}), "utf8");
    header.push(meta.length);
  } else {
    header.push(frame.image_type_num ?? 1);
  }
  const out = new ArrayBuffer(header.length * 4 + meta.length + image.length);
  const view = new DataView(out);
  header.forEach((n, i) => view.setUint32(i * 4, n, false));
  const bytes = new Uint8Array(out);
  bytes.set(meta, header.length * 4);
  bytes.set(image, header.length * 4 + meta.length);
  return out;
}

function wire(frame: Frame): string | ArrayBuffer {
  return "binary" in frame ? binaryFrame(frame) : JSON.stringify(frame);
}

// ---------------------------------------------------------------------------
// Fake WebSocket (both consumers construct the global one)
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private listeners = new Map<string, Array<(e: any) => void>>();

  binaryType = "blob";
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  addEventListener(type: string, fn: (e: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  private dispatch(type: string, event: any) {
    (this as any)[`on${type}`]?.(event);
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open", {});
  }
  emit(data: string | ArrayBuffer) {
    this.dispatch("message", { data });
  }
  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close", { code, reason });
  }
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const fetchHistory = vi.fn();
vi.mock("@/lib/auth", () => ({ requireAdmin: () => ({ ok: true }) }));
vi.mock("@/lib/rateLimit", () => ({ withRateLimit: () => ({ ok: true }) }));
vi.mock("@/lib/comfy/http", () => ({ fetchHistory }));

// Run the hook body outside React: refs are plain boxes, callbacks are
// identity, effects run immediately (cleanup ignored).
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const shim = {
    useRef: <T>(v: T) => ({ current: v }),
    useCallback: <T>(fn: T) => fn,
    useEffect: (fn: () => unknown) => void fn(),
  };
  return { ...actual, ...shim, default: { ...actual, ...shim } };
});

// The real zustand store, callable as a hook outside React.
vi.mock("@/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store")>();
  const store = actual.useGenerationStore;
  const hook = Object.assign(
    (selector: (s: ReturnType<typeof store.getState>) => unknown) =>
      selector(store.getState()),
    store,
  );
  return { ...actual, useGenerationStore: hook };
});

let historyFetches: string[] = [];
// ComfyUI /queue as seen by /api/comfy/prompt-status (null = unreadable).
let comfyQueue: { queue_running: unknown[][]; queue_pending: unknown[][] } | null =
  { queue_running: [], queue_pending: [] };

async function routeFetch(input: string | URL | Request): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("/api/comfy/prompt-status")) {
    const { GET } = await import("@/app/api/comfy/prompt-status/route");
    return GET(new NextRequest(`http://localhost${url}`));
  }
  if (url.endsWith(":8189/system_stats")) return new Response("", { status: 502 });
  if (url.endsWith("/queue")) {
    return comfyQueue
      ? new Response(JSON.stringify(comfyQueue), { status: 200 })
      : new Response("", { status: 502 });
  }
  const historyMatch = url.match(/\/api\/comfy\/history\/([^?]+)/);
  if (historyMatch) {
    const promptId = decodeURIComponent(historyMatch[1]);
    historyFetches.push(promptId);
    const { GET } = await import("@/app/api/comfy/history/[promptId]/route");
    return GET(new NextRequest(`http://localhost${url}`), {
      params: Promise.resolve({ promptId }),
    });
  }
  if (url.includes("/api/comfy/prompt-titles/")) {
    return new Response(JSON.stringify({ titles: {} }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
}

beforeEach(async () => {
  // The hook shares one socket per URL per tab; start each test fresh.
  (await import("@/lib/comfy/sharedSocket")).comfySocketPool.reset();
  FakeWebSocket.instances = [];
  historyFetches = [];
  comfyQueue = { queue_running: [], queue_pending: [] };
  // Load the routes before any test fakes timers (a first import under fake
  // timers never settles).
  await import("@/app/api/comfy/prompt-status/route");
  await import("@/app/api/comfy/history/[promptId]/route");
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn(routeFetch));
  fetchHistory.mockReset();
  fetchHistory.mockImplementation(async (id: string) =>
    id === ws.success.prompt_id ? successEntry : null,
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  // Hooks are never unmounted here (effects have no cleanup): let a test's
  // connect-time reconcile settle before the next test fakes timers.
  await new Promise((r) => setTimeout(r, 25));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture sanity
// ---------------------------------------------------------------------------

describe("ws_sequence fixture", () => {
  it("matches the recorded ComfyUI version and history entry", () => {
    expect(ws.comfyui_version).toMatch(/^0\.42\./);
    expect(successEntry).toBeTruthy();
    const executed = ws.success.frames.find(
      (f) => "type" in f && f.type === "executed",
    ) as { data: Record<string, any> };
    expect(successEntry.outputs[executed.data.node]).toEqual(
      executed.data.output,
    );
    expect(Object.keys(successEntry.prompt[2])).toHaveLength(
      ws.success.node_count!,
    );
  });

  it("encodes preview frames with ComfyUI's big-endian headers", () => {
    const frames = ws.success.frames.filter(
      (f): f is Extract<Frame, { binary: true }> => "binary" in f,
    );
    expect(frames.map((f) => f.event)).toEqual([4, 1]);
    const withMeta = new DataView(binaryFrame(frames[0]));
    expect(withMeta.getUint32(0)).toBe(4);
    const metaLen = withMeta.getUint32(4);
    const meta = JSON.parse(
      Buffer.from(withMeta.buffer, 8, metaLen).toString("utf8"),
    );
    expect(meta).toMatchObject({
      node_id: "7",
      prompt_id: ws.success.prompt_id,
      image_type: expect.stringMatching(/^image\//),
    });
    const legacy = new DataView(binaryFrame(frames[1]));
    expect([legacy.getUint32(0), legacy.getUint32(4)]).toEqual([1, 1]);
  });
});

// ---------------------------------------------------------------------------
// SSE bridge: GET /api/comfy/progress
// ---------------------------------------------------------------------------

type SseEvent = { event: string; data: any };

async function replayThroughSse(
  frames: Frame[],
  before?: () => void,
): Promise<SseEvent[]> {
  before?.();
  const { GET } = await import("@/app/api/comfy/progress/route");
  const res = await GET(
    new NextRequest(
      `http://localhost/api/comfy/progress?client_id=${ws.client_id}`,
    ),
  );
  expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  const sock = FakeWebSocket.instances.at(-1)!;
  expect(sock.url).toContain(`/ws?clientId=${ws.client_id}`);
  sock.open();
  for (const frame of frames) sock.emit(wire(frame));
  sock.close();
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("event: "))
    .map((block) => {
      const [eventLine, dataLine] = block.split("\n");
      return {
        event: eventLine.slice("event: ".length),
        data: JSON.parse(dataLine.slice("data: ".length)),
      };
    });
}

describe("SSE bridge replay (/api/comfy/progress)", () => {
  it("forwards executing/progress and ends a successful run with complete", async () => {
    const events = await replayThroughSse(ws.success.frames);
    expect(events.every((e) => e.data.prompt_id === ws.success.prompt_id)).toBe(
      true,
    );
    expect(
      events.filter((e) => e.event === "executing").map((e) => e.data.node),
    ).toEqual(["10", "11", "12", "6", "7", "8", "9"]);
    const progress = events.filter((e) => e.event === "progress");
    expect(progress.map((e) => [e.data.node, e.data.step, e.data.max])).toEqual(
      [
        ["7", 1, 4],
        ["7", 2, 4],
        ["7", 3, 4],
        ["7", 4, 4],
      ],
    );
    expect(events.at(-1)).toEqual({
      event: "complete",
      data: { prompt_id: ws.success.prompt_id },
    });
    // status / execution_* / executed / progress_state / binary frames are
    // not surfaced, and binary previews never crash the stream.
    expect(new Set(events.map((e) => e.event))).toEqual(
      new Set(["executing", "progress", "complete"]),
    );
  });

  it("surfaces execution_error with node type and exception", async () => {
    const events = await replayThroughSse(ws.error.frames);
    const error = events.find((e) => e.event === "error")!;
    expect(error.data).toMatchObject({
      prompt_id: ws.error.prompt_id,
      node: "7",
      exception_type: "torch.OutOfMemoryError",
    });
    expect(error.data.message).toContain("KSampler");
    expect(error.data.message).toMatch(/Allocation on device/);
  });

  it("surfaces execution_interrupted as cancelled", async () => {
    const events = await replayThroughSse(ws.interrupted.frames);
    expect(events.find((e) => e.event === "cancelled")?.data).toMatchObject({
      prompt_id: ws.interrupted.prompt_id,
      node: "7",
      message: expect.stringMatching(/^Cancelled at /),
    });
  });

  // BUG (progress route): ComfyUI always sends `executing {node:null}` after
  // task_done — also for failed/interrupted prompts (main.py prompt_worker) —
  // so the SSE stream emits `complete` right after `error` / `cancelled`.
  it("does not report complete after an execution_error", async () => {
    const events = await replayThroughSse(ws.error.frames);
    expect(events.map((e) => e.event)).not.toContain("complete");
  });

  it("does not report complete after execution_interrupted", async () => {
    const events = await replayThroughSse(ws.interrupted.frames);
    expect(events.map((e) => e.event)).not.toContain("complete");
  });

  // BUG (progress route): the executing label reads data.class_type, which
  // ComfyUI never sends (only node / display_node / prompt_id), so every
  // label is "Node <id>" even when the prompt's titles are known.
  it(
    "labels executing nodes from the prompt, not 'Node <id>'",
    async () => {
      const { rememberPromptTitles } = await import("@/lib/comfy/promptTitles");
      const events = await replayThroughSse(ws.success.frames, () =>
        rememberPromptTitles(ws.success.prompt_id, successEntry.prompt[2]),
      );
      const sampler = events.find(
        (e) => e.event === "executing" && e.data.node === "7",
      )!;
      expect(sampler.data.label).toBe("KSampler");
      const titled = events.find(
        (e) => e.event === "executing" && e.data.node === "12",
      )!;
      expect(titled.data.label).toBe("Spectrum MOSS-Image (Adaptive)");
      // Step progress carries the sampling node's title, not "Sampling".
      const progress = events.filter((e) => e.event === "progress");
      expect(progress.map((e) => e.data.label)).toEqual(
        Array(4).fill("KSampler"),
      );
    },
  );

  it("reports complete exactly once per successful prompt", async () => {
    const events = await replayThroughSse(ws.success.frames);
    expect(events.filter((e) => e.event === "complete")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Client hook: useComfyWS → generation store
// ---------------------------------------------------------------------------

async function setupHook(promptId: string) {
  const { useGenerationStore } = await import("@/store");
  const store = useGenerationStore;
  store.setState({ runs: [], queueRemaining: 0, currentPromptId: null });
  const graph = successEntry.prompt[2] as Record<
    string,
    { class_type: string }
  >;
  store.getState().addRun({
    run_id: "replay-run",
    prompt: "replay",
    parsedPrompt: "replay",
    width: 1024,
    height: 1024,
    createdAt: new Date(0).toISOString(),
    status: "queued",
    params: {},
    workflowNodeClassMap: Object.fromEntries(
      Object.entries(graph).map(([id, n]) => [id, n.class_type]),
    ),
    jobs: [
      {
        prompt_id: promptId,
        seed: 1,
        index: 0,
        status: "queued",
        progress: 0,
        images: [],
      },
    ],
  });
  const { useComfyWS } = await import("@/hooks/useComfyWS");
  useComfyWS();
  const sock = FakeWebSocket.instances.at(-1)!;
  expect(sock.url).toMatch(/\/ws\?clientId=/);
  const job = () => store.getState().runs[0].jobs[0];
  return { store, sock, job };
}

describe("useComfyWS replay → generation store", () => {
  it("tracks queue, node progress and completion, then loads outputs from history", async () => {
    const { store, sock, job } = await setupHook(ws.success.prompt_id);
    const errorSpy = vi.spyOn(console, "error");
    const progress: number[] = [];
    const queue: number[] = [];
    const labels = new Set<string>();

    for (const frame of ws.success.frames) {
      sock.emit(wire(frame));
      queue.push(store.getState().queueRemaining);
      progress.push(job().progress);
      if (job().currentNodeLabel) labels.add(job().currentNodeLabel!);
      if ("type" in frame && frame.type === "execution_cached") {
        // 5 of 12 nodes cached → progress jumps to 42%.
        expect(job()).toMatchObject({ status: "running", progress: 42 });
      }
      if (
        "type" in frame &&
        frame.type === "progress" &&
        frame.data.value === 2
      ) {
        expect(job().nodeProgress).toEqual({ current: 2, total: 4 });
        expect(job().currentNode).toBe("7");
      }
    }

    expect(queue).toContain(1);
    expect(store.getState().queueRemaining).toBe(0);
    expect(store.getState().currentPromptId).toBeNull();
    expect(job()).toMatchObject({ status: "done", progress: 100 });
    expect(job().completedNodes).toBe(6);
    expect(labels.size).toBeGreaterThan(3);
    expect(progress.at(-1)).toBe(100);

    const expectedUrl =
      "/api/comfy/image?filename=cj_spectrum_fix_00001_.png&subfolder=&type=output";
    await vi.waitFor(() => expect(job().images).toEqual([expectedUrl]));
    expect(store.getState().runs[0].status).toBe("done");
    // Binary preview frames and progress_state / feature_flags are ignored
    // without parse errors.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // BUG (useComfyWS): on `executing` the hook computes progress before the
  // store bumps completedNodes, so each node transition after a sampler
  // drops the bar (83% at step 4/4 of node 7 → 75% on node 8).
  it("never moves the progress bar backwards", async () => {
    const { sock, job } = await setupHook(ws.success.prompt_id);
    const progress: number[] = [];
    for (const frame of ws.success.frames) {
      sock.emit(wire(frame));
      progress.push(job().progress);
    }
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i], `frame ${i}`).toBeGreaterThanOrEqual(progress[i - 1]);
    }
  });

  // BUG (useComfyWS): history is fetched on both execution_success and the
  // trailing `executing {node:null}`.
  it("fetches history once per completed prompt", async () => {
    const { sock, job } = await setupHook(ws.success.prompt_id);
    for (const frame of ws.success.frames) sock.emit(wire(frame));
    await vi.waitFor(() => expect(job().images).toHaveLength(1));
    expect(historyFetches).toEqual([ws.success.prompt_id]);
  });

  it("marks the job errored with the node and exception", async () => {
    const { sock, job } = await setupHook(ws.error.prompt_id);
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const frame of ws.error.frames) {
      sock.emit(wire(frame));
      if ("type" in frame && frame.type === "execution_error") {
        expect(job().status).toBe("error");
        expect(job().error).toContain("KSampler");
        expect(job().error).toMatch(/Allocation on device/);
      }
    }
  });

  // BUG (useComfyWS): the trailing `executing {node:null}` ComfyUI sends after
  // every prompt (main.py prompt_worker) is treated as success, flipping an
  // errored job to done/100% and starting the history retry loop.
  it(
    "keeps an errored job errored after the trailing executing null",
    async () => {
      const { sock, job } = await setupHook(ws.error.prompt_id);
      vi.spyOn(console, "error").mockImplementation(() => {});
      for (const frame of ws.error.frames) sock.emit(wire(frame));
      expect(job().status).toBe("error");
    },
  );

  it("marks an interrupted job cancelled on execution_interrupted", async () => {
    const { sock, job } = await setupHook(ws.interrupted.prompt_id);
    for (const frame of ws.interrupted.frames) {
      sock.emit(wire(frame));
      if ("type" in frame && frame.type === "execution_interrupted") {
        expect(job()).toMatchObject({ status: "cancelled", progress: 0 });
      }
    }
  });

  it(
    "keeps an interrupted job cancelled after the trailing executing null",
    async () => {
      const { sock, job } = await setupHook(ws.interrupted.prompt_id);
      for (const frame of ws.interrupted.frames) sock.emit(wire(frame));
      expect(job().status).toBe("cancelled");
    },
  );

  // BUG (useComfyWS): a prompt whose only output is text (PreviewAny) never
  // satisfies hasOutput, so the hook re-fetches history 8 more times
  // (~64 s of exponential backoff) and logs "No images found".
  it(
    "does not retry history for a finished text-only prompt",
    async () => {
      const textId = "7e47e7e4-0000-4000-8000-00000000007e";
      fetchHistory.mockImplementation(async () => ({
        prompt: [
          0,
          textId,
          { "3": { class_type: "PreviewAny", inputs: {} } },
          {},
          ["3"],
        ],
        outputs: { "3": { text: ["a caption"] } },
        status: { status_str: "success", completed: true, messages: [] },
        meta: { "3": { node_id: "3", display_node: "3" } },
      }));
      vi.useFakeTimers();
      const { sock } = await setupHook(textId);
      sock.emit(
        JSON.stringify({
          type: "execution_start",
          data: { prompt_id: textId },
        }),
      );
      sock.emit(
        JSON.stringify({
          type: "execution_success",
          data: { prompt_id: textId },
        }),
      );
      await vi.advanceTimersByTimeAsync(70_000);
      expect(historyFetches.length).toBeLessThanOrEqual(1);
    },
  );
});

// ---------------------------------------------------------------------------
// Double-socket mitigation: shared socket + history-poll fallback
// ---------------------------------------------------------------------------

describe("useComfyWS double-socket mitigation", () => {
  it("a second hook instance in the same tab reuses the socket", async () => {
    const { sock } = await setupHook(ws.success.prompt_id);
    const { useComfyWS } = await import("@/hooks/useComfyWS");
    useComfyWS();
    expect(FakeWebSocket.instances).toEqual([sock]);
  });

  it("polls history for a prompt that gets no WS events and finishes it", async () => {
    vi.useFakeTimers();
    // Still in ComfyUI's queue, so the connect-time reconcile leaves it be.
    comfyQueue = {
      queue_running: [[0, ws.success.prompt_id, {}, {}, []]],
      queue_pending: [],
    };
    const { sock, job } = await setupHook(ws.success.prompt_id);
    sock.open();
    // Events for this prompt went to another socket: nothing arrives.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(historyFetches).toEqual([]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(historyFetches).toContain(ws.success.prompt_id);
    expect(job().status).toBe("done");
    expect(job().images).toEqual([
      "/api/comfy/image?filename=cj_spectrum_fix_00001_.png&subfolder=&type=output",
    ]);
  });

  it("does not poll while WS events keep arriving for the prompt", async () => {
    vi.useFakeTimers();
    comfyQueue = {
      queue_running: [[0, ws.success.prompt_id, {}, {}, []]],
      queue_pending: [],
    };
    const { sock } = await setupHook(ws.success.prompt_id);
    sock.open();
    for (let i = 0; i < 8; i++) {
      sock.emit(
        JSON.stringify({
          type: "progress",
          data: { prompt_id: ws.success.prompt_id, value: i, max: 8 },
        }),
      );
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(historyFetches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Latent previews: feature_flags handshake + binary frames → livePreviews
// ---------------------------------------------------------------------------

describe("useComfyWS latent previews", () => {
  let livePreviews: typeof import("@/lib/comfy/livePreview").livePreviews;

  beforeEach(async () => {
    ({ livePreviews } = await import("@/lib/comfy/livePreview"));
    livePreviews.clearAll();
  });

  it("opts into preview metadata as the socket's first message", async () => {
    const { sock } = await setupHook(ws.success.prompt_id);
    expect(sock.binaryType).toBe("arraybuffer");
    sock.open();
    expect(JSON.parse(sock.sent[0])).toEqual({
      type: "feature_flags",
      data: { supports_preview_metadata: true },
    });
  });

  it("shows previews for the running job and revokes them once outputs load", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:preview-${created.length}`;
      created.push(url);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => {
      revoked.push(u);
    });
    const { sock, job } = await setupHook(ws.success.prompt_id);
    const seen: Array<string | undefined> = [];
    for (const frame of ws.success.frames) {
      sock.emit(wire(frame));
      if ("binary" in frame) seen.push(livePreviews.get(ws.success.prompt_id)?.url);
    }
    // Type 4 committed immediately; the legacy type-1 frame (no prompt id) is
    // attributed to the executing prompt but throttled behind it.
    expect(seen[0]).toBe("blob:preview-0");
    await vi.waitFor(() => expect(job().images).toHaveLength(1));
    expect(livePreviews.get(ws.success.prompt_id)).toBeUndefined();
    expect(new Set(revoked)).toEqual(new Set(created));
  });

  it("drops the preview when the prompt errors", async () => {
    const { sock } = await setupHook(ws.error.prompt_id);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const preview = ws.success.frames.find(
      (f): f is Extract<Frame, { binary: true }> => "binary" in f,
    )!;
    for (const frame of ws.error.frames) {
      if ("type" in frame && frame.type === "execution_error") {
        sock.emit(
          wire({
            ...preview,
            metadata: { ...preview.metadata, prompt_id: ws.error.prompt_id },
          }),
        );
        expect(livePreviews.get(ws.error.prompt_id)).toBeDefined();
      }
      sock.emit(wire(frame));
    }
    expect(livePreviews.get(ws.error.prompt_id)).toBeUndefined();
  });

  it("ignores previews for prompts this client is not tracking", async () => {
    const { sock } = await setupHook(ws.success.prompt_id);
    const preview = ws.success.frames.find(
      (f): f is Extract<Frame, { binary: true }> => "binary" in f,
    )!;
    sock.emit(
      wire({ ...preview, metadata: { ...preview.metadata, prompt_id: "other" } }),
    );
    expect(livePreviews.get("other")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reconciliation: pending jobs resolve from queue + history, never pulse
// forever (missed events, reload, restart, prompt deleted from the queue).
// ---------------------------------------------------------------------------

describe("useComfyWS reconcile (/api/comfy/prompt-status)", () => {
  it("a job that finished before the socket subscribed loads its outputs on connect", async () => {
    const { sock, job } = await setupHook(ws.success.prompt_id);
    sock.open(); // no events replayed: they were missed
    await vi.waitFor(() =>
      expect(job()).toMatchObject({ status: "done", progress: 100 }),
    );
    expect(job().images).toHaveLength(1);
  });

  it("marks a queued job running when ComfyUI reports it running", async () => {
    comfyQueue = {
      queue_running: [[0, ws.success.prompt_id, {}, {}, []]],
      queue_pending: [],
    };
    const { sock, job } = await setupHook(ws.success.prompt_id);
    sock.open();
    await vi.waitFor(() => expect(job().status).toBe("running"));
  });

  it("fails a prompt ComfyUI no longer knows only after repeated checks", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    const { store, sock, job } = await setupHook("gone-prompt");
    sock.open();
    await vi.waitFor(() =>
      expect(fetchHistory).toHaveBeenCalledWith("gone-prompt"),
    );
    expect(job().status).toBe("queued"); // first miss: not yet
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(6000);
    }
    await vi.waitFor(() => expect(job().status).toBe("error"));
    expect(job().error).toMatch(/^Lost: ComfyUI no longer has this job/);
    expect(store.getState().runs[0].status).toBe("error");
  });

  it("never fails a job while a backend queue is unreadable", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    comfyQueue = null;
    const { sock, job } = await setupHook("gone-prompt");
    sock.open();
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(6000);
    expect(job().status).toBe("queued");
  });

  it("a preview frame proves a queued job is running (missed execution_start)", async () => {
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:p");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    comfyQueue = {
      queue_running: [],
      queue_pending: [[0, ws.success.prompt_id, {}, {}, []]],
    };
    const { livePreviews } = await import("@/lib/comfy/livePreview");
    const { sock, job } = await setupHook(ws.success.prompt_id);
    const preview = ws.success.frames.find(
      (f): f is Extract<Frame, { binary: true }> => "binary" in f && f.event === 4,
    )!;
    sock.emit(wire(preview));
    expect(job().status).toBe("running");
    expect(livePreviews.get(ws.success.prompt_id)).toBeDefined();
    livePreviews.clear(ws.success.prompt_id);
  });
});

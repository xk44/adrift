#!/usr/bin/env node
/**
 * No-GPU crawl of the Tools hub: opens /tools, then every tool / app card's
 * runner via its `?tool=<key>` deep link, at desktop and phone widths, and
 * records what a judge clicking around would hit:
 *   - console.error / uncaught exceptions / browser log errors
 *   - React error fallbacks ("could not load") and the Next dev error overlay
 *   - failed fetches (network errors, HTTP >= 400 except the mock's 503s)
 *   - non-GET requests fired on load (blocked here, reported)
 *   - horizontal layout overflow (page scroll width + worst offenders)
 * It never clicks Run / Generate / Queue: runners open by URL, or with
 * --click by clicking the hub card and then "All tools" back. Every
 * POST/PUT/PATCH/DELETE is failed in the browser before it leaves.
 *
 *   node scripts/mock-comfy/crawl.mjs --base http://127.0.0.1:3100 \
 *     [--port 9300] [--widths 1440,390] [--only key1,key2] [--out report.json]
 *     [--wait 2500] [--shots DIR] [--click]
 *
 * Starts its own headless Brave/Chrome (private profile) on --port and shuts
 * it down. Exit code 1 when any card has findings.
 * Node >= 22 (global WebSocket); no dependencies.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const BASE = flag("--base", "http://127.0.0.1:3100").replace(/\/$/, "");
const PORT = Number(flag("--port", "9300"));
const WIDTHS = flag("--widths", "1440,390").split(",").map(Number);
const ONLY = flag("--only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = flag("--out", "");
const SHOTS = flag("--shots", "");
const SETTLE = Number(flag("--wait", "2500"));
// --click: open each card from the hub by clicking it, then "All tools" back
// (the path a judge takes), instead of a fresh ?tool= navigation per card.
const CLICK = args.includes("--click");
if (PORT === 9222 || PORT === 9223) {
  console.error("ports 9222/9223 are reserved");
  process.exit(2);
}
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  console.error("crawl.mjs only targets a local dev server");
  process.exit(2);
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const BROWSERS = [
  process.env.CRAWL_BROWSER,
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].filter(Boolean);
const BIN = BROWSERS.find((b) => existsSync(b));
if (!BIN) {
  console.error("no Chrome/Brave/Chromium found (set CRAWL_BROWSER)");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prof = mkdtempSync(join(tmpdir(), "crawl-prof-"));
const br = spawn(
  BIN,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--mute-audio",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${prof}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const shutdown = (code) => {
  try {
    br.kill("SIGTERM");
  } catch {}
  process.exit(code);
};
process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

let target;
for (let i = 0; i < 80 && !target; i++) {
  try {
    const list = await (
      await fetch(`http://127.0.0.1:${PORT}/json/list`)
    ).json();
    target = list.find((t) => t.type === "page");
  } catch {}
  if (!target) await sleep(250);
}
if (!target) {
  console.error("crawl: no CDP target");
  shutdown(4);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let seq = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method) {
    for (const l of listeners) l(m);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++seq;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return r.result?.result?.value;
};

// event capture
let bucket = null; // findings for the page currently loading
const requests = new Map(); // requestId -> {url, method}
const note = (kind, detail) => {
  if (!bucket) return;
  const key = `${kind}|${detail}`;
  if (bucket.seen.has(key)) return;
  bucket.seen.add(key);
  bucket.items.push({ kind, detail: String(detail).slice(0, 600) });
};
const IGNORE_CONSOLE = [
  /Download the React DevTools/i,
  /\[HMR\]/,
  /\[Fast Refresh\]/,
];
const argText = (a) =>
  a.value !== undefined
    ? typeof a.value === "string"
      ? a.value
      : JSON.stringify(a.value)
    : a.description || a.type;

listeners.push(async (m) => {
  const p = m.params || {};
  switch (m.method) {
    case "Runtime.consoleAPICalled": {
      if (p.type !== "error" && p.type !== "assert") return;
      const text = (p.args || []).map(argText).join(" ");
      if (IGNORE_CONSOLE.some((re) => re.test(text))) return;
      note("console.error", text);
      return;
    }
    case "Runtime.exceptionThrown": {
      const d = p.exceptionDetails || {};
      note(
        "exception",
        d.exception?.description || d.text || JSON.stringify(d).slice(0, 300),
      );
      return;
    }
    case "Log.entryAdded": {
      const e = p.entry || {};
      if (e.level !== "error") return;
      // Network failures are reported (better) by the Network handlers.
      if (e.source === "network") return;
      note("log.error", `${e.text} ${e.url || ""}`.trim());
      return;
    }
    case "Network.requestWillBeSent":
      requests.set(p.requestId, {
        url: p.request.url,
        method: p.request.method,
      });
      return;
    case "Network.responseReceived": {
      const { status, url } = p.response;
      if (status < 400) return;
      if (status === 503) return; // mock-comfy: unsupported method
      if (!url.startsWith(BASE) && !url.startsWith("http://127.0.0.1")) return;
      note(
        "http",
        `${status} ${requests.get(p.requestId)?.method || "GET"} ${url.replace(BASE, "")}`,
      );
      return;
    }
    case "Network.loadingFailed": {
      if (p.canceled) return; // aborted by navigation / AbortController
      const r = requests.get(p.requestId);
      if (!r) return;
      if (r.blocked) return;
      note(
        "fetch-failed",
        `${r.method} ${r.url.replace(BASE, "")} (${p.errorText})`,
      );
      return;
    }
    case "Fetch.requestPaused": {
      const method = p.request.method;
      if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
        await send("Fetch.continueRequest", { requestId: p.requestId });
        return;
      }
      note("mutation-on-load", `${method} ${p.request.url.replace(BASE, "")}`);
      if (p.networkId && requests.has(p.networkId))
        requests.get(p.networkId).blocked = true;
      await send("Fetch.failRequest", {
        requestId: p.requestId,
        errorReason: "BlockedByClient",
      });
      return;
    }
  }
});

await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable");
await send("Page.enable");
await send("Fetch.enable", {
  patterns: [{ urlPattern: "*", requestStage: "Request" }],
});

// page probes
const PROBE = `(() => {
  const out = { overlay: null, fallback: null, overflow: null, runner: false };
  const portal = document.querySelector("nextjs-portal");
  const sr = portal && portal.shadowRoot;
  if (sr) {
    const dialog = sr.querySelector("[data-nextjs-dialog], [data-nextjs-toast-errors-parent], [data-issues]");
    const t = (sr.textContent || "").replace(/\\s+/g, " ");
    if (dialog || /Unhandled Runtime Error|Runtime Error|Build Error/.test(t))
      out.overlay = t.slice(0, 400);
  }
  const body = document.body ? document.body.innerText : "";
  const fb = body.match(/(.{0,40}could not load|Something went wrong|This view hit an unexpected error)/);
  if (fb) out.fallback = fb[0];
  out.runner = !document.querySelector('[data-testid="tools-hub"]');
  const vw = document.documentElement.clientWidth;
  const sw = document.documentElement.scrollWidth;
  const clips = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) {
        const r = a.getBoundingClientRect();
        if (r.right <= vw + 1) return true;
      }
    }
    return false;
  };
  const describe = (el) => {
    const id = el.getAttribute("data-testid");
    if (id) return '[data-testid="' + id + '"]';
    const cls = (el.getAttribute("class") || "").split(/\\s+/).slice(0, 4).join(".");
    const txt = (el.innerText || "").trim().slice(0, 30).replace(/\\s+/g, " ");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "") + (txt ? ' "' + txt + '"' : "");
  };
  const bad = [];
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      const s = getComputedStyle(el);
      if (s.position === "fixed" && (s.visibility === "hidden" || s.opacity === "0")) continue;
      if (clips(el)) continue;
      bad.push({ el: describe(el), right: Math.round(r.right), left: Math.round(r.left), w: Math.round(r.width) });
    }
  }
  // Keep only outermost offenders (drop descendants of one already listed).
  if (sw > vw + 1 || bad.length) {
    out.overflow = { viewport: vw, scrollWidth: sw, offenders: bad.slice(0, 5) };
  }
  return out;
})()`;

/**
 * Load one page and probe it. `go` is a URL (fresh navigation) or an async
 * function that changes the view in place (click mode).
 */
async function visit(go, width, label) {
  bucket = { items: [], seen: new Set() };
  requests.clear();
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height: width < 600 ? 844 : 900,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  if (typeof go === "function") await go();
  else await send("Page.navigate", { url: go });
  // Wait for the app shell, then let lazy fetches settle.
  for (let i = 0; i < 80; i++) {
    const ready = await evaluate(
      `document.readyState === "complete" && !!document.querySelector("main")`,
    );
    if (ready) break;
    await sleep(250);
  }
  await sleep(SETTLE);
  const probe = (await evaluate(PROBE)) || {};
  if (probe.overlay) note("next-overlay", probe.overlay);
  if (probe.fallback) note("error-boundary", probe.fallback);
  if (probe.overflow) note("overflow", JSON.stringify(probe.overflow));
  if (SHOTS) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    if (shot.result?.data)
      writeFileSync(
        join(SHOTS, `${label}@${width}.png`.replace(/[^\w@.-]/g, "_")),
        Buffer.from(shot.result.data, "base64"),
      );
  }
  const items = bucket.items;
  bucket = null;
  return { items, runner: probe.runner };
}

async function collectKeys(width) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  await send("Page.navigate", { url: `${BASE}/tools` });
  let keys = [];
  for (let i = 0; i < 120; i++) {
    keys =
      (await evaluate(`[...document.querySelectorAll('[data-testid^="tool-card-"],[data-testid^="tool-featured-"]')]
        .map((e) => e.getAttribute("data-testid").replace(/^tool-(card|featured)-/, ""))`)) ||
      [];
    const loaded = await evaluate(
      `!!document.querySelector('[data-testid="tools-hub"]') && !document.querySelector('[data-testid="tools-hub"] .animate-pulse')`,
    );
    if (keys.length && loaded) break;
    await sleep(500);
  }
  const board = await evaluate(
    `!!document.querySelector('[data-testid="tools-open-board"]')`,
  );
  const uniq = [...new Set(keys)];
  if (board) uniq.push("__board__");
  return uniq;
}

// click mode (opens cards / goes back only; never Run)
async function clickOpen(key) {
  const sel = JSON.stringify(
    `[data-testid="tool-card-${key}"],[data-testid="tool-featured-${key}"]`,
  );
  for (let i = 0; i < 40; i++) {
    const ok = await evaluate(`(() => {
      if (${JSON.stringify(key)} === "special:board") {
        const b = document.querySelector('[data-testid="tools-open-board"]');
        if (b) { b.click(); return true; }
        return false;
      }
      const el = document.querySelector(${sel});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (ok) return;
    await sleep(250);
  }
}
async function clickBack() {
  await evaluate(`(() => {
    const b = [...document.querySelectorAll("button")].find((x) =>
      /^\\s*All tools\\s*$/.test(x.textContent || ""));
    if (b) b.click();
    return !!b;
  })()`);
}

// crawl
const report = { base: BASE, widths: WIDTHS, pages: [] };
let keys = await collectKeys(WIDTHS[0]);
// The Board runner has no card; it opens from a header button.
const boardKey = "special:board";
keys = keys.map((k) => (k === "__board__" ? boardKey : k)).filter(Boolean);
keys = [...new Set(keys)];
if (ONLY.length) keys = keys.filter((k) => ONLY.includes(k));
console.log(`crawl: ${keys.length} cards x ${WIDTHS.length} widths on ${BASE}`);

let bad = 0;
for (const width of WIDTHS) {
  const hub = await visit(`${BASE}/tools`, width, "hub");
  report.pages.push({ key: "(hub)", width, ...hub });
  if (hub.items.length) bad++;
  console.log(`${hub.items.length ? "FAIL" : "ok  "} hub @${width}`);
  for (const h of hub.items) console.log(`      ${h.kind}: ${h.detail}`);
  for (const key of keys) {
    const res = CLICK
      ? await visit(() => clickOpen(key), width, key)
      : await visit(
          `${BASE}/tools?tool=${encodeURIComponent(key)}`,
          width,
          key,
        );
    if (!res.runner)
      res.items.push({
        kind: "no-runner",
        detail: CLICK
          ? "clicking the card did not open a runner"
          : "deep link did not open a runner",
      });
    if (CLICK) {
      const back = await visit(clickBack, width, `${key}-back`);
      if (back.runner)
        back.items.push({ kind: "no-back", detail: "All tools did not return to the hub" });
      res.items.push(...back.items.map((b) => ({ ...b, kind: `back:${b.kind}` })));
      if (back.runner) await visit(`${BASE}/tools`, width, "hub-reset");
    }
    report.pages.push({ key, width, ...res });
    if (res.items.length) bad++;
    console.log(`${res.items.length ? "FAIL" : "ok  "} ${key} @${width}`);
    for (const h of res.items) console.log(`      ${h.kind}: ${h.detail}`);
  }
}
report.failing = bad;
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`crawl: ${bad} page(s) with findings of ${report.pages.length}`);
ws.close();
shutdown(bad ? 1 : 0);

/**
 * "Edit in ComfyUI" for saved user workflows (Workflows page).
 *
 * Overlay mode (Adrift inside ComfyUI's iframe): post cj:load-workflow with
 * the saved graph + its path, then cj:show-graph, both carrying the host
 * session nonce. Standalone: open the ComfyUI frontend in a new tab. The
 * frontend (comfyui_frontend_package 1.55) has no URL for opening a saved
 * user workflow (only ?template= for built-in templates), so the user picks
 * it from ComfyUI's Workflows sidebar.
 */

import {
  OVERLAY_MSG,
  buildCjMessage,
  type CjEnvelope,
} from "@/lib/overlay/protocol";
import { browserWsBase } from "@/lib/comfy/wsBaseOverride";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export interface PageLocation {
  protocol: string;
  hostname: string;
}

export interface ComfyFrontendUrlInput {
  /** Saved-connection ws base (getComfyWsBaseOverride), already browser-adjusted */
  wsOverride?: string | null;
  /** NEXT_PUBLIC_COMFY_WS_BASE */
  envWsBase?: string | null;
  /** Server's ComfyUI HTTP URL (comfy-connection httpUrl), used only as a fallback */
  httpUrl?: string | null;
  page: PageLocation;
}

function wsToHttp(ws: string): string {
  return ws.replace(/^ws(s?):\/\//i, "http$1://");
}

function withSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function httpWithPageHost(
  httpUrl: string,
  pageHostname: string,
): string | null {
  let u: URL;
  try {
    u = new URL(httpUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (LOOPBACK.has(u.hostname) && pageHostname && !LOOPBACK.has(pageHostname)) {
    u.hostname = pageHostname.includes(":")
      ? `[${pageHostname}]`
      : pageHostname;
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * Browser-reachable ComfyUI frontend URL, derived the same way the browser's
 * progress socket picks its host (saved override, then the public env base),
 * so it never hands out a server-only address. Null when only a relative WS
 * proxy path is configured and no server URL was supplied.
 */
export function comfyFrontendUrl(input: ComfyFrontendUrlInput): string | null {
  const { page } = input;
  if (input.wsOverride) return withSlash(wsToHttp(input.wsOverride));

  const env = input.envWsBase?.trim() ?? "";
  if (/^wss?:\/\//i.test(env)) {
    const ws = browserWsBase(env, page.hostname);
    if (ws) return withSlash(wsToHttp(ws));
  } else if (env && !env.startsWith("/")) {
    return withSlash(`${page.protocol}//${env.replace(/\/+$/, "")}`);
  }

  if (input.httpUrl) {
    const http = httpWithPageHost(input.httpUrl, page.hostname);
    if (http) return withSlash(http);
  }
  if (env.startsWith("/")) return null;
  return `${page.protocol}//${page.hostname}:8188/`;
}

/** cj:load-workflow (named, so ComfyUI opens the saved file's tab) + cj:show-graph. */
export function buildEditInComfyMessages(
  workflow: unknown,
  name: string,
  nonce: string,
): CjEnvelope[] {
  if (!nonce) throw new Error("No ComfyUI host session");
  return [
    buildCjMessage(OVERLAY_MSG.LOAD_WORKFLOW, { workflow, name }, nonce),
    buildShowGraphMessage(nonce),
  ];
}

export function buildShowGraphMessage(nonce: string): CjEnvelope {
  if (!nonce) throw new Error("No ComfyUI host session");
  return buildCjMessage(OVERLAY_MSG.SHOW_GRAPH, {}, nonce);
}

export function openedComfyToast(name: string): string {
  return `Opened ComfyUI — load ${name} from the Workflows sidebar`;
}

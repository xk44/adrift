"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useGenerationStore, useUIStore } from "@/store";
import { useModelStore } from "@/store/modelStore";
import { parseFirstRunStatus, type FirstRunStatus } from "@/lib/setup/firstRun";

/**
 * Shared first-run status (GET /api/setup/first-run) for the offline card
 * and the Create checklist: one fetch serves every subscriber, and while
 * ComfyUI is down it re-checks every POLL_MS so the UI clears by itself once
 * ComfyUI comes up. The route is admin-gated; without access it falls back
 * to the public /api/health so offline still shows.
 */

export interface FirstRunSnapshot {
  status: FirstRunStatus | null;
  loading: boolean;
  /** "auth": only reachability is known; "network": Adrift's server didn't answer. */
  error: "auth" | "network" | null;
  checkedAt: number;
}

export const FIRST_RUN_POLL_MS = 10_000;
const FRESH_MS = 3_000;

let snapshot: FirstRunSnapshot = {
  status: null,
  loading: false,
  error: null,
  checkedAt: 0,
};
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function emit(next: Partial<FirstRunSnapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;

async function healthOnly(): Promise<FirstRunStatus | null> {
  const res = await fetch("/api/health", { cache: "no-store" });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    comfyui?: string;
  } | null;
  if (!body) return null;
  return {
    ok: true,
    comfy: { reachable: body.comfyui === "connected", url: "" },
    comfyRoot: "",
    createModel: { state: "unknown", packId: "", packName: "", missing: [] },
  };
}

/** Re-check now (deduped while a check is in flight). */
export function refreshFirstRunStatus(
  opts: { model?: string | null; force?: boolean } = {},
): Promise<void> {
  if (inflight) return inflight;
  if (!opts.force && Date.now() - snapshot.checkedAt < FRESH_MS)
    return Promise.resolve();
  const wasReachable = snapshot.status?.comfy.reachable;
  emit({ loading: true });
  const query = opts.model ? `?model=${encodeURIComponent(opts.model)}` : "";
  inflight = (async () => {
    try {
      const res = await fetch(`/api/setup/first-run${query}`, {
        cache: "no-store",
      });
      let status: FirstRunStatus | null = null;
      let error: FirstRunSnapshot["error"] = null;
      if (res.status === 401 || res.status === 403) {
        status = await healthOnly();
        error = "auth";
      } else if (res.ok) {
        status = parseFirstRunStatus(await res.json().catch(() => null));
      }
      if (!status) {
        emit({ error: error ?? "network" });
      } else {
        emit({ status, error });
        // ComfyUI just came back: reconnect the socket now instead of
        // waiting out its backoff.
        if (wasReachable === false && status.comfy.reachable) {
          window.dispatchEvent(new Event("cj:ws-reconnect"));
        }
      }
    } catch {
      emit({ error: "network" });
    } finally {
      emit({ loading: false, checkedAt: Date.now() });
      inflight = null;
    }
  })();
  return inflight;
}

/** Test hook: reset the shared snapshot. */
export function __resetFirstRunStatus() {
  snapshot = { status: null, loading: false, error: null, checkedAt: 0 };
  inflight = null;
}

/**
 * True when ComfyUI is known to be down: the server probe says unreachable
 * and the socket isn't connected. Unknown (not checked yet) is not offline.
 */
export function isKnownOffline(
  snap: FirstRunSnapshot,
  wsConnected: boolean,
): boolean {
  return !wsConnected && snap.status?.comfy.reachable === false;
}

/**
 * The checkpoint Create would load, resolved like useImagine (settings.model,
 * else the Settings default; aliases resolved to the file). null when nothing
 * is picked or the engine brings its own models (any version but custom/v7):
 * its model names aren't checkpoint files, so checking them would misfire.
 */
export function createPickedModel(
  settings: { model?: string | null; modelVersion?: string },
  defaultModel: string | null,
  resolveAlias: (alias: string, type: "checkpoint") => string | null,
): string | null {
  const engineManaged =
    settings.modelVersion !== "custom" && settings.modelVersion !== "v7";
  if (engineManaged) return null;
  const raw = settings.model || defaultModel;
  return raw ? (resolveAlias(raw, "checkpoint") ?? raw) : null;
}

/** createPickedModel from the live stores (for one-off callers). */
export function currentPickedModel(): string | null {
  const m = useModelStore.getState();
  return createPickedModel(
    useUIStore.getState().settings,
    m.defaultModel,
    m.resolveAlias,
  );
}

export function useFirstRunStatus() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const wsConnected = useGenerationStore((s) => s.wsConnected);
  const settingsModel = useUIStore((s) => s.settings.model);
  const modelVersion = useUIStore((s) => s.settings.modelVersion);
  const defaultModel = useModelStore((s) => s.defaultModel);
  const resolveAlias = useModelStore((s) => s.resolveAlias);
  const pickedModel = createPickedModel(
    { model: settingsModel, modelVersion },
    defaultModel,
    resolveAlias,
  );
  const refresh = useCallback(
    () => refreshFirstRunStatus({ model: pickedModel, force: true }),
    [pickedModel],
  );

  // First check on mount, and again whenever the picked model changes.
  useEffect(() => {
    void refreshFirstRunStatus({ model: pickedModel, force: true });
  }, [pickedModel]);

  // The socket connected while we still think ComfyUI is down: re-check.
  useEffect(() => {
    if (wsConnected && getSnapshot().status?.comfy.reachable === false) {
      void refreshFirstRunStatus({ model: pickedModel, force: true });
    }
  }, [wsConnected, pickedModel]);

  const offline = isKnownOffline(snap, wsConnected);

  // While offline, keep checking so the card clears on its own.
  useEffect(() => {
    if (!offline) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void refreshFirstRunStatus({ model: pickedModel });
    }, FIRST_RUN_POLL_MS);
    return () => window.clearInterval(id);
  }, [offline, pickedModel]);

  return { ...snap, offline, wsConnected, refresh };
}

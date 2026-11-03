"use client";

/**
 * "Auto-route" under Settings > ComfyUI machines: pick the machine per job
 * (src/lib/comfy/router.ts), per-machine badges (online / queue / device /
 * nodes + model files seen), priorities and "always run X on Y" pins.
 *
 * Server: /api/settings/comfy-instances/routing.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { PIN_KEY_RE } from "@/lib/comfy/routingSettings";

export interface RoutingStatusRow {
  id: string;
  name: string;
  enabled: boolean;
  online: boolean;
  queue: { running: number; pending: number } | null;
  device: {
    type: string;
    name?: string;
    memoryGb: number;
    unified: boolean;
  } | null;
  nodes: number | null;
  models: number | null;
  infoAt: number | null;
  priority: number;
}

interface Routing {
  auto: boolean;
  pins: Record<string, string>;
  priorities: Record<string, number>;
}

const API = "/api/settings/comfy-instances/routing";
const HEADERS = {
  "Content-Type": "application/json",
  "X-Requested-With": "XMLHttpRequest",
};

async function call(
  method: string,
  body?: unknown,
): Promise<{
  ok: boolean;
  error?: string;
  routing?: Routing;
  status?: RoutingStatusRow[];
}> {
  try {
    const res = await fetch(API, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      routing?: Routing;
      status?: RoutingStatusRow[];
    };
    if (!res.ok || data.ok === false)
      return {
        ...data,
        ok: false,
        error: data.error ?? `Server answered HTTP ${res.status}`,
      };
    return { ...data, ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Adrift's server." };
  }
}

/** Badge texts for one machine ("CUDA 24 GB", "2 queued", ...). */
export function machineBadges(s: RoutingStatusRow): string[] {
  if (!s.enabled) return ["off"];
  if (!s.online) return ["offline"];
  const out = ["online"];
  if (s.queue) {
    const n = s.queue.running + s.queue.pending;
    out.push(n === 0 ? "idle" : `${n} queued`);
  }
  if (s.device)
    out.push(
      `${s.device.type.toUpperCase()}${s.device.memoryGb > 0 ? ` ${s.device.memoryGb} GB` : ""}${
        s.device.unified ? " shared" : ""
      }`,
    );
  if (s.nodes !== null) out.push(`${s.nodes} nodes`);
  if (s.models !== null) out.push(`${s.models} model files`);
  return out;
}

const badge =
  "rounded-md bg-[var(--bg-hover)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)] tabular-nums";
const btn =
  "inline-flex min-h-[28px] items-center gap-1.5 rounded-lg border border-[var(--border-secondary)] px-2 text-[11px] font-medium text-[var(--text-primary)] transition-[background-color,transform] duration-150 hover:bg-[var(--bg-hover)] active:scale-[0.96] disabled:opacity-40";
const field =
  "min-h-[28px] rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 text-[11px] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-splash disabled:opacity-50";

const PRIORITIES = [-10, -5, -2, -1, 0, 1, 2, 5, 10];

export function ComfyRoutingSettings() {
  const [routing, setRouting] = useState<Routing | null>(null);
  const [status, setStatus] = useState<RoutingStatusRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pinKey, setPinKey] = useState("");
  const [pinTarget, setPinTarget] = useState("");

  const load = useCallback(async (method: "GET" | "POST" = "GET") => {
    if (method === "POST") setBusy("refresh");
    const r = await call(method);
    setBusy(null);
    if (!r.ok) return setError(r.error ?? "Couldn't load routing.");
    if (r.routing) setRouting(r.routing);
    if (r.status) setStatus(r.status);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Partial<Routing>, key: string) => {
    setBusy(key);
    setError(null);
    const r = await call("PUT", patch);
    setBusy(null);
    if (!r.ok) return setError(r.error ?? "Couldn't save.");
    if (r.routing) setRouting(r.routing);
  };

  if (!routing)
    return error ? (
      <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
    ) : null;

  const key = pinKey.trim().toLowerCase();
  const pinValid = PIN_KEY_RE.test(key) && !!pinTarget;
  const nameOf = (id: string) => status.find((s) => s.id === id)?.name ?? id;

  return (
    <div className="space-y-2" data-testid="comfy-routing-settings">
      <label className="flex items-start gap-2 text-xs text-[var(--text-primary)]">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={routing.auto}
          disabled={!!busy}
          data-testid="auto-route-toggle"
          onChange={(e) => void save({ auto: e.target.checked }, "auto")}
        />
        <span>
          Auto-route
          <span className="block text-[10px] text-[var(--text-muted)]">
            Each job goes to a machine that has its nodes, model files and a
            device that can load them (no fp8 on Apple Silicon), then the
            highest priority and shortest queue. If that machine is down when
            the job is sent, the next one takes it.
          </span>
        </span>
      </label>

      <ul className="space-y-1.5">
        {status.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-center gap-1.5"
            data-testid={`routing-machine-${s.id}`}
          >
            <span className="min-w-[6rem] truncate text-[11px] font-medium text-[var(--text-primary)]">
              {s.name}
            </span>
            {machineBadges(s).map((b) => (
              <span key={b} className={badge}>
                {b}
              </span>
            ))}
            <label className="ml-auto flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
              Priority
              <select
                className={field}
                value={routing.priorities[s.id] ?? 0}
                disabled={!!busy}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  const next = { ...routing.priorities };
                  if (v === 0) delete next[s.id];
                  else next[s.id] = v;
                  void save({ priorities: next }, `prio-${s.id}`);
                }}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p > 0 ? `+${p}` : p}
                  </option>
                ))}
              </select>
            </label>
          </li>
        ))}
      </ul>

      <div className="space-y-1.5">
        <p className="text-[11px] text-[var(--text-primary)]">
          Always run on
          <span className="block text-[10px] text-[var(--text-muted)]">
            A tool id, action or pack name (e.g. upscale, vary, minimax) and the
            machine it always uses. Pinned jobs never move to another machine.
          </span>
        </p>
        {Object.entries(routing.pins).map(([k, target]) => (
          <div
            key={k}
            className="flex items-center gap-2 text-[11px]"
            data-testid={`pin-${k}`}
          >
            <span className="font-mono text-[var(--text-primary)]">{k}</span>
            <span className="text-[var(--text-muted)]">→ {nameOf(target)}</span>
            <button
              type="button"
              className={`${btn} ml-auto`}
              disabled={!!busy}
              aria-label={`Remove pin ${k}`}
              onClick={() => {
                const next = { ...routing.pins };
                delete next[k];
                void save({ pins: next }, `pin-${k}`);
              }}
            >
              <Trash2 className="h-3 w-3" aria-hidden />
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Tool, action or pack"
            className={`${field} w-36 font-mono`}
            placeholder="tool / action / pack"
            maxLength={64}
            value={pinKey}
            onChange={(e) => setPinKey(e.target.value)}
          />
          <select
            aria-label="Machine"
            className={field}
            value={pinTarget}
            onChange={(e) => setPinTarget(e.target.value)}
          >
            <option value="">Machine…</option>
            {status
              .filter((s) => s.enabled)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
          <button
            type="button"
            className={btn}
            disabled={!!busy || !pinValid}
            onClick={() => {
              void save(
                { pins: { ...routing.pins, [key]: pinTarget } },
                "pin-add",
              ).then(() => {
                setPinKey("");
                setPinTarget("");
              });
            }}
          >
            <Plus className="h-3 w-3" aria-hidden />
            Pin
          </button>
          <button
            type="button"
            className={`${btn} ml-auto`}
            disabled={!!busy}
            title="Re-read every machine's nodes and model files"
            onClick={() => void load("POST")}
          >
            {busy === "refresh" ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3 w-3" aria-hidden />
            )}
            Refresh
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

/**
 * "ComfyUI machines": connect more than one ComfyUI (another PC, a rented
 * GPU) and say what each is for. Used in Settings and, compact, in the setup
 * wizard's "Add another machine".
 *
 * Server: /api/settings/comfy-instances (src/lib/comfy/instancesSettings.ts).
 * Tokens never come back from the server; a row only knows `hasToken`.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useOnboardingStore } from "@/store/onboardingStore";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { ComfyRoutingSettings } from "@/components/settings/ComfyRoutingSettings";

type Role = "all" | "image" | "video";

export interface InstanceRow {
  id: string;
  name: string;
  url: string;
  role: Role;
  enabled: boolean;
  primary: boolean;
  source: "env" | "saved" | "default";
  editable: boolean;
  hasToken: boolean;
  marker: string | null;
}

export interface InstanceStatus {
  reachable: boolean;
  comfyuiVersion?: string | null;
  gpuName?: string;
  memoryGb?: number;
  unified?: boolean;
  queue?: { running: number; pending: number } | null;
  error?: string;
}

interface View {
  max: number;
  instances: InstanceRow[];
  exclusive: {
    enabled: boolean;
    source: "env" | "saved" | "default";
    saved: boolean | null;
  };
}

const API = "/api/settings/comfy-instances";
const HEADERS = {
  "Content-Type": "application/json",
  "X-Requested-With": "XMLHttpRequest",
};

export const ROLE_LABELS: Record<Role, string> = {
  all: "Everything",
  image: "Images",
  video: "Video",
};

async function call<T>(
  method: string,
  path = API,
  body?: unknown,
): Promise<T & { ok: boolean; error?: string }> {
  try {
    const res = await fetch(path, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || data.ok === false)
      return {
        ...data,
        ok: false,
        error: data.error ?? `Server answered HTTP ${res.status}`,
      };
    return { ...data, ok: true };
  } catch {
    return { ok: false, error: "Couldn't reach Adrift's server." } as T & {
      ok: boolean;
      error?: string;
    };
  }
}

/** The PUT body for a list of rows (saved machines only; tokens untouched). */
export function putBody(
  rows: InstanceRow[],
  extra?: { url: string; name: string; role: Role; token?: string },
) {
  const main = rows.find((r) => r.primary);
  const saved = rows
    .filter((r) => r.editable)
    .map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      role: r.role,
      enabled: r.enabled,
    }));
  return {
    ...(main ? { main: { name: main.name, role: main.role } } : {}),
    instances: extra
      ? [
          ...saved,
          {
            name: extra.name,
            url: extra.url,
            role: extra.role,
            enabled: true,
            ...(extra.token ? { token: extra.token } : {}),
          },
        ]
      : saved,
  };
}

/** One-line plain-language status ("RTX 4090 · 24 GB · 2 waiting"). */
export function statusLine(s: InstanceStatus | undefined): string {
  if (!s) return "Checking…";
  if (!s.reachable) return s.error ?? "Not answering";
  const parts: string[] = [];
  if (s.gpuName) parts.push(s.gpuName);
  if (typeof s.memoryGb === "number" && s.memoryGb > 0)
    parts.push(`${Math.round(s.memoryGb)} GB${s.unified ? " shared" : ""}`);
  if (s.queue) {
    const n = s.queue.running + s.queue.pending;
    parts.push(n === 0 ? "idle" : `${n} job${n === 1 ? "" : "s"} queued`);
  }
  if (s.comfyuiVersion) parts.push(`ComfyUI ${s.comfyuiVersion}`);
  return parts.join(" · ") || "Connected";
}

const input =
  "min-h-[32px] w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-splash disabled:opacity-50";
const select =
  "min-h-[32px] rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-splash disabled:opacity-50";
const btn =
  "inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-[var(--border-secondary)] px-2.5 text-xs font-medium text-[var(--text-primary)] transition-[background-color,transform] duration-150 hover:bg-[var(--bg-hover)] active:scale-[0.96] disabled:opacity-40";

function Dot({ row, s }: { row: InstanceRow; s?: InstanceStatus }) {
  const cls = !row.enabled
    ? "bg-gray-400"
    : !s
      ? "bg-gray-300 dark:bg-gray-600"
      : s.reachable
        ? "bg-emerald-500"
        : "bg-red-500";
  const label = !row.enabled
    ? "Turned off"
    : !s
      ? "Checking"
      : s.reachable
        ? "Connected"
        : "Not answering";
  return (
    <span
      className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${cls}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

export function ComfyInstancesSettings({
  compact = false,
}: {
  /** Wizard mode: no exclusive switch, shorter copy. */
  compact?: boolean;
}) {
  const [view, setView] = useState<View | null>(null);
  const [status, setStatus] = useState<Record<string, InstanceStatus>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    url: "",
    role: "all" as Role,
    token: "",
  });
  const [draftStatus, setDraftStatus] = useState<InstanceStatus | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const probe = useCallback(async () => {
    const r = await call<View & { status?: Record<string, InstanceStatus> }>(
      "GET",
      `${API}?probe=1`,
    );
    if (r.ok) {
      setView(r);
      setStatus(r.status ?? {});
    }
  }, []);

  const load = useCallback(async () => {
    const r = await call<View>("GET");
    if (!r.ok) return setError(r.error ?? "Couldn't load the machines.");
    setView(r);
    void probe();
  }, [probe]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (body: unknown, key: string): Promise<boolean> => {
    setBusy(key);
    setError(null);
    setWarning(null);
    const r = await call<View & { warnings?: string[] }>("PUT", API, body);
    setBusy(null);
    if (!r.ok) {
      setError(r.error ?? "Couldn't save.");
      return false;
    }
    setView(r);
    if (r.warnings?.length) setWarning(r.warnings.join(" "));
    void probe();
    return true;
  };

  const updateRow = (id: string, patch: Partial<InstanceRow>) => {
    if (!view) return;
    const rows = view.instances.map((r) =>
      r.id === id ? { ...r, ...patch } : r,
    );
    void save(putBody(rows), id);
  };

  const remove = async (row: InstanceRow) => {
    if (!view) return;
    const ok = await confirm({
      title: `Remove ${row.name}?`,
      message:
        "Adrift stops sending jobs there. Pictures and videos it already made stay on that machine and won't show here anymore.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    void save(
      putBody(view.instances.filter((r) => r.id !== row.id)),
      `rm-${row.id}`,
    );
  };

  const testDraft = async () => {
    setBusy("test");
    setDraftStatus(null);
    setError(null);
    const r = await call<{ result?: InstanceStatus; normalizedUrl?: string }>(
      "POST",
      `${API}/test`,
      { url: draft.url, token: draft.token || undefined },
    );
    setBusy(null);
    if (!r.ok) return setError(r.error ?? "Couldn't test that address.");
    if (r.normalizedUrl) setDraft((d) => ({ ...d, url: r.normalizedUrl! }));
    setDraftStatus(r.result ?? null);
  };

  const testRow = async (row: InstanceRow) => {
    setBusy(`test-${row.id}`);
    const r = await call<{ result?: InstanceStatus }>("POST", `${API}/test`, {
      url: row.url,
      id: row.id,
    });
    setBusy(null);
    if (r.ok && r.result) setStatus((s) => ({ ...s, [row.id]: r.result! }));
    else setError(r.error ?? "Couldn't test that machine.");
  };

  const addDraft = async () => {
    if (!view) return;
    const ok = await save(
      putBody(view.instances, {
        name: draft.name.trim() || `Machine ${view.instances.length + 1}`,
        url: draft.url,
        role: draft.role,
        token: draft.token.trim() || undefined,
      }),
      "add",
    );
    if (ok) {
      setAdding(false);
      setDraft({ name: "", url: "", role: "all", token: "" });
      setDraftStatus(null);
    }
  };

  if (!view)
    return (
      <p className="text-xs text-[var(--text-muted)]">{error ?? "Loading…"}</p>
    );

  const full = view.instances.length >= view.max;
  const enabledCount = view.instances.filter((r) => r.enabled).length;

  return (
    <div className="space-y-3" data-testid="comfy-instances-settings">
      {confirmDialog}
      {!compact && (
        <p className="text-[11px] text-pretty text-[var(--text-muted)]">
          Connect more than one computer running ComfyUI. Each job goes to the
          least busy machine that&apos;s set up for it; video tools prefer
          machines set to &ldquo;Video&rdquo;.
        </p>
      )}

      <ul className="space-y-2">
        {view.instances.map((row) => {
          const s = status[row.id];
          const locked = !row.editable;
          return (
            <li
              key={row.id}
              className="space-y-2 rounded-xl border border-[var(--border-secondary)] p-2.5"
              data-testid={`comfy-instance-${row.id}`}
            >
              <div className="flex items-center gap-2">
                <Dot row={row} s={s} />
                <input
                  aria-label="Name"
                  className={`${input} max-w-[12rem] font-medium`}
                  defaultValue={row.name}
                  disabled={row.source === "env" && !row.primary}
                  maxLength={48}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name && name !== row.name) updateRow(row.id, { name });
                  }}
                />
                {row.primary && (
                  <span className="rounded-md bg-[var(--bg-hover)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-muted)]">
                    Main
                  </span>
                )}
                {row.source === "env" && (
                  <span
                    className="text-[10px] text-[var(--text-muted)]"
                    title="Set in .env.local, which always wins"
                  >
                    from .env.local
                  </span>
                )}
                <span className="ml-auto" />
                {row.editable && (
                  <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-primary)]">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      disabled={!!busy}
                      onChange={(e) =>
                        updateRow(row.id, { enabled: e.target.checked })
                      }
                    />
                    On
                  </label>
                )}
              </div>
              <p className="break-all font-mono text-[11px] text-[var(--text-muted)]">
                {row.url}
                {row.hasToken ? "  (token saved)" : ""}
              </p>
              <p className="text-[11px] text-[var(--text-primary)]">
                {row.enabled
                  ? statusLine(s)
                  : "Turned off: no new jobs go here."}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-primary)]">
                  Use for
                  <select
                    className={select}
                    value={row.role}
                    disabled={!!busy || (row.source === "env" && !row.primary)}
                    onChange={(e) =>
                      updateRow(row.id, { role: e.target.value as Role })
                    }
                  >
                    {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={btn}
                  disabled={!!busy}
                  onClick={() => void testRow(row)}
                >
                  {busy === `test-${row.id}` ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  )}
                  Test
                </button>
                {/* The main address is set in the connect step; without
                    this the row had no way to change it. */}
                {row.primary && row.source !== "env" && !compact && (
                  <button
                    type="button"
                    className={btn}
                    disabled={!!busy}
                    data-testid="change-main-address"
                    onClick={() =>
                      useOnboardingStore.getState().openOnboarding("connect")
                    }
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                    Change address
                  </button>
                )}
                {!locked && (
                  <button
                    type="button"
                    className={btn}
                    disabled={!!busy}
                    onClick={() => void remove(row)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Remove
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className="space-y-2 rounded-xl border border-dashed border-[var(--border-secondary)] p-2.5">
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              aria-label="Name"
              className={input}
              placeholder="Name (e.g. Gaming PC)"
              maxLength={48}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <input
              aria-label="Address"
              className={input}
              placeholder="Address (e.g. gpu-box.local:8188)"
              value={draft.url}
              onChange={(e) => {
                setDraft({ ...draft, url: e.target.value });
                setDraftStatus(null);
              }}
            />
            <input
              aria-label="Token (optional)"
              className={input}
              type="password"
              autoComplete="off"
              placeholder="Token (only if it asks for one)"
              value={draft.token}
              onChange={(e) => setDraft({ ...draft, token: e.target.value })}
            />
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-primary)]">
              Use for
              <select
                className={select}
                value={draft.role}
                onChange={(e) =>
                  setDraft({ ...draft, role: e.target.value as Role })
                }
              >
                {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {draftStatus && (
            <p
              className={`text-[11px] ${draftStatus.reachable ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
            >
              {statusLine(draftStatus)}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={btn}
              disabled={!!busy || !draft.url.trim()}
              onClick={() => void testDraft()}
            >
              {busy === "test" && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              )}
              Test
            </button>
            <button
              type="button"
              className={btn}
              disabled={!!busy || !draft.url.trim()}
              onClick={() => void addDraft()}
            >
              {busy === "add" && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              )}
              Add
            </button>
            <button
              type="button"
              className={btn}
              disabled={!!busy}
              onClick={() => {
                setAdding(false);
                setDraftStatus(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={btn}
          disabled={full || !!busy}
          onClick={() => setAdding(true)}
          title={full ? `Up to ${view.max} machines` : undefined}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add another machine
        </button>
      )}

      {!compact && enabledCount > 1 && (
        <label className="flex items-start gap-2 text-xs text-[var(--text-primary)]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={view.exclusive.enabled}
            disabled={!!busy || view.exclusive.source === "env"}
            onChange={(e) =>
              void save({ exclusive: e.target.checked }, "exclusive")
            }
          />
          <span>
            One job at a time across machines
            <span className="block text-[10px] text-[var(--text-muted)]">
              {view.exclusive.source === "env"
                ? "Set by COMFY_EXCLUSIVE_BACKENDS in .env.local."
                : "Turn on when the machines share one power circuit: a job waits until the others are idle."}
            </span>
          </span>
        </label>
      )}

      {!compact && view.instances.length > 1 && <ComfyRoutingSettings />}

      {error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {warning && (
        <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
          {warning}
        </p>
      )}
    </div>
  );
}

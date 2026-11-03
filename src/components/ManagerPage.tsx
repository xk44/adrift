"use client";

import {
  AlertTriangle,
  Check,
  Download,
  Package,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ManagerModel, ManagerNodePack } from "@/lib/comfy/manager";
import { showToast } from "@/components/Toast";
import { StateView } from "@/components/ui/StateView";
import { friendlyManagerError } from "@/lib/ui/serviceErrors";
import { openModelDownloads } from "@/lib/setupNav";
import {
  MANAGER_TEMPLATES,
  type ManagerTemplate,
} from "@/lib/comfy/managerTemplates";

/** Which list Setup shows: node packs, pack bundles, or the model catalog. */
export type ManagerView = "packs" | "models" | "templates";
type PackFilter = "all" | "installed" | "available";

const RENDER_CAP = 120;

interface InstallResult {
  queued: string[];
  failed: Array<{ id: string; error: string }>;
  blocked: Array<{ slug: string; rules: string[] }>;
}

async function installPacks(packIds: string[]): Promise<InstallResult> {
  const res = await fetch("/api/comfy/manager/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packIds }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return {
    queued: data.queued ?? [],
    failed: data.failed ?? [],
    blocked: data.blocked ?? [],
  };
}

function StateBadge({ state }: { state: string }) {
  if (state === "enabled") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-500">
        <Check className="h-3 w-3" /> Installed
      </span>
    );
  }
  if (state === "disabled") {
    return (
      <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-tertiary)]">
        Disabled
      </span>
    );
  }
  if (state === "import-failed") {
    return (
      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-500">
        Import failed
      </span>
    );
  }
  return null;
}

function PackRow({
  pack,
  onInstall,
  installing,
  justQueued,
}: {
  pack: ManagerNodePack;
  onInstall: (pack: ManagerNodePack) => void;
  installing: boolean;
  justQueued: boolean;
}) {
  const installed = pack.state === "enabled" || pack.state === "disabled";
  return (
    <div className="card flex items-start gap-3 p-3">
      <Package className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-[var(--text-primary)]">
            {pack.title}
          </span>
          {pack.author && (
            <span className="text-xs text-[var(--text-tertiary)]">
              by {pack.author}
            </span>
          )}
          <StateBadge state={pack.state} />
          {pack.blocked && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-500"
              title={`Supply-chain blocklist: ${(pack.blockRules ?? []).join(", ") || "flagged"}`}
            >
              <ShieldAlert className="h-3 w-3" /> Blocked
            </span>
          )}
        </div>
        {pack.description && (
          <p className="mt-1 line-clamp-2 text-sm text-[var(--text-secondary)]">
            {pack.description}
          </p>
        )}
        {pack.blocked && (
          <p className="mt-1 text-xs text-red-400">
            Flagged by the 2026-07 supply-chain sweep (
            {(pack.blockRules ?? []).join(", ") || "suspicious"}). Install is
            refused until a human re-audits and clears it.
          </p>
        )}
      </div>
      <div className="shrink-0">
        {installed ? (
          <span className="text-xs text-[var(--text-tertiary)]">✓</span>
        ) : pack.blocked ? (
          <button
            aria-label="Blocked: this pack is on the unsafe list"
            className="btn btn-ghost cursor-not-allowed opacity-40"
            disabled
          >
            <ShieldAlert className="h-4 w-4" />
          </button>
        ) : justQueued ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-500">
            <Check className="h-3.5 w-3.5" /> Queued
          </span>
        ) : (
          <button
            aria-label={installing ? "Installing…" : `Install ${pack.title}`}
            className="btn btn-secondary"
            onClick={() => onInstall(pack)}
            disabled={installing}
          >
            {installing ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function ErrorDetails({ detail }: { detail: string | null }) {
  if (!detail) return null;
  return (
    <details className="mt-1 text-xs opacity-80">
      <summary className="cursor-pointer select-none">Technical details</summary>
      <code className="mt-1 block break-all font-mono">{detail}</code>
    </details>
  );
}

/**
 * ComfyUI-Manager lists inside Setup: Node packs › Node packs / Bundles and
 * Models › Catalog. Setup owns the page title and tabs; this renders one
 * view's toolbar and list.
 */
export function ManagerPage({ view = "packs" }: { view?: ManagerView }) {
  const tab = view;
  const [packs, setPacks] = useState<ManagerNodePack[]>([]);
  const [models, setModels] = useState<ManagerModel[]>([]);
  // Packs and models load independently (tab switches can overlap them), so
  // each keeps its own spinner/error.
  const [loadingKind, setLoadingKind] = useState({ packs: false, models: false });
  const [errorKind, setErrorKind] = useState<{
    packs: string | null;
    models: string | null;
  }>({ packs: null, models: null });
  const inflight = useRef({ packs: false, models: false });
  const kind = tab === "models" ? "models" : "packs";
  const loading = loadingKind[kind];
  const error = errorKind[kind];
  const friendlyError = error ? friendlyManagerError(error) : null;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PackFilter>("all");
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [blocklistSize, setBlocklistSize] = useState(0);
  const [blockedInCatalog, setBlockedInCatalog] = useState(0);

  const loadPacks = useCallback(async () => {
    if (inflight.current.packs) return;
    inflight.current.packs = true;
    setLoadingKind((s) => ({ ...s, packs: true }));
    setErrorKind((s) => ({ ...s, packs: null }));
    try {
      const res = await fetch("/api/comfy/manager/packs", {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || !data.ok)
        throw new Error(data.error || `HTTP ${res.status}`);
      setPacks(data.packs ?? []);
      setBlocklistSize(data.blocklistSize ?? 0);
      setBlockedInCatalog(data.blockedInCatalog ?? 0);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load node packs";
      setErrorKind((s) => ({ ...s, packs: message }));
    } finally {
      inflight.current.packs = false;
      setLoadingKind((s) => ({ ...s, packs: false }));
    }
  }, []);

  const loadModels = useCallback(async () => {
    if (inflight.current.models) return;
    inflight.current.models = true;
    setLoadingKind((s) => ({ ...s, models: true }));
    setErrorKind((s) => ({ ...s, models: null }));
    try {
      const res = await fetch("/api/comfy/manager/models", {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok || !data.ok)
        throw new Error(data.error || `HTTP ${res.status}`);
      setModels(data.models ?? []);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load models";
      setErrorKind((s) => ({ ...s, models: message }));
    } finally {
      inflight.current.models = false;
      setLoadingKind((s) => ({ ...s, models: false }));
    }
  }, []);

  useEffect(() => {
    if (tab === "packs" && packs.length === 0) void loadPacks();
    if (tab === "models" && models.length === 0) void loadModels();
    if (tab === "templates" && packs.length === 0) void loadPacks();
  }, [tab, packs.length, models.length, loadPacks, loadModels]);

  const flash = useCallback(
    (msg: string, type: "success" | "error" | "info" = "info") =>
      showToast(msg, type),
    [],
  );
  const retry = kind === "models" ? loadModels : loadPacks;

  const handleInstall = useCallback(
    async (ids: string[], label: string) => {
      setInstalling((prev) => new Set([...prev, ...ids]));
      try {
        const result = await installPacks(ids);
        if (result.queued.length) {
          setQueued((prev) => new Set([...prev, ...result.queued]));
        }
        const parts: string[] = [];
        if (result.queued.length) parts.push(`${result.queued.length} queued`);
        if (result.blocked.length)
          parts.push(
            `${result.blocked.length} blocked (${result.blocked.map((b) => b.slug).join(", ")})`,
          );
        if (result.failed.length) parts.push(`${result.failed.length} failed`);
        flash(`${label}: ${parts.join(" · ") || "nothing to do"}`);
      } catch (err) {
        flash(
          `${label} failed: ${err instanceof Error ? err.message : "error"}`,
          "error",
        );
      } finally {
        setInstalling((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.delete(id);
          return next;
        });
      }
    },
    [flash],
  );

  const filteredPacks = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = packs;
    if (filter === "installed")
      list = list.filter(
        (p) => p.state === "enabled" || p.state === "disabled",
      );
    else if (filter === "available")
      list = list.filter((p) => p.state === "not-installed");
    if (q) {
      list = list.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.author.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q),
      );
    }
    // installed + blocked float to top so state is obvious, then by title
    return [...list].sort((a, b) => {
      const rank = (p: ManagerNodePack) =>
        p.blocked ? 0 : p.state === "enabled" ? 1 : 2;
      return rank(a) - rank(b) || a.title.localeCompare(b.title);
    });
  }, [packs, query, filter]);

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.base.toLowerCase().includes(q) ||
        m.type.toLowerCase().includes(q),
    );
  }, [models, query]);

  const shownPacks = filteredPacks.slice(0, RENDER_CAP);
  const shownModels = filteredModels.slice(0, RENDER_CAP);

  return (
    <div className="flex w-full flex-col gap-4">
      {/* Toolbar: blocklist chip + refresh (Setup shows the page title) */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {tab !== "models" && (
          <span
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium ${
              blocklistSize > 0
                ? "border-red-500/30 bg-red-500/10 text-red-400"
                : "border-[var(--border-primary)] text-[var(--text-tertiary)]"
            }`}
            title="Packs flagged by the supply-chain sweep are refused at install."
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            {blocklistSize} blocked
          </span>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => (tab === "models" ? loadModels() : loadPacks())}
          disabled={loading}
          title="Refresh catalog"
          aria-label="Refresh catalog"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Banner only when there's still something on screen; an empty list
          shows the same error once, in the StateView below. */}
      {friendlyError &&
        (tab === "templates" ||
          (kind === "models" ? models : packs).length > 0) && (
          <div
            role="alert"
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-500"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span className="min-w-0">{friendlyError.summary}</span>
              <button
                type="button"
                className="ml-auto shrink-0 text-xs font-medium underline-offset-2 hover:underline"
                onClick={() => void retry()}
              >
                Try again
              </button>
            </div>
            <ErrorDetails detail={friendlyError.detail} />
          </div>
        )}

      {/* Search + filter (packs/models) */}
      {tab !== "templates" && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-tertiary)]" />
            <input
              aria-label="Search"
              className="input w-full pl-9"
              placeholder={
                tab === "packs" ? "Search node packs…" : "Search models…"
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {tab === "packs" &&
            (["all", "installed", "available"] as const).map((f) => (
              <button
                key={f}
                className={`btn ${filter === f ? "btn-secondary" : "btn-ghost"}`}
                onClick={() => setFilter(f)}
              >
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
        </div>
      )}

      <div>
        {loading && (kind === "models" ? models : packs).length === 0 ? (
          <div className="flex h-32 items-center justify-center text-[var(--text-tertiary)]">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Loading catalog…
          </div>
        ) : error &&
          tab !== "templates" &&
          (kind === "models" ? models : packs).length === 0 ? (
          <div>
            <StateView
              status="error"
              title={
                kind === "models"
                  ? "Couldn't load the model list"
                  : "Couldn't load node packs"
              }
              message={friendlyError?.summary}
              onRetry={() => void retry()}
            />
            <div className="flex justify-center px-6 text-[var(--text-tertiary)]">
              <ErrorDetails detail={friendlyError?.detail ?? null} />
            </div>
          </div>
        ) : tab === "packs" ? (
          <div className="flex flex-col gap-2">
            <div className="px-1 text-xs text-[var(--text-tertiary)]">
              {filteredPacks.length} match
              {filteredPacks.length === 1 ? "" : "es"}
              {filteredPacks.length > RENDER_CAP &&
                ` · showing first ${RENDER_CAP}, refine search`}
              {blockedInCatalog > 0 &&
                ` · ${blockedInCatalog} blocked in catalog`}
            </div>
            {shownPacks.map((p) => (
              <PackRow
                key={p.id}
                pack={p}
                installing={installing.has(p.reference) || installing.has(p.id)}
                justQueued={queued.has(p.reference) || queued.has(p.id)}
                onInstall={(pack) =>
                  handleInstall([pack.reference || pack.id], pack.title)
                }
              />
            ))}
          </div>
        ) : tab === "models" ? (
          <div className="flex flex-col gap-2">
            <div className="px-1 text-xs text-[var(--text-tertiary)]">
              {filteredModels.length} match
              {filteredModels.length === 1 ? "" : "es"}
              {filteredModels.length > RENDER_CAP &&
                ` · showing first ${RENDER_CAP}`}
            </div>
            {shownModels.map((m, i) => (
              <div
                key={`${m.name}-${i}`}
                className="card flex items-start gap-3 p-3"
              >
                <Download className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-tertiary)]" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium text-[var(--text-primary)]">
                      {m.name}
                    </span>
                    {m.base && (
                      <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] text-[var(--text-tertiary)]">
                        {m.base}
                      </span>
                    )}
                    {m.type && (
                      <span className="text-xs text-[var(--text-tertiary)]">
                        {m.type}
                      </span>
                    )}
                    {m.installed && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-500">
                        <Check className="h-3 w-3" /> Installed
                      </span>
                    )}
                  </div>
                  {m.description && (
                    <p className="mt-1 line-clamp-2 text-sm text-[var(--text-secondary)]">
                      {m.description}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                    {m.savePath}
                    {m.size ? ` · ${m.size}` : ""}
                  </p>
                </div>
              </div>
            ))}
            <p className="px-1 py-2 text-xs text-[var(--text-tertiary)]">
              This list is for browsing. To download a model, use{" "}
              <button
                type="button"
                className="font-medium text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)]"
                onClick={() => openModelDownloads()}
              >
                Models › Download
              </button>
              , where progress shows and you can cancel.
            </p>
          </div>
        ) : (
          <TemplatesTab
            packs={packs}
            installing={installing}
            queued={queued}
            onInstall={handleInstall}
          />
        )}
      </div>

    </div>
  );
}

function TemplatesTab({
  packs,
  installing,
  queued,
  onInstall,
}: {
  packs: ManagerNodePack[];
  installing: Set<string>;
  queued: Set<string>;
  onInstall: (ids: string[], label: string) => void;
}) {
  // Map template pack ids to catalog state where possible.
  const stateOf = useCallback(
    (packId: string): ManagerNodePack | undefined =>
      packs.find(
        (p) =>
          p.id.toLowerCase() === packId.toLowerCase() || p.reference === packId,
      ),
    [packs],
  );

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {MANAGER_TEMPLATES.map((tpl: ManagerTemplate) => {
        const resolved = tpl.packs.map((id) => ({ id, pack: stateOf(id) }));
        const allInstalled = resolved.every(
          (r) =>
            r.pack &&
            (r.pack.state === "enabled" || r.pack.state === "disabled"),
        );
        const anyBlocked = resolved.some((r) => r.pack?.blocked);
        const busy = tpl.packs.some((id) => installing.has(id));
        const done = tpl.packs.every((id) => queued.has(id));
        return (
          <div key={tpl.id} className="card flex flex-col gap-3 p-4">
            <div>
              <h3 className="flex items-center gap-2 font-semibold text-[var(--text-primary)]">
                <Sparkles className="h-4 w-4 text-[var(--accent-primary)]" />{" "}
                {tpl.name}
              </h3>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">
                {tpl.description}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {resolved.map((r) => (
                <span
                  key={r.id}
                  className={`rounded-full px-2 py-0.5 text-[11px] ${
                    r.pack?.blocked
                      ? "bg-red-500/15 text-red-500"
                      : r.pack &&
                          (r.pack.state === "enabled" ||
                            r.pack.state === "disabled")
                        ? "bg-emerald-500/15 text-emerald-500"
                        : "bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]"
                  }`}
                  title={r.pack?.blocked ? "Blocklisted" : undefined}
                >
                  {r.id}
                </span>
              ))}
            </div>
            <p className="text-xs text-[var(--text-tertiary)]">{tpl.unlocks}</p>
            <div className="mt-auto">
              {anyBlocked ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-red-500">
                  <ShieldAlert className="h-3.5 w-3.5" /> Contains a blocked
                  pack
                </span>
              ) : allInstalled ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-500">
                  <Check className="h-3.5 w-3.5" /> All installed
                </span>
              ) : done ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-500">
                  <Check className="h-3.5 w-3.5" /> Queued
                </span>
              ) : (
                <button
                  aria-label={busy ? "Setting up…" : undefined}
                  className="btn btn-primary w-full"
                  disabled={busy}
                  onClick={() => onInstall(tpl.packs, tpl.name)}
                >
                  {busy ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Download className="h-4 w-4" /> Set up
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

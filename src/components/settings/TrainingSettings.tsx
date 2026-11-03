"use client";

/**
 * Settings → Training: where the local LoRA trainers (musubi-tuner,
 * ai-toolkit) are cloned, which Python runs them, and the model files they
 * train against. Adrift only generates configs and runs the trainer's own
 * scripts; the repos are installed by hand from the snippet shown here.
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, Search } from "lucide-react";
import { showToast } from "@/components/Toast";

type BackendId = "musubi-tuner" | "ai-toolkit";

interface FamilyStatus {
  family: string;
  status: "validated" | "untested" | "unsupported";
  note: string | null;
  ready: boolean;
}

interface BackendStatus {
  id: BackendId;
  repoUrl: string;
  repoPath: string | null;
  pythonBin: string | null;
  problems: string[];
  setup: string;
  families: FamilyStatus[];
}

interface ModelStatus {
  key: string;
  label: string;
  path: string | null;
  source: "saved" | "default" | "missing";
  exists: boolean;
}

interface Saved {
  backends?: Partial<
    Record<BackendId, { repoPath?: string; pythonBin?: string }>
  >;
  models?: Record<string, string | undefined>;
}

interface Status {
  styleVault: boolean;
  saved: Saved;
  backends: BackendStatus[];
  models: ModelStatus[];
}

interface Detect {
  id: BackendId;
  ok: boolean;
  commit: string | null;
  problems: string[];
  warnings: string[];
  families: { family: string; status: string; ready: boolean }[];
}

const API = "/api/settings/training";

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data.ok === false)
    throw new Error(
      typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
    );
  return data;
}

const inputCls =
  "w-full rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-primary)] px-2 py-1.5 font-mono text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-splash";
const btnCls =
  "flex items-center gap-1.5 rounded-xl border border-[var(--border-secondary)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] transition-[background-color,transform] duration-150 hover:bg-[var(--bg-hover)] active:scale-[0.96] disabled:opacity-40";

const BACKEND_NAMES: Record<BackendId, string> = {
  "musubi-tuner": "musubi-tuner (kohya-ss)",
  "ai-toolkit": "ai-toolkit (ostris)",
};

function toDraft(saved: Saved) {
  return {
    backends: {
      "musubi-tuner": {
        repoPath: saved.backends?.["musubi-tuner"]?.repoPath ?? "",
        pythonBin: saved.backends?.["musubi-tuner"]?.pythonBin ?? "",
      },
      "ai-toolkit": {
        repoPath: saved.backends?.["ai-toolkit"]?.repoPath ?? "",
        pythonBin: saved.backends?.["ai-toolkit"]?.pythonBin ?? "",
      },
    },
    models: Object.fromEntries(
      Object.entries(saved.models ?? {}).map(([k, v]) => [k, v ?? ""]),
    ) as Record<string, string>,
  };
}
type Draft = ReturnType<typeof toDraft>;

function SetupSnippet({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast("Couldn't copy to the clipboard.", "error");
    }
  };
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg bg-[var(--bg-primary)] p-2 pr-9 text-[10px] leading-relaxed text-[var(--text-secondary)]">
        {text}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="Copy setup commands"
        className="absolute right-1.5 top-1.5 rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>
    </div>
  );
}

export function TrainingSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detect, setDetect] = useState<Detect[] | null>(null);

  const apply = (d: Record<string, unknown>) => {
    const s = d as unknown as Status;
    setStatus(s);
    setDraft(toDraft(s.saved ?? {}));
  };

  const load = useCallback(async () => {
    try {
      apply(await call(API, "GET"));
    } catch {
      showToast("Couldn't load the training settings.", "error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      apply(await call(API, "PUT", { training: draft }));
      setDetect(null);
      showToast("Training settings saved.", "success");
    } catch (e) {
      showToast(
        `Couldn't save: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const runDetect = async () => {
    setDetecting(true);
    try {
      const d = await call(`${API}/detect`, "POST");
      setDetect((d.backends as Detect[]) ?? []);
    } catch (e) {
      showToast(
        `Detect failed: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setDetecting(false);
    }
  };

  const setBackend = (
    id: BackendId,
    field: "repoPath" | "pythonBin",
    value: string,
  ) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            backends: {
              ...d.backends,
              [id]: { ...d.backends[id], [field]: value },
            },
          }
        : d,
    );

  const setModel = (key: string, value: string) =>
    setDraft((d) => (d ? { ...d, models: { ...d.models, [key]: value } } : d));

  if (!status || !draft)
    return (
      <p
        className="text-xs text-[var(--text-muted)]"
        data-testid="training-settings"
      >
        Loading…
      </p>
    );

  return (
    <div className="space-y-5" data-testid="training-settings">
      <p className="text-[10px] text-pretty text-[var(--text-muted)]">
        Characters, Styles and Train Identity train LoRAs with a trainer you
        install yourself. Adrift writes the config and runs the trainer&apos;s
        own scripts, one job at a time; finished LoRAs are linked into
        ComfyUI&apos;s loras folder when ComfyUI is on this machine.
      </p>
      {status.styleVault && (
        <p className="rounded-lg border border-[var(--border-secondary)] p-2 text-[10px] text-[var(--text-secondary)]">
          STYLEVAULT_API_URL is set, so training goes to StyleVault and these
          settings are not used.
        </p>
      )}

      {status.backends.map((b) => {
        const det = detect?.find((x) => x.id === b.id);
        return (
          <div key={b.id} className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <h4 className="text-xs font-medium text-[var(--text-primary)]">
                {BACKEND_NAMES[b.id]}
              </h4>
              <span className="text-[10px] text-[var(--text-muted)]">
                {b.families
                  .filter((f) => f.status !== "unsupported")
                  .map(
                    (f) =>
                      `${f.family}${f.status === "untested" ? " (untested)" : ""}${f.ready ? " ✓" : ""}`,
                  )
                  .join(" · ")}
              </span>
            </div>
            <label className="block space-y-1">
              <span className="text-[10px] text-[var(--text-muted)]">
                Repo folder
              </span>
              <input
                className={inputCls}
                value={draft.backends[b.id].repoPath}
                placeholder={`~/src/${b.id}`}
                onChange={(e) => setBackend(b.id, "repoPath", e.target.value)}
                spellCheck={false}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] text-[var(--text-muted)]">
                Python (the repo&apos;s venv)
              </span>
              <input
                className={inputCls}
                value={draft.backends[b.id].pythonBin}
                placeholder={`~/src/${b.id}/.venv/bin/python`}
                onChange={(e) => setBackend(b.id, "pythonBin", e.target.value)}
                spellCheck={false}
              />
            </label>
            {(b.repoPath || b.pythonBin) && b.problems.length > 0 && (
              <ul className="list-disc pl-4 text-[10px] text-amber-500">
                {b.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            {det && (
              <div
                className="space-y-1 rounded-lg border border-[var(--border-secondary)] p-2 text-[10px] text-[var(--text-secondary)]"
                data-testid={`training-detect-${b.id}`}
              >
                <p>
                  {det.ok ? "Found" : "Not ready"}
                  {det.commit ? ` · commit ${det.commit}` : ""}
                  {det.families.some((f) => f.ready)
                    ? ` · can train ${det.families
                        .filter((f) => f.ready)
                        .map((f) => f.family)
                        .join(", ")}`
                    : ""}
                </p>
                {[...det.problems, ...det.warnings].map((p) => (
                  <p key={p} className="text-amber-500">
                    {p}
                  </p>
                ))}
              </div>
            )}
            <details>
              <summary className="cursor-pointer text-[10px] text-[var(--text-muted)]">
                Setup commands (see the repo&apos;s README for your GPU)
              </summary>
              <div className="mt-1 space-y-1">
                <a
                  href={b.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] text-splash underline"
                >
                  {b.repoUrl}
                </a>
                <SetupSnippet text={b.setup} />
              </div>
            </details>
          </div>
        );
      })}

      <div className="space-y-2">
        <h4 className="text-xs font-medium text-[var(--text-primary)]">
          Model files
        </h4>
        <p className="text-[10px] text-pretty text-[var(--text-muted)]">
          Leave empty to use the file from ComfyUI&apos;s models folder where a
          default exists.
        </p>
        {status.models.map((m) => (
          <label key={m.key} className="block space-y-1">
            <span className="text-[10px] text-[var(--text-muted)]">
              {m.label}
              {m.source === "default" && m.path
                ? ` · default ${m.exists ? "found" : "missing"}`
                : m.source === "saved" && !m.exists
                  ? " · missing"
                  : ""}
            </span>
            <input
              className={inputCls}
              value={draft.models[m.key] ?? ""}
              placeholder={m.source === "default" && m.path ? m.path : ""}
              onChange={(e) => setModel(m.key, e.target.value)}
              spellCheck={false}
            />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={btnCls}
          onClick={() => void save()}
          disabled={saving}
        >
          {saving && (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          )}
          Save
        </button>
        <button
          type="button"
          className={btnCls}
          onClick={() => void runDetect()}
          disabled={detecting}
        >
          {detecting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Search className="h-3.5 w-3.5" aria-hidden />
          )}
          Detect
        </button>
      </div>
    </div>
  );
}

export default TrainingSettings;

"use client";

/**
 * "Set up this tool" drawer: every weight file an unavailable tool needs
 * (folder, size, license, source, copyable download command, installed or
 * not) plus the node classes the server is missing. Data from
 * GET /api/tools/setup (src/lib/tools/setupRequirements.ts). When ComfyUI
 * runs on this machine, missing files download in one click
 * (POST /api/tools/setup/download). Native <dialog>:
 * focus is trapped while open, Esc closes, focus returns to the opener.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Square,
  RefreshCw,
  Wrench,
  X,
} from "lucide-react";
import type {
  FileStatus,
  SetupFile,
  SetupOption,
  ToolSetup,
} from "@/lib/tools/setupRequirements";
import { comfyEnvLine } from "@/lib/tools/setupCommands";
import { LicenseLink } from "@/components/models/LicenseLink";

interface FileRow extends SetupFile {
  status: FileStatus;
  /** Download-list pin the command uses (null = not in the list). */
  revision?: string | null;
  /** models/ path when the app can download it in one click, else null. */
  dest?: string | null;
  /** Other Tools-page cards that load the same file. */
  sharedWith?: number;
}

interface OptionRow extends Omit<SetupOption, "files"> {
  backend: "default" | "video";
  files: FileRow[];
  missingNodes: string[] | null;
  missingOptionalNodes: string[] | null;
  nodeSources: Record<string, string>;
}

interface SetupResponse {
  ok: boolean;
  error?: string;
  setup?: Omit<ToolSetup, "options"> & { options: OptionRow[] };
  /** The server's ComfyUI folder (COMFY_ROOT). */
  comfyRoot?: string;
  /** One fetch-models.mjs call for the whole tool; null = not scriptable. */
  fetchCommand?: string | null;
  /** The app can save files into this ComfyUI (it runs on this machine). */
  canDownload?: boolean;
  /** Why it can't, when it can't. */
  downloadNote?: string | null;
}

/** GET/POST /api/tools/setup/download job (src/lib/tools/setupDownload.ts). */
export interface DownloadJob {
  id: string;
  key: string;
  dests: string[];
  state: "running" | "done" | "failed" | "cancelled";
  lines: string[];
  exitCode: number | null;
}

/** One-click downloads for one card: start, poll, cancel. */
export interface SetupDownloads {
  enabled: boolean;
  job: DownloadJob | null;
  error: string | null;
  start: (dests: string[]) => void;
  cancel: () => void;
}

const POLL_MS = 1500;

function useSetupDownloads(
  card: SetupCardRef,
  enabled: boolean,
  onFinished: () => void,
): SetupDownloads {
  const [job, setJob] = useState<DownloadJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  // Pick up a download already running for this card (drawer reopened).
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch("/api/tools/setup/download", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { job?: DownloadJob } | null) => {
        if (alive && b?.job?.state === "running" && b.job.key === card.key)
          setJob(b.job);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [enabled, card.key]);

  const running = job?.state === "running";
  const jobId = job?.id;
  useEffect(() => {
    if (!running || !jobId) return;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const r = await fetch(
          `/api/tools/setup/download?job=${encodeURIComponent(jobId)}`,
          { cache: "no-store" },
        );
        const b = (await r.json().catch(() => null)) as { job?: DownloadJob } | null;
        if (!alive || !b?.job) return;
        setJob(b.job);
        if (b.job.state !== "running") finished.current();
      } catch {
        /* server restarting: keep polling */
      }
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [running, jobId]);

  const start = useCallback(
    async (dests: string[]) => {
      setError(null);
      try {
        const r = await fetch("/api/tools/setup/download", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: card.key, id: card.id, dests }),
        });
        const b = (await r.json().catch(() => null)) as {
          job?: DownloadJob;
          error?: string;
        } | null;
        if (r.ok && b?.job) setJob(b.job);
        else {
          setError(b?.error ?? `Download failed to start (${r.status})`);
          if (b?.job?.key === card.key) setJob(b.job);
        }
      } catch {
        setError("Could not reach the app server.");
      }
    },
    [card.key, card.id],
  );

  const cancel = useCallback(async () => {
    if (!jobId) return;
    await fetch(`/api/tools/setup/download?job=${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }).catch(() => {});
    setJob((j) => (j ? { ...j, state: "cancelled" } : j));
    finished.current();
  }, [jobId]);

  return {
    enabled,
    job,
    error,
    start: (d) => void start(d),
    cancel: () => void cancel(),
  };
}

/** Card fields the drawer needs (a HubCard fits). */
export interface SetupCardRef {
  key: string;
  id: string;
  title: string;
}

/** Same units as docs/models.md (modelsDoc.ts is server-only: it reads disk). */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 GB";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function sumBytes(files: FileRow[]): number {
  return files.reduce((n, f) => n + (f.bytes ?? 0), 0);
}

function useCopy(): [string | null, (id: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback((id: string, text: string) => {
    const done = () => {
      setCopied(id);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(null), 1600);
    };
    try {
      navigator.clipboard.writeText(text).then(done, () => {});
    } catch {
      /* no clipboard API (insecure origin): the command stays selectable */
    }
  }, []);
  return [copied, copy];
}

function CopyButton({
  id,
  text,
  copied,
  onCopy,
  label,
}: {
  id: string;
  text: string;
  copied: string | null;
  onCopy: (id: string, text: string) => void;
  label: string;
}) {
  const done = copied === id;
  return (
    <button
      type="button"
      onClick={() => onCopy(id, text)}
      aria-label={done ? "Copied" : label}
      title={label}
      className="flex-shrink-0 rounded-md p-1.5 text-light-500 transition-colors hover:bg-light-100 hover:text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:text-dark-400 dark:hover:bg-dark-750 dark:hover:text-dark-primary"
    >
      {done ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

const STATUS_STYLE: Record<FileStatus, string> = {
  installed: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  missing: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  unknown: "bg-light-100 text-light-500 dark:bg-dark-750 dark:text-dark-400",
};

const STATUS_LABEL: Record<FileStatus, string> = {
  installed: "Installed",
  missing: "Missing",
  unknown: "Not checked",
};

function Chip({
  className,
  children,
}: {
  className: string;
  children: string;
}) {
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${className}`}
    >
      {children}
    </span>
  );
}

function FileItem({
  f,
  copied,
  onCopy,
  dl,
}: {
  f: FileRow;
  copied: string | null;
  onCopy: (id: string, text: string) => void;
  dl?: SetupDownloads;
}) {
  const id = `${f.folder ?? ""}${f.file}`;
  const busy = dl?.job?.state === "running";
  const mine = busy && !!f.dest && dl!.job!.dests.includes(f.dest);
  const canGet = !!dl?.enabled && !!f.dest && f.status !== "installed";
  return (
    <li
      data-testid="setup-file"
      data-status={f.status}
      className="space-y-1.5 rounded-xl bg-light-input p-3 dark:bg-dark-input"
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-all text-[13px] font-semibold text-light-primary dark:text-dark-primary">
            {f.file}
          </p>
          <p className="break-all text-[11px] text-light-500 dark:text-dark-400">
            {f.folder ? `models/${f.folder}` : "Folder: set by its node pack"}
          </p>
        </div>
        <Chip className={STATUS_STYLE[f.status]}>{STATUS_LABEL[f.status]}</Chip>
        {canGet && (
          <button
            type="button"
            data-testid="setup-file-download"
            onClick={() => dl!.start([f.dest!])}
            disabled={busy}
            aria-label={`Download ${f.file}`}
            title={busy ? (mine ? "Downloading" : "Another download is running") : "Download into ComfyUI"}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-lg bg-splash/10 px-2 py-0.5 text-[11px] font-semibold text-splash transition-colors hover:bg-splash/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-splash disabled:opacity-50"
          >
            {mine ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            {mine ? "Getting" : "Get"}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-light-500 dark:text-dark-400">
        <span className="font-medium tabular-nums">
          {f.bytes != null ? formatBytes(f.bytes) : "size unknown"}
        </span>
        <span aria-hidden>·</span>
        <LicenseLink
          name={f.license}
          url={f.licenseUrl}
          className="text-splash underline-offset-2 hover:underline"
        />
        {f.nc && (
          <Chip className="bg-red-500/10 text-red-600 dark:text-red-400">
            NC
          </Chip>
        )}
        {f.optional && (
          <Chip className="bg-light-100 text-light-500 dark:bg-dark-750 dark:text-dark-400">
            Optional
          </Chip>
        )}
        {(f.sharedWith ?? 0) > 0 && (
          <span
            data-testid="setup-file-shared"
            title="Downloaded once: every tool that loads it uses the same file."
          >
            Shared with {f.sharedWith} other tool{f.sharedWith === 1 ? "" : "s"}
          </span>
        )}
        {f.gated && (
          <Chip className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
            Gated
          </Chip>
        )}
        {!f.sourceUrl && f.source && <span>Source: {f.source}</span>}
        {f.sourceUrl && (
          <a
            href={f.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 rounded text-splash hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-splash"
          >
            {f.source}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      {f.command ? (
        <div className="flex items-start gap-1 rounded-lg bg-light-bg p-1.5 dark:bg-dark-bg">
          <code className="min-w-0 flex-1 select-all break-all px-1 py-0.5 font-mono text-[11px] leading-relaxed text-light-primary dark:text-dark-primary">
            {f.command}
          </code>
          <CopyButton
            id={id}
            text={f.command}
            copied={copied}
            onCopy={onCopy}
            label={`Copy download command for ${f.file}`}
          />
        </div>
      ) : (
        <p className="text-[11px] text-light-500 dark:text-dark-400">
          {f.note ??
            (f.gated && f.sourceUrl
              ? "Gated: accept its terms on the source page above, then download it there."
              : f.sourceUrl
                ? "No scripted download known: get it from the source link above."
                : "No scripted download known.")}
        </p>
      )}
      {f.command && f.pathGuessed && (
        <p className="text-[10px] text-light-400 dark:text-dark-300">
          Path inside the repo not verified: check the repo file list if the
          download 404s.
        </p>
      )}
      {f.command && f.note && (
        <p className="text-[10px] text-light-400 dark:text-dark-300">
          {f.note}
        </p>
      )}
    </li>
  );
}

/**
 * One-click download of the selected option's missing files, with the last
 * log lines of the running job. Only when ComfyUI runs on this machine.
 */
export function DownloadPanel({
  files,
  dl,
}: {
  files: FileRow[];
  dl: SetupDownloads;
}) {
  const need = files.filter(
    (f) => !f.optional && f.status !== "installed",
  );
  const auto = need.filter((f) => f.dest);
  const manual = need.length - auto.length;
  const job = dl.job;
  const running = job?.state === "running";
  const last = job?.lines.slice(-4) ?? [];
  return (
    <section
      aria-labelledby="setup-download"
      data-testid="setup-download"
      className="space-y-2 rounded-xl border border-splash/30 bg-splash/5 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3
          id="setup-download"
          className="text-[12px] font-medium text-light-primary dark:text-dark-primary"
        >
          Download
        </h3>
        {running ? (
          <button
            type="button"
            onClick={dl.cancel}
            className="inline-flex items-center gap-1 rounded-lg bg-light-input px-2 py-1 text-[11px] font-semibold text-light-primary transition-colors hover:bg-light-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:bg-dark-input dark:text-dark-primary dark:hover:bg-dark-750"
          >
            <Square className="h-3 w-3" /> Stop
          </button>
        ) : (
          auto.length > 0 && (
            <button
              type="button"
              data-testid="setup-download-all"
              onClick={() => dl.start(auto.map((f) => f.dest!))}
              className="inline-flex items-center gap-1 rounded-lg bg-splash px-2.5 py-1 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-splash"
            >
              <Download className="h-3.5 w-3.5" />
              Get {auto.length} missing · {formatBytes(sumBytes(auto))}
            </button>
          )
        )}
      </div>
      <p className="text-[12px] text-light-500 dark:text-dark-400">
        {need.length === 0
          ? "Every required file is installed."
          : manual > 0
            ? `${auto.length ? "Saves the pinned files straight into ComfyUI/models. " : ""}${manual} file${manual === 1 ? " needs" : "s need"} a manual download (gated or not in the download list): see its source link below.`
            : "Saves the pinned files straight into ComfyUI/models. Sizes are checked, nothing is overwritten, and a stopped download resumes."}
      </p>
      {dl.error && (
        <p role="alert" className="text-[12px] text-red-600 dark:text-red-400">
          {dl.error}
        </p>
      )}
      {job && (
        <div
          role="status"
          aria-live="polite"
          data-testid="setup-download-log"
          data-state={job.state}
          className="space-y-1 rounded-lg bg-light-bg p-2 dark:bg-dark-bg"
        >
          <p className="flex items-center gap-1.5 text-[12px] font-medium text-light-primary dark:text-dark-primary">
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-splash" />
            ) : job.state === "done" ? (
              <Check className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <X className="h-3.5 w-3.5 text-red-500" />
            )}
            {running
              ? `Downloading ${job.dests.length} file${job.dests.length === 1 ? "" : "s"}...`
              : job.state === "done"
                ? "Downloaded. Restart ComfyUI if the tool still shows files missing."
                : job.state === "cancelled"
                  ? "Stopped. Get resumes where it left off."
                  : "Download failed. Get again to resume, or use the commands below."}
          </p>
          {last.length > 0 && (
            <pre className="max-h-24 overflow-hidden whitespace-pre-wrap break-all font-mono text-[10px] leading-snug text-light-500 dark:text-dark-400">
              {last.join("\n")}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The first thing to run: one script call that fetches every pinned file the
 * tool needs into the server's ComfyUI folder (sizes checked, nothing
 * overwritten).
 */
export function QuickSetup({
  command,
  copied,
  onCopy,
}: {
  command: string;
  copied: string | null;
  onCopy: (id: string, text: string) => void;
}) {
  return (
    <section
      aria-labelledby="setup-quick"
      data-testid="setup-quick"
      className="space-y-1.5 rounded-xl border border-splash/30 bg-splash/5 p-3"
    >
      <h3
        id="setup-quick"
        className="text-[12px] font-medium text-light-primary dark:text-dark-primary"
      >
        Quick setup
      </h3>
      <p className="text-[12px] text-light-500 dark:text-dark-400">
        Run this in the Adrift folder. It downloads every file this tool can
        use that you don&apos;t have yet, checks sizes and never overwrites
        anything. Then restart ComfyUI.
      </p>
      <div className="flex items-start gap-1 rounded-lg bg-light-bg p-1.5 dark:bg-dark-bg">
        <code className="min-w-0 flex-1 select-all break-all px-1 py-0.5 font-mono text-[11px] leading-relaxed text-light-primary dark:text-dark-primary">
          {command}
        </code>
        <CopyButton
          id="fetch"
          text={command}
          copied={copied}
          onCopy={onCopy}
          label="Copy the setup command"
        />
      </div>
    </section>
  );
}

export function OptionBody({
  opt,
  copied,
  onCopy,
  envLine = comfyEnvLine(null),
  dl,
}: {
  opt: OptionRow;
  copied: string | null;
  onCopy: (id: string, text: string) => void;
  /** `export COMFYUI=<root>` for the manual commands. */
  envLine?: string;
  /** One-click downloads (absent/disabled = commands only). */
  dl?: SetupDownloads;
}) {
  const required = opt.files.filter((f) => !f.optional);
  const toGet = opt.files.filter(
    (f) => !f.optional && f.status !== "installed",
  );
  const missingCmds = toGet
    .map((f) => f.command)
    .filter((c): c is string => !!c);
  const unknownSize = opt.files.filter((f) => f.bytes == null).length;
  const missing: Array<[string, boolean]> = [
    ...(opt.missingNodes ?? []).map((c): [string, boolean] => [c, false]),
    ...(opt.missingOptionalNodes ?? []).map((c): [string, boolean] => [c, true]),
  ];
  const stats: Array<[string, string]> = [
    [
      "Files",
      `${required.length} required · ${opt.files.length - required.length} optional`,
    ],
    ["Required", formatBytes(sumBytes(required))],
    ["All modes", formatBytes(sumBytes(opt.files))],
    ["Still to download", formatBytes(sumBytes(toGet))],
  ];
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-2">
        {stats.map(([k, v]) => (
          <div
            key={k}
            className="rounded-xl bg-light-input px-3 py-2 dark:bg-dark-input"
          >
            <dt className="text-[10px] font-medium text-light-500 dark:text-dark-400">
              {k}
            </dt>
            <dd
              data-testid={`setup-stat-${k.toLowerCase().replace(/\s+/g, "-")}`}
              className="text-[13px] font-semibold tabular-nums text-light-primary dark:text-dark-primary"
            >
              {v}
            </dd>
          </div>
        ))}
      </dl>
      {unknownSize > 0 && (
        <p className="text-[11px] text-light-500 dark:text-dark-400">
          {unknownSize} file{unknownSize === 1 ? "" : "s"} with no recorded size
          (not in the totals).
        </p>
      )}

      {dl?.enabled && <DownloadPanel files={opt.files} dl={dl} />}

      {opt.notes.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-700 dark:text-amber-300">
          {opt.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <section aria-labelledby={`setup-files-${opt.id}`} className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3
            id={`setup-files-${opt.id}`}
            className="text-[12px] font-medium text-light-500 dark:text-dark-400"
          >
            Manual
          </h3>
          {missingCmds.length > 0 && (
            <button
              type="button"
              onClick={() =>
                onCopy(`all:${opt.id}`, [envLine, ...missingCmds].join("\n"))
              }
              className="inline-flex items-center gap-1 rounded-lg bg-splash/10 px-2 py-1 text-[11px] font-semibold text-splash transition-colors hover:bg-splash/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-splash"
            >
              {copied === `all:${opt.id}` ? (
                <Check className="h-3 w-3" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              {copied === `all:${opt.id}`
                ? "Copied"
                : `Copy ${missingCmds.length} missing command${missingCmds.length === 1 ? "" : "s"}`}
            </button>
          )}
        </div>
        <p className="text-[11px] text-light-500 dark:text-dark-400">
          Or download each file yourself. Hugging Face lines are pinned to the
          same revision the setup script uses.
        </p>
        <div className="flex items-start gap-1 rounded-lg bg-light-input p-1.5 dark:bg-dark-input">
          <code className="min-w-0 flex-1 select-all break-all px-1 py-0.5 font-mono text-[11px] text-light-500 dark:text-dark-400">
            {envLine}
          </code>
          <CopyButton
            id="env"
            text={envLine}
            copied={copied}
            onCopy={onCopy}
            label="Copy the COMFYUI path line"
          />
        </div>
        {opt.files.length === 0 ? (
          <p className="text-[12px] text-light-500 dark:text-dark-400">
            No model files found in this tool&apos;s graphs.
          </p>
        ) : (
          <ul className="space-y-2">
            {opt.files.map((f) => (
              <FileItem
                key={`${f.folder}${f.file}`}
                f={f}
                copied={copied}
                onCopy={onCopy}
                dl={dl}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`setup-nodes-${opt.id}`} className="space-y-2">
        <h3
          id={`setup-nodes-${opt.id}`}
          className="text-[12px] font-medium text-light-500 dark:text-dark-400"
        >
          Custom nodes
        </h3>
        {opt.nodePacks.length > 0 && (
          <p className="text-[12px] text-light-primary dark:text-dark-primary">
            Needs node pack: {opt.nodePacks.join(", ")}
          </p>
        )}
        {opt.missingNodes === null ? (
          <p className="text-[12px] text-light-500 dark:text-dark-400">
            Server not reachable: node classes not checked.
          </p>
        ) : missing.length === 0 ? (
          <p className="flex items-center gap-1 text-[12px] text-emerald-600 dark:text-emerald-400">
            <Check className="h-3.5 w-3.5" /> All{" "}
            {opt.nodeClasses.length + opt.optionalNodeClasses.length} node
            classes are installed.
          </p>
        ) : (
          <ul className="space-y-1" data-testid="setup-missing-nodes">
            {missing.map(([c, optional]) => (
              <li
                key={c}
                className="flex flex-wrap items-center gap-1.5 rounded-lg bg-light-input px-2.5 py-1.5 text-[12px] dark:bg-dark-input"
              >
                <code className="font-mono text-light-primary dark:text-dark-primary">
                  {c}
                </code>
                {optional && (
                  <Chip className="bg-light-100 text-light-500 dark:bg-dark-750 dark:text-dark-400">
                    Optional
                  </Chip>
                )}
                <span className="text-[11px] text-light-500 dark:text-dark-400">
                  {opt.nodeSources[c]
                    ? `ships in this repo: copy comfy_nodes/${opt.nodeSources[c]} into ComfyUI/custom_nodes/`
                    : "install the node pack that provides it (ComfyUI-Manager: Install Missing Custom Nodes)"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {opt.workflows.length > 0 && (
        <p className="break-all text-[10px] text-light-400 dark:text-dark-300">
          Graphs: {opt.workflows.join(", ")}
          {opt.backend === "video" ? " (video backend)" : ""}
        </p>
      )}
    </div>
  );
}

export function SetupDrawer({
  card,
  open,
  onClose,
}: {
  card: SetupCardRef;
  open: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<SetupResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [optIdx, setOptIdx] = useState(0);
  const [copied, copy] = useCopy();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ key: card.key, id: card.id });
      const res = await fetch(`/api/tools/setup?${q}`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as SetupResponse | null;
      setData(body ?? { ok: false, error: `Request failed (${res.status})` });
    } catch {
      setData({ ok: false, error: "Could not reach the app server." });
    } finally {
      setLoading(false);
    }
  }, [card.key, card.id]);

  const dl = useSetupDownloads(
    card,
    open && !!data?.canDownload,
    () => void load(),
  );

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open) {
      if (!d.open) {
        if (typeof d.showModal === "function") d.showModal();
        else d.setAttribute("open", "");
      }
      void load();
    } else if (d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open, load]);

  const options = data?.setup?.options ?? [];
  const opt = options[Math.min(optIdx, options.length - 1)];
  const titleId = `setup-title-${card.key.replace(/[^\w-]/g, "-")}`;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid="setup-drawer"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // Backdrop click (the dialog itself, outside the panel) closes.
        if (e.target === ref.current) onClose();
      }}
      className="m-0 mt-auto max-h-[88dvh] w-full max-w-full overflow-hidden rounded-t-2xl bg-light-bg p-0 text-light-primary shadow-2xl backdrop:bg-black/50 dark:bg-dark-bg dark:text-dark-primary sm:my-0 sm:ml-auto sm:mr-0 sm:h-dvh sm:max-h-dvh sm:w-[460px] sm:rounded-none sm:rounded-l-2xl"
    >
      <div className="flex max-h-[88dvh] flex-col sm:h-dvh sm:max-h-dvh">
        <header className="flex items-start gap-3 border-b border-light-100 px-4 py-3 dark:border-dark-750">
          <Wrench className="mt-0.5 h-4 w-4 flex-shrink-0 text-splash" />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[15px] font-semibold">
              Set up {card.title}
            </h2>
            <p className="text-[12px] text-light-500 dark:text-dark-400">
              Files to place under ComfyUI/models/, then restart ComfyUI.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label="Recheck what the server has"
            title="Recheck"
            className="rounded-lg p-1.5 text-light-500 hover:bg-light-100 hover:text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash disabled:opacity-50 dark:text-dark-400 dark:hover:bg-dark-750 dark:hover:text-dark-primary"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-light-500 hover:bg-light-100 hover:text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:text-dark-400 dark:hover:bg-dark-750 dark:hover:text-dark-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4">
          <p aria-live="polite" className="sr-only">
            {copied ? "Copied to clipboard" : ""}
          </p>
          {!data && loading && (
            <p
              role="status"
              className="flex items-center gap-2 text-[13px] text-light-500 dark:text-dark-400"
            >
              <Loader2 className="h-4 w-4 animate-spin" /> Reading the
              tool&apos;s graphs...
            </p>
          )}
          {data && !data.ok && (
            <p
              role="alert"
              className="text-[13px] text-red-600 dark:text-red-400"
            >
              {data.error ?? "No setup info for this tool."}
            </p>
          )}
          {data?.ok && !data.canDownload && data.downloadNote && (
            <p
              data-testid="setup-download-note"
              className="rounded-xl bg-light-input px-3 py-2 text-[12px] text-light-500 dark:bg-dark-input dark:text-dark-400"
            >
              {data.downloadNote}
            </p>
          )}
          {data?.fetchCommand && (
            <QuickSetup
              command={data.fetchCommand}
              copied={copied}
              onCopy={copy}
            />
          )}
          {data?.setup && options.length > 1 && (
            <fieldset className="space-y-1.5">
              <legend className="text-[12px] text-light-500 dark:text-dark-400">
                {data.setup.anyOf
                  ? "Any one of these engines runs it: pick one to install."
                  : "Options"}
              </legend>
              <div className="flex flex-wrap gap-1.5" role="radiogroup">
                {options.map((o, i) => {
                  const on = o === opt;
                  const ready =
                    o.files.every(
                      (f) => f.optional || f.status === "installed",
                    ) && (o.missingNodes?.length ?? 0) === 0;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setOptIdx(i)}
                      className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-splash ${
                        on
                          ? "bg-splash text-white"
                          : "bg-light-input text-light-primary hover:bg-light-100 dark:bg-dark-input dark:text-dark-primary dark:hover:bg-dark-750"
                      }`}
                    >
                      {o.label}
                      {o.model ? ` · ${o.model}` : ""} ·{" "}
                      {formatBytes(
                        sumBytes(o.files.filter((f) => !f.optional)),
                      )}
                      {ready ? " ✓" : ""}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
          {opt && (
            <OptionBody
              opt={opt}
              copied={copied}
              onCopy={copy}
              envLine={comfyEnvLine(data?.comfyRoot)}
              dl={dl}
            />
          )}
        </div>
      </div>
    </dialog>
  );
}

/**
 * "Set up" button + its drawer. `compact` = the small link under a hub card;
 * otherwise the button inside the runner's blocked banner.
 */
export function SetupToolButton({
  card,
  compact,
  hint,
}: {
  card: SetupCardRef;
  /** Small "Setup" chip for hub card footers (full label stays accessible). */
  compact?: boolean;
  /** What is missing ("Needs an edit LoRA"): chip tooltip. */
  hint?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen(true)}
        data-testid={`setup-tool-${card.key}`}
        aria-haspopup="dialog"
        aria-label={compact ? `Set up this tool${hint ? `: ${hint}` : ""}` : undefined}
        title={compact ? (hint ?? "Set up this tool") : undefined}
        className={
          compact
            ? "inline-flex h-5 flex-shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium leading-none text-light-500 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)] transition-[background-color,color,box-shadow] duration-150 hover:bg-amber-500/10 hover:text-amber-700 hover:shadow-[inset_0_0_0_1px_rgba(180,83,9,0.35)] focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:text-dark-400 dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] dark:hover:text-amber-300 dark:hover:shadow-[inset_0_0_0_1px_rgba(252,211,77,0.35)]"
            : "mt-1.5 inline-flex items-center gap-1 rounded-lg bg-amber-500/15 px-2 py-1 text-[12px] font-semibold text-amber-700 transition-colors hover:bg-amber-500/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-300"
        }
      >
        <Wrench className={compact ? "h-2.5 w-2.5" : "h-3.5 w-3.5"} aria-hidden />
        {compact ? "Setup" : "Set up this tool"}
      </button>
      {open && (
        <SetupDrawer
          card={card}
          open={open}
          onClose={() => {
            setOpen(false);
            btn.current?.focus();
          }}
        />
      )}
    </>
  );
}

"use client";

/**
 * Folders editor: the setup wizard's Folders step and the Settings card.
 *
 * Each row shows the folder in use (home folder as ~), whether it came from
 * .env.local (locked), was set here, or is the default, and a live check from
 * the server. Rows on their default follow the ComfyUI folder as it is typed.
 * Nothing is created unless "Create folder" is clicked.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FolderPlus,
  Loader2,
  Lock,
  RotateCcw,
  Server,
  XCircle,
} from "lucide-react";
import {
  checkDir,
  getDirs,
  saveDirs,
  type DirCheckView,
  type DirKey,
  type DirsResponse,
} from "./api";
import {
  FOLDER_META,
  folderSavePayload,
  folderValue,
  initialFolderRows,
  rowView,
  visibleFolderKeys,
  type FolderRows,
} from "./foldersModel";
import { BTN, CHIP_NEUTRAL, CHIP_OK, Chip, INPUT, MUTED } from "./ui";

export interface FoldersEditorHandle {
  /** Save the folders; resolves false (and shows the error) on failure. */
  save: () => Promise<boolean>;
}

export const PRECEDENCE_HELP =
  "A folder set in .env.local (COMFY_ROOT, COMFY_MODELS_DIR, COMFY_INPUT_DIR, COMFYUI_OUTPUT_DIR, ADRIFT_DATA_DIR) always wins and shows as locked. Otherwise the folder you set here is used. Rows left on their default follow the ComfyUI folder.";

function StatusLine({
  check,
  busy,
  locked,
  envVar,
}: {
  check: DirCheckView | undefined;
  busy: boolean;
  locked: boolean;
  envVar: string;
}) {
  const lock = locked ? (
    <span className={`inline-flex items-center gap-1 ${MUTED}`}>
      <Lock className="h-3.5 w-3.5" /> Set by {envVar} in .env.local
    </span>
  ) : null;
  if (busy && !check)
    return (
      <span className={`inline-flex items-center gap-1 ${MUTED}`}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…
      </span>
    );
  if (!check) return lock;
  const icon =
    check.status === "ok" ? (
      <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />
    ) : check.status === "warn" ? (
      <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
    ) : check.status === "error" ? (
      <XCircle className="h-3.5 w-3.5 flex-shrink-0 text-red-500" />
    ) : (
      <Server className={`h-3.5 w-3.5 flex-shrink-0 ${MUTED}`} />
    );
  const text =
    check.status === "ok"
      ? check.created
        ? "Folder created"
        : "Looks good"
      : check.reason;
  const tone =
    check.status === "warn"
      ? "text-amber-600 dark:text-amber-400"
      : check.status === "error"
        ? "text-red-600 dark:text-red-400"
        : MUTED;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span
        className={`inline-flex min-w-0 items-center gap-1 ${tone}`}
        role="status"
        data-testid="folder-status"
      >
        {icon}
        <span className="min-w-0">{text}</span>
      </span>
      {lock}
    </span>
  );
}

export const FoldersEditor = forwardRef<
  FoldersEditorHandle,
  {
    /** "I don't have ComfyUI yet": only Adrift's own folder. */
    noComfy?: boolean;
    /** Show a Save button (Settings); the wizard saves on Next instead. */
    showSave?: boolean;
    /** Preloaded payload (tests / server render). */
    initial?: DirsResponse | null;
  }
>(function FoldersEditor({ noComfy = false, showSave = false, initial }, ref) {
  const [resp, setResp] = useState<DirsResponse | null>(initial ?? null);
  const [rows, setRows] = useState<FolderRows | null>(() =>
    initial ? initialFolderRows(initial) : null,
  );
  const [checks, setChecks] = useState<Partial<Record<DirKey, DirCheckView>>>(
    () =>
      initial
        ? Object.fromEntries(initial.dirs.map((d) => [d.key, d.check]))
        : {},
  );
  const [busy, setBusy] = useState<Partial<Record<DirKey, boolean>>>({});
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const timers = useRef<Partial<Record<DirKey, ReturnType<typeof setTimeout>>>>(
    {},
  );
  const seq = useRef<Partial<Record<DirKey, number>>>({});

  const apply = useCallback((r: DirsResponse) => {
    setResp(r);
    setRows(initialFolderRows(r));
    setChecks(Object.fromEntries(r.dirs.map((d) => [d.key, d.check])));
  }, []);

  useEffect(() => {
    if (initial) return;
    let live = true;
    void getDirs().then((r) => {
      if (!live) return;
      if (r) apply(r);
      else setLoadFailed(true);
    });
    return () => {
      live = false;
    };
  }, [initial, apply]);

  useEffect(
    () => () => {
      for (const t of Object.values(timers.current)) if (t) clearTimeout(t);
    },
    [],
  );

  const keys = visibleFolderKeys(noComfy);

  const runCheck = useCallback(
    async (key: DirKey, value: string, create = false) => {
      const n = (seq.current[key] ?? 0) + 1;
      seq.current[key] = n;
      if (!value.trim()) {
        setChecks((c) => ({ ...c, [key]: undefined }));
        return;
      }
      setBusy((b) => ({ ...b, [key]: true }));
      const r = await checkDir({ key, path: value, create });
      if (seq.current[key] !== n) return; // a newer value is being checked
      setBusy((b) => ({ ...b, [key]: false }));
      setChecks((c) => ({ ...c, [key]: r.check }));
      if (!r.ok) setError(r.error ?? "Couldn't check that folder.");
    },
    [],
  );

  // Re-check every visible row whose shown value changed (debounced).
  const values = useMemo(() => {
    if (!rows || !resp) return null;
    const out: Partial<Record<DirKey, string>> = {};
    for (const k of keys) out[k] = folderValue(k, rows, resp);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, resp, noComfy]);
  const lastChecked = useRef<Partial<Record<DirKey, string>>>({});
  useEffect(() => {
    if (!values || !resp) return;
    for (const k of keys) {
      const v = values[k] ?? "";
      if (lastChecked.current[k] === undefined) {
        // First render: the GET payload already carries this check.
        lastChecked.current[k] = v;
        if (v === rowView(resp, k)?.display) continue;
      }
      if (lastChecked.current[k] === v) continue;
      lastChecked.current[k] = v;
      const t = timers.current[k];
      if (t) clearTimeout(t);
      timers.current[k] = setTimeout(() => void runCheck(k, v), 350);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!rows) return true; // nothing loaded: nothing to save, don't block
    setSaving(true);
    setError(null);
    setSaved(false);
    const r = await saveDirs(folderSavePayload(rows, noComfy));
    setSaving(false);
    if (!r.ok || !("dirs" in r)) {
      const key = "key" in r ? r.key : undefined;
      setError(
        key
          ? `${FOLDER_META[key].label}: ${r.error}`
          : (r.error ?? "Couldn't save."),
      );
      return false;
    }
    lastChecked.current = {};
    apply(r);
    setSaved(true);
    return true;
  }, [rows, noComfy, apply]);

  useImperativeHandle(ref, () => ({ save }), [save]);

  if (loadFailed)
    return (
      <p className={`text-[13px] ${MUTED}`}>
        Couldn&apos;t load the folder settings. Open Adrift on the computer it
        runs on to set them.
      </p>
    );
  if (!rows || !resp)
    return (
      <p className={`inline-flex items-center gap-2 text-[13px] ${MUTED}`}>
        <Loader2 className="h-4 w-4 animate-spin" /> Loading folders…
      </p>
    );

  const remote = !resp.comfyLocal && !noComfy;
  const update = (key: DirKey, patch: Partial<FolderRows[DirKey]>) => {
    setSaved(false);
    setRows((r) => (r ? { ...r, [key]: { ...r[key], ...patch } } : r));
  };

  return (
    <div className="space-y-3 text-[13px]" data-testid="folders-editor">
      {noComfy ? (
        <p className={MUTED}>
          Pick where Adrift keeps its own library. The ComfyUI folders can be
          set later in Settings &rarr; Folders, once ComfyUI is installed.
        </p>
      ) : remote ? (
        <div className="flex gap-2 rounded-xl bg-light-100 p-3 text-[12px] dark:bg-dark-850">
          <Server className={`mt-0.5 h-4 w-4 flex-shrink-0 ${MUTED}`} />
          <p>
            ComfyUI runs on another machine, so its folders live there and
            Adrift can&apos;t check them. Set them only if you want the commands
            Adrift shows to use them. Adrift&apos;s own library is checked here.
          </p>
        </div>
      ) : (
        <p className={MUTED}>
          {checks.comfyRoot?.status === "error"
            ? "Set where ComfyUI is installed; the other ComfyUI folders follow it unless you change them."
            : "Adrift found these. Change any that live somewhere else."}
        </p>
      )}

      {keys.map((key) => {
        const row = rows[key];
        const view = rowView(resp, key);
        const meta = FOLDER_META[key];
        const value = values?.[key] ?? "";
        const check = checks[key];
        const id = `folder-${key}`;
        const sourceChip = row.locked ? (
          <Chip className={CHIP_NEUTRAL}>.env.local</Chip>
        ) : row.useDefault ? (
          <Chip className={CHIP_NEUTRAL}>Default</Chip>
        ) : (
          <Chip className={CHIP_OK}>Custom</Chip>
        );
        return (
          <div
            key={key}
            className="rounded-xl border border-light-100 p-3 dark:border-dark-750"
            data-testid={id}
          >
            <div className="flex items-center gap-2">
              <label htmlFor={id} className="min-w-0 flex-1 font-semibold">
                {meta.label}
              </label>
              {sourceChip}
            </div>
            <p className={`mt-0.5 text-[12px] leading-snug ${MUTED}`}>
              {meta.help}
            </p>
            <input
              id={id}
              type="text"
              value={value}
              readOnly={row.locked}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              placeholder={view?.defaultDisplay}
              onChange={(e) =>
                update(key, { value: e.target.value, useDefault: false })
              }
              className={`${INPUT} mt-2 font-mono text-[13px] ${row.locked ? "cursor-not-allowed opacity-70" : ""}`}
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
              <span className="min-w-0 flex-1">
                <StatusLine
                  check={check}
                  busy={!!busy[key]}
                  locked={row.locked}
                  envVar={view?.envVar ?? ""}
                />
              </span>
              {!row.locked && check?.canCreate && check.status !== "remote" && (
                <button
                  type="button"
                  onClick={() => void runCheck(key, value, true)}
                  className={`${BTN.ghost} min-h-[32px] px-2 text-[12px]`}
                >
                  <FolderPlus className="h-3.5 w-3.5" /> Create folder
                </button>
              )}
              {!row.locked && !row.useDefault && (
                <button
                  type="button"
                  onClick={() => update(key, { useDefault: true })}
                  className={`${BTN.ghost} min-h-[32px] px-2 text-[12px]`}
                  aria-label={`Use the default ${meta.label} folder`}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Use default
                </button>
              )}
            </div>
            {check?.notes.map((n) => (
              <p key={n} className={`mt-1 text-[12px] ${MUTED}`}>
                {n}
              </p>
            ))}
          </div>
        );
      })}

      <details className={`text-[12px] ${MUTED}`}>
        <summary className="w-fit cursor-pointer rounded hover:text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:hover:text-dark-primary">
          Which folder wins?
        </summary>
        <p className="mt-1 leading-snug">{PRECEDENCE_HELP}</p>
      </details>

      {error && (
        <p className="text-[12px] text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      {showSave && (
        <div className="flex items-center justify-end gap-2">
          {saved && (
            <span className="inline-flex items-center gap-1 text-[12px] text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className={BTN.primary}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
            folders
          </button>
        </div>
      )}
    </div>
  );
});

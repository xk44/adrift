"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileUp,
  Loader2,
  PackageSearch,
  X,
} from "lucide-react";
import {
  HUB_CATEGORIES,
  HUB_CATEGORY_LABELS,
  type HubCategory,
} from "@/lib/tools/hub";
import {
  analyzeImportApi,
  fileToImportRequest,
  saveUserToolApi,
  type ImportRequest,
} from "@/lib/userTools/client";
import {
  USER_TOOL_ICONS,
  userToolKey,
  type UserToolAnalysis,
  type UserToolParam,
} from "@/lib/userTools/types";
import { useUserToolsStore } from "@/store/userToolsStore";
import { openSetupTab } from "@/lib/setupNav";
import { matchBlockedPackId } from "@/lib/comfy/nodeBlocklist";
import { showToast } from "@/components/Toast";
import { readFileAsDataUrl } from "../ToolImageInput";
import { TOOL_ICONS } from "../ToolCover";
import { RUN_BUTTON, RunError, errorMessage } from "../RunnerShell";
import { FIELD, LABEL, NOTE, PILL_BUTTON, SECTION_TITLE } from "./ui";
import {
  ModelOverrideList,
  initialOverridePicks,
  overrideKey,
  overridesFromPicks,
} from "./ModelOverridePicker";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const KIND_LABEL: Record<UserToolParam["kind"], string> = {
  prompt: "Text",
  negative: "Text",
  image: "Image",
  mask: "Mask",
  video: "Clip",
  audio: "Audio",
  seed: "Seed",
  steps: "Number",
  cfg: "Number",
  width: "Size",
  height: "Size",
  lora_strength: "Number",
  denoise: "Number",
};

/** "Import workflow" pill for the Tools page header; also opens for Explore. */
export function ImportWorkflowButton({
  onSaved,
}: {
  onSaved: (toolKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [initialUrl, setInitialUrl] = useState<string | null>(null);
  const pending = useUserToolsStore((s) => s.pendingImportUrl);
  useEffect(() => {
    if (!pending) return;
    setInitialUrl(useUserToolsStore.getState().consumeImport());
    setOpen(true);
  }, [pending]);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setInitialUrl(null);
          setOpen(true);
        }}
        data-testid="tools-import-workflow"
        title="Turn a ComfyUI workflow into your own tool"
        className={PILL_BUTTON}
      >
        <Download className="h-3.5 w-3.5" /> Import
      </button>
      {open && (
        <ImportWorkflowDialog
          initialUrl={initialUrl}
          onClose={() => setOpen(false)}
          onSaved={(key) => {
            setOpen(false);
            onSaved(key);
          }}
        />
      )}
    </>
  );
}

type Step =
  | { kind: "pick" }
  | { kind: "busy"; label: string }
  | { kind: "review"; analysis: UserToolAnalysis };

export function ImportWorkflowDialog({
  initialUrl,
  onClose,
  onSaved,
}: {
  initialUrl: string | null;
  onClose: () => void;
  onSaved: (toolKey: string) => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [url, setUrl] = useState(initialUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const started = useRef(false);

  const analyze = async (req: ImportRequest, label: string) => {
    setError(null);
    setStep({ kind: "busy", label });
    try {
      const analysis = await analyzeImportApi(fetch, req);
      setStep({ kind: "review", analysis });
    } catch (e) {
      setError(errorMessage(e));
      setStep({ kind: "pick" });
    }
  };

  // Opened from Explore with a link: start right away.
  useEffect(() => {
    if (started.current || !initialUrl) return;
    started.current = true;
    void analyze({ url: initialUrl }, "Downloading from Civitai…");
  }, [initialUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(json|png|zip)$/i.test(file.name)) {
      setError("Choose a .json, .png or .zip file.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("That file is larger than 25 MB.");
      return;
    }
    const data = await readFileAsDataUrl(file);
    await analyze(fileToImportRequest(file.name, data), "Reading the workflow…");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import a workflow"
        data-testid="import-workflow-dialog"
        className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-t-2xl bg-light-bg shadow-2xl animate-fade-in dark:bg-dark-bg sm:rounded-2xl"
      >
        <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-4">
          <h2 className="text-base font-semibold text-light-primary dark:text-dark-primary">
            {step.kind === "review" ? "Set up your tool" : "Import a workflow"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full text-light-500 hover:bg-light-input hover:text-light-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:text-dark-400 dark:hover:bg-dark-input dark:hover:text-dark-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {step.kind === "pick" && (
          <div className="space-y-4 overflow-y-auto px-5 pb-5">
            <p className={NOTE}>
              Bring in a ComfyUI workflow and use it like any other tool. It
              runs in your own ComfyUI.
            </p>
            <form
              className="space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (url.trim())
                  void analyze({ url: url.trim() }, "Downloading from Civitai…");
              }}
            >
              <label htmlFor="import-wf-url" className={LABEL}>
                Civitai link
              </label>
              <div className="flex gap-2">
                <input
                  id="import-wf-url"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://civitai.com/models/123"
                  data-testid="import-workflow-url"
                  className={FIELD}
                />
                <button
                  type="submit"
                  disabled={!url.trim()}
                  className={PILL_BUTTON}
                >
                  Fetch
                </button>
              </div>
            </form>
            <div className="flex items-center gap-3 text-[11px] text-light-400 dark:text-dark-300">
              <span className="h-px flex-1 bg-light-100 dark:bg-dark-750" />
              or
              <span className="h-px flex-1 bg-light-100 dark:bg-dark-750" />
            </div>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void pickFile(e.dataTransfer.files?.[0]);
              }}
              data-testid="import-workflow-file"
              className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed border-light-100 px-4 py-6 text-center transition-colors hover:border-splash focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:border-dark-750"
            >
              <FileUp className="h-5 w-5 text-light-500 dark:text-dark-400" />
              <span className="text-sm text-light-primary dark:text-dark-primary">
                Choose or drop a file
              </span>
              <span className={NOTE}>
                A workflow .json, a ComfyUI .png, or a .zip from Civitai
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.png,.zip,application/json,image/png,application/zip"
              className="hidden"
              onChange={(e) => {
                void pickFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            {error && <RunError message={error} />}
          </div>
        )}

        {step.kind === "busy" && (
          <div
            role="status"
            className="flex flex-col items-center gap-2 px-5 py-12 text-sm text-light-500 dark:text-dark-400"
          >
            <Loader2 className="h-5 w-5 animate-spin" />
            {step.label}
          </div>
        )}

        {step.kind === "review" && (
          <ReviewStep
            analysis={step.analysis}
            onBack={() => setStep({ kind: "pick" })}
            onSaved={onSaved}
          />
        )}
      </div>
    </div>
  );
}

function ReviewStep({
  analysis,
  onBack,
  onSaved,
}: {
  analysis: UserToolAnalysis;
  onBack: () => void;
  onSaved: (toolKey: string) => void;
}) {
  const [name, setName] = useState(analysis.suggested.name);
  const [icon, setIcon] = useState(analysis.suggested.icon);
  const [category, setCategory] = useState<HubCategory>(
    analysis.suggested.category,
  );
  const [params, setParams] = useState<UserToolParam[]>(analysis.params);
  const [picks, setPicks] = useState<Record<string, string>>(() =>
    initialOverridePicks(analysis.missingModels),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const tool = await saveUserToolApi(fetch, {
        name: name.trim(),
        icon,
        category,
        description: analysis.suggested.description,
        analysis,
        params,
        modelOverrides: overridesFromPicks(analysis.missingModels, picks),
      });
      useUserToolsStore.getState().upsert(tool);
      showToast(`${tool.name} is in My tools.`, "success");
      onSaved(userToolKey(tool.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: string) =>
    setParams((ps) =>
      ps.map((p) => (p.key === key ? { ...p, exposed: !p.exposed } : p)),
    );

  return (
    <>
      <div
        className="space-y-5 overflow-y-auto px-5 pb-4"
        data-testid="import-workflow-review"
      >
        <p className={NOTE}>
          From {analysis.sourceFile}
          {analysis.otherFiles.length > 0 &&
            ` (also found ${analysis.otherFiles.length} other workflow file${analysis.otherFiles.length === 1 ? "" : "s"})`}
          .
          {analysis.fromPack &&
            " This is an exported Adrift tool, so its name and settings are restored."}
        </p>

        <Checks
          analysis={analysis}
          picks={picks}
          onPick={(key, value) => setPicks((p) => ({ ...p, [key]: value }))}
        />

        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <div>
            <label htmlFor="import-wf-name" className={LABEL}>
              Name
            </label>
            <input
              id="import-wf-name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="import-wf-cat" className={LABEL}>
              Section
            </label>
            <select
              id="import-wf-cat"
              value={category}
              onChange={(e) => setCategory(e.target.value as HubCategory)}
              className={FIELD}
            >
              {HUB_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {HUB_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <span className={LABEL}>Icon</span>
          <div
            className="flex flex-wrap gap-1.5"
            role="radiogroup"
            aria-label="Icon"
          >
            {USER_TOOL_ICONS.map((n) => {
              const Icon = TOOL_ICONS[n];
              if (!Icon) return null;
              const on = icon === n;
              return (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={n}
                  onClick={() => setIcon(n)}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg transition-[background-color,color,transform] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-splash active:scale-[0.94] ${
                    on
                      ? "bg-splash text-white"
                      : "bg-light-input text-light-500 hover:text-light-primary dark:bg-dark-input dark:text-dark-400 dark:hover:text-dark-primary"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <h3 className={SECTION_TITLE}>What you can change when you run it</h3>
          <p className={`${NOTE} mb-2`}>
            Ticked settings get a field in the tool. The rest keep the
            workflow&apos;s own values.
          </p>
          {params.length === 0 ? (
            <p className={NOTE}>
              No common settings found. The tool will run the workflow as is.
            </p>
          ) : (
            <ul className="divide-y divide-light-100 rounded-xl bg-light-input/50 dark:divide-dark-750 dark:bg-dark-input/50">
              {params.map((p) => (
                <li key={p.key}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={p.exposed}
                      onChange={() => toggle(p.key)}
                      className="h-4 w-4 accent-splash"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-light-primary dark:text-dark-primary">
                        {p.label}
                      </span>
                      {p.default !== undefined && p.default !== "" && (
                        <span className="block truncate text-[11px] text-light-500 dark:text-dark-400">
                          {String(p.default)}
                        </span>
                      )}
                    </span>
                    <span className="rounded-full bg-light-bg px-2 py-0.5 text-[10px] text-light-500 dark:bg-dark-bg dark:text-dark-400">
                      {KIND_LABEL[p.kind]}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        {error && <RunError message={error} />}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-light-100 px-5 py-3 dark:border-dark-750">
        <button type="button" onClick={onBack} className={PILL_BUTTON}>
          Back
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !name.trim()}
          data-testid="import-workflow-save"
          className={RUN_BUTTON}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Save to My tools
        </button>
      </div>
    </>
  );
}

/**
 * Suggested packs with blocklist status: Manager refuses to install packs on
 * the supply-chain blocklist, so the dialog must not present them as the fix.
 */
export function flagBlockedPacks(
  packs: { id: string; label: string }[],
): { id: string; label: string; blocked: string[] | null }[] {
  return packs.map((p) => {
    const m = matchBlockedPackId(p.id);
    return { ...p, blocked: m ? m.rules : null };
  });
}

export function Checks({
  analysis,
  picks = {},
  onPick = () => {},
}: {
  analysis: UserToolAnalysis;
  picks?: Record<string, string>;
  onPick?: (key: string, value: string) => void;
}) {
  if (!analysis.checked) {
    return (
      <p className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
        ComfyUI is not reachable, so missing nodes and models were not
        checked. You can still save it.
      </p>
    );
  }
  const { missingNodes, missingModels } = analysis;
  if (missingNodes.length === 0 && missingModels.length === 0) {
    return (
      <p className="rounded-xl bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
        Your ComfyUI has every node and model this workflow uses.
      </p>
    );
  }
  return (
    <div
      className="space-y-3 rounded-xl bg-amber-500/10 px-3 py-2.5"
      data-testid="import-workflow-missing"
    >
      {missingNodes.length === 0 &&
      missingModels.every((m) => picks[overrideKey(m)]) ? (
        <p className="flex items-start gap-2 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="mt-px h-3.5 w-3.5 flex-shrink-0" />
          Every missing model has a stand-in you already have. Saving swaps
          them in.
        </p>
      ) : (
        <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" />
          Some pieces are missing. You can save now and add them later; the
          tool will not run until they are installed.
        </p>
      )}
      {missingNodes.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-light-primary dark:text-dark-primary">
              Nodes ({missingNodes.length})
            </span>
            <button
              type="button"
              onClick={() => openSetupTab("nodes")}
              className="flex items-center gap-1 text-xs font-medium text-splash hover:underline"
            >
              <PackageSearch className="h-3.5 w-3.5" /> Open node packs
            </button>
          </div>
          <ul className="space-y-0.5">
            {missingNodes.map((n) => (
              <li key={n.classType} className="text-xs">
                <span className="font-mono text-light-primary dark:text-dark-primary">
                  {n.classType}
                </span>
                {n.packs.length > 0 && (
                  <span className="text-light-500 dark:text-dark-400">
                    {" "}
                    · in{" "}
                    {flagBlockedPacks(n.packs).map((p, i) => (
                      <span key={p.id}>
                        {i > 0 && ", "}
                        {p.blocked ? (
                          <span
                            data-testid="blocked-pack"
                            title={`Blocked by the node-pack safety list (${p.blocked.join(", ")}). Manager will refuse to install it.`}
                            className="text-red-600 dark:text-red-400"
                          >
                            {p.label}{" "}
                            <span className="rounded bg-red-500/10 px-1 text-[10px] font-medium">
                              blocked
                            </span>
                          </span>
                        ) : (
                          p.label
                        )}
                      </span>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {missingModels.length > 0 && (
        <ModelOverrideList
          missing={missingModels}
          picks={picks}
          onPick={onPick}
        />
      )}
    </div>
  );
}

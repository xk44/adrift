"use client";

/**
 * object_info-driven pieces of the auto control panel: spec fetching,
 * per-run control_after_generate / dynamicPrompts handling, and the small
 * editors for upload, remote combos and unknown (future) input types.
 * WorkflowControlPanel composes these; the pure logic lives in
 * lib/oj/inputSpec.ts and lib/oj/workflowControlSchema.ts.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Loader2, RefreshCw, Upload } from "lucide-react";
import type { ControlSchema } from "@/lib/oj/workflowControlSchema";
import {
  applyInputSpecs,
  collectDynamicSubmitValues,
  syncDynamicComboControls,
} from "@/lib/oj/workflowControlSchema";
import {
  CONTROL_AFTER_GENERATE_MODES,
  expandDynamicPrompt,
  hasDynamicPromptSyntax,
  nextControlValue,
  type ControlAfterGenerateMode,
  type ObjectInfoIndex,
} from "@/lib/oj/inputSpec";
import {
  DEFAULT_CONTROL_MODE,
  useControlModeStore,
} from "@/store/controlModeStore";
import { useGenerationStore } from "@/store";
import { onComfyBackendChange } from "@/lib/comfy/backendChange";

// Spec fetching

const specCache = new Map<string, ObjectInfoIndex>();
onComfyBackendChange(() => specCache.clear());

/** Fetch trimmed object_info specs for the workflow's node classes. */
export function useInputSpecs(
  controls: ControlSchema[],
): ObjectInfoIndex | null {
  const classKey = useMemo(
    () =>
      Array.from(new Set(controls.map((c) => c.classType).filter(Boolean)))
        .sort()
        .join(","),
    [controls],
  );
  const [index, setIndex] = useState<ObjectInfoIndex | null>(
    () => specCache.get(classKey) ?? null,
  );

  useEffect(() => {
    if (!classKey) {
      setIndex(null);
      return;
    }
    const hit = specCache.get(classKey);
    if (hit) {
      setIndex(hit);
      return;
    }
    let cancelled = false;
    fetch(`/api/comfy/input-specs?classes=${encodeURIComponent(classKey)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { specs?: ObjectInfoIndex } | null) => {
        if (cancelled || !data?.specs) return;
        specCache.set(classKey, data.specs);
        setIndex(data.specs);
      })
      // Offline ComfyUI: keep the heuristic controls (graceful degrade).
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [classKey]);

  return index;
}

/** Controls with object_info metadata applied and dynamic combos synced. */
export function useSpecControls(
  controls: ControlSchema[],
  overrides: Record<string, unknown>,
): { controls: ControlSchema[]; index: ObjectInfoIndex | null } {
  const index = useInputSpecs(controls);
  const specControls = useMemo(() => {
    if (!index) return controls;
    return syncDynamicComboControls(
      applyInputSpecs(controls, index, overrides),
      index,
      overrides,
    );
  }, [controls, index, overrides]);
  return { controls: specControls, index };
}

// Per-run behavior: control_after_generate + dynamicPrompts

/** Current value of a control under the given overrides. */
function valueOf(
  c: ControlSchema,
  overrides: Record<string, unknown>,
): unknown {
  return Object.prototype.hasOwnProperty.call(overrides, c.key)
    ? overrides[c.key]
    : c.defaultValue;
}

/**
 * Overrides to hand the submit path: user overrides + dynamic-combo
 * child values + dynamicPrompts expansions. Expansions re-roll after
 * every run (`rollNonce`), mirroring ComfyUI's per-queue behavior.
 */
export function buildSubmitOverrides(
  controls: ControlSchema[],
  overrides: Record<string, unknown>,
  rng: () => number = Math.random,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...overrides,
    ...collectDynamicSubmitValues(controls, overrides),
  };
  for (const c of controls) {
    if (!c.dynamicPrompts) continue;
    const v = valueOf(c, out);
    if (hasDynamicPromptSyntax(v))
      out[c.key] = expandDynamicPrompt(v as string, rng);
  }
  return out;
}

/**
 * The control_after_generate step for every non-fixed control, as an
 * override patch. Pure so it can be unit-tested.
 */
export function computeAfterGeneratePatch(
  controls: ControlSchema[],
  overrides: Record<string, unknown>,
  modes: Record<string, ControlAfterGenerateMode> | undefined,
  rng: () => number = Math.random,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const c of controls) {
    if (!c.controlAfterGenerate) continue;
    const mode = modes?.[c.key] ?? DEFAULT_CONTROL_MODE;
    if (mode === "fixed") continue;
    const current = Number(valueOf(c, overrides));
    if (!Number.isFinite(current)) continue;
    patch[c.key] = nextControlValue(
      current,
      mode,
      {
        min: c.min,
        max: c.max,
        step: c.specType === "INT" ? c.step : undefined,
      },
      rng,
    );
  }
  return patch;
}

/**
 * Watches for new runs; after each one advances seeds per their mode and
 * bumps the nonce that re-rolls dynamic prompts. The run used the values
 * shown before it was queued (ComfyUI's "control after generate").
 */
export function useAfterGenerate(
  selectionKey: string,
  controls: ControlSchema[],
  overrides: Record<string, unknown>,
  applyPatch: (patch: Record<string, unknown>) => void,
): number {
  const latestRunId = useGenerationStore((s) => s.runs[0]?.run_id);
  const modes = useControlModeStore((s) => s.modes[selectionKey]);
  const [rollNonce, setRollNonce] = useState(0);
  const seen = useRef<string | undefined>(latestRunId);
  const latest = useRef({ controls, overrides, modes, applyPatch });
  latest.current = { controls, overrides, modes, applyPatch };

  useEffect(() => {
    if (latestRunId === seen.current) return;
    seen.current = latestRunId;
    if (!latestRunId) return;
    const {
      controls: cs,
      overrides: ov,
      modes: md,
      applyPatch: apply,
    } = latest.current;
    const patch = computeAfterGeneratePatch(cs, ov, md);
    if (Object.keys(patch).length > 0) apply(patch);
    setRollNonce((n) => n + 1);
  }, [latestRunId]);

  return rollNonce;
}

// Small editors

/** object_info tooltip as inline help text. */
export function ControlHelpText({ control }: { control: ControlSchema }) {
  if (!control.tooltip && !control.dynamicPrompts && !control.unknownType)
    return null;
  return (
    <div className="mt-0.5 space-y-0.5">
      {control.tooltip && (
        <p
          className="text-[10px] leading-snug text-light-500 dark:text-dark-400 line-clamp-2"
          title={control.tooltip}
        >
          {control.tooltip}
        </p>
      )}
      {control.dynamicPrompts && (
        <p className="text-[10px] text-violet-500/80 dark:text-violet-300/80">
          {"{a|b}"} choices are re-rolled every run
        </p>
      )}
      {control.unknownType && (
        <p className="text-[10px] text-amber-600/90 dark:text-amber-300/90">
          Unsupported input type {control.specType ?? "?"}; value is sent as
          typed
        </p>
      )}
    </div>
  );
}

/** fixed / increment / decrement / randomize selector for seed-like inputs. */
export function ControlModeSelect({
  selectionKey,
  controlKey,
}: {
  selectionKey: string;
  controlKey: string;
}) {
  const mode = useControlModeStore(
    (s) => s.modes[selectionKey]?.[controlKey] ?? DEFAULT_CONTROL_MODE,
  );
  const setMode = useControlModeStore((s) => s.setMode);
  return (
    <select
      value={mode}
      onChange={(e) =>
        setMode(
          selectionKey,
          controlKey,
          e.target.value as ControlAfterGenerateMode,
        )
      }
      aria-label="Control after generate"
      title="Control after generate: how this value changes after each run"
      className="shrink-0 h-7 rounded-lg border border-light-200 bg-light-50 px-1 text-[10px] text-light-600 dark:border-dark-700 dark:bg-dark-900 dark:text-dark-300"
    >
      {CONTROL_AFTER_GENERATE_MODES.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

const UPLOAD_ACCEPT: Record<string, string> = {
  image: "image/*",
  video: "video/*",
  audio: "audio/*",
};

/** Upload button for image_upload / video_upload inputs. */
export function UploadButton({
  control,
  onUploaded,
}: {
  control: ControlSchema;
  onUploaded: (ref: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = control.upload ?? "image";
  // The upload route accepts images and short videos only.
  const supported = kind === "image" || kind === "video";

  const handleFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () =>
            reject(reader.error ?? new Error("read failed"));
          reader.readAsDataURL(file);
        });
        const res = await fetch("/api/comfy/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: dataUrl, filename: file.name }),
        });
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          ref?: string;
          error?: string;
        } | null;
        if (!res.ok || !data?.ok || !data.ref) {
          throw new Error(data?.error ?? `Upload failed (HTTP ${res.status})`);
        }
        onUploaded(data.ref);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onUploaded],
  );

  if (!supported) return null;
  return (
    <div className="mt-1 flex items-center gap-1.5">
      <input
        ref={inputRef}
        type="file"
        accept={UPLOAD_ACCEPT[kind]}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void handleFile(f);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="flex items-center gap-1 rounded-md border border-light-200 bg-light-50 px-2 py-0.5 text-[10px] text-light-600 hover:border-splash/50 disabled:opacity-60 dark:border-dark-700 dark:bg-dark-900 dark:text-dark-300"
        title={`Upload a ${kind} to ComfyUI's input folder`}
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Upload className="h-3 w-3" />
        )}
        Upload {kind}
      </button>
      {error && (
        <span className="text-[10px] text-red-500 truncate">{error}</span>
      )}
    </div>
  );
}

/** Combo whose options come from a ComfyUI route (`remote` spec). */
export function RemoteEnumEditor({
  control,
  value,
  onChange,
}: {
  control: ControlSchema;
  value: string;
  onChange: (v: string) => void;
}) {
  const remote = control.remote!;
  const [options, setOptions] = useState<string[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const res = await fetch(
        `/api/comfy/remote-options?route=${encodeURIComponent(remote.route)}`,
      );
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        options?: string[];
        error?: string;
      } | null;
      if (!res.ok || !data?.ok)
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      const opts = data.options ?? [];
      setOptions(opts);
      setState("ready");
      if (
        remote.controlAfterRefresh === "first" &&
        opts.length > 0 &&
        !opts.includes(value)
      ) {
        onChange(opts[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }, [remote.route, remote.controlAfterRefresh, value, onChange]);

  // Load once per route; refresh is manual.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
  }, [remote.route]);

  // Fallback: static options from object_info, else the current value.
  const shown =
    options && options.length > 0
      ? options
      : control.options && control.options.length > 0
        ? control.options
        : value
          ? [value]
          : [];
  const list = shown.includes(value) || !value ? shown : [value, ...shown];

  return (
    <div>
      <div className="flex items-center gap-1">
        {state === "error" && list.length === 0 ? (
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="flex-1 min-w-0 rounded-lg border border-amber-500/40 bg-light-input px-2 py-1 text-xs dark:bg-dark-input"
          />
        ) : (
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="flex-1 min-w-0 rounded-lg border border-light-200 bg-light-input px-2 py-1 text-xs dark:border-dark-700 dark:bg-dark-input"
          >
            {list.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={state === "loading"}
          className="shrink-0 flex h-7 w-7 items-center justify-center rounded-lg border border-light-200 bg-light-50 text-light-500 dark:border-dark-700 dark:bg-dark-900"
          title="Refresh options from ComfyUI"
          aria-label="Refresh options"
        >
          {state === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      {state === "loading" && options === null && (
        <p className="mt-0.5 text-[10px] text-light-500 dark:text-dark-400">
          Loading options…
        </p>
      )}
      {state === "error" && (
        <p className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-300">
          Couldn&apos;t load options ({error}); showing fallback
        </p>
      )}
    </div>
  );
}

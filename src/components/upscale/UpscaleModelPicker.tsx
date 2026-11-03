"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Lock, Search, Star } from "lucide-react";
import { showToast } from "@/components/Toast";
import {
  UPSCALE_MODE_HINTS,
  type UpscaleModelOption,
} from "@/lib/upscale/upscaleModels";
import {
  readUpscaleModelPref,
  subscribeUpscaleModelPref,
  writeUpscaleModelPref,
} from "@/lib/upscale/upscalePrefs";
import {
  UPSCALE_CONTENT_LABELS,
  canBeDefault,
  type UpscaleContent,
} from "@/lib/upscale/upscalerCatalog";
import { resolveDefaultModel } from "@/lib/upscale/upscalerPref";
import {
  getUpscalerDefaults,
  loadUpscalerDefaults,
  saveUpscalerDefaults,
  subscribeUpscalerDefaults,
  type UpscalerDefaults,
} from "@/lib/upscale/upscalerDefaultsClient";
import {
  groupUpscalerOptions,
  upscalerUsage,
  usageText,
} from "@/lib/upscale/upscalerOptions";

/** One fetch per page load, shared by every picker. null = list unknown. */
let optionsPromise: Promise<UpscaleModelOption[] | null> | null = null;

export function loadUpscaleModels(): Promise<UpscaleModelOption[] | null> {
  if (!optionsPromise) {
    optionsPromise = fetch("/api/comfy/upscale-models")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (Array.isArray(d?.models)) return d.models as UpscaleModelOption[];
        optionsPromise = null; // server down: retry on the next mount
        return null;
      })
      .catch(() => {
        optionsPromise = null;
        return null;
      });
  }
  return optionsPromise;
}

/** Test hook: forget the cached options. */
export function resetUpscaleModelCache(): void {
  optionsPromise = null;
}

/** Per-run override ("" = the Settings default), shared across pickers. */
export function useUpscaleModelPref(): [string, (m: string) => void] {
  const [model, setModel] = useState(readUpscaleModelPref);
  useEffect(() => {
    setModel(readUpscaleModelPref());
    return subscribeUpscaleModelPref(setModel);
  }, []);
  return [model, writeUpscaleModelPref];
}

/** Settings → Upscaler snapshot (null until loaded or when not allowed). */
export function useUpscalerDefaults(): UpscalerDefaults | null {
  const [d, setD] = useState(getUpscalerDefaults);
  useEffect(() => {
    const off = subscribeUpscalerDefaults(setD);
    void loadUpscalerDefaults().then((v) => {
      if (v) setD(v);
    });
    return off;
  }, []);
  return d;
}

const tagCls =
  "rounded px-1 py-px text-[9px] uppercase tracking-wide bg-[var(--bg-tertiary)] text-[var(--text-muted)]";

/**
 * Upscale model picker: a searchable list grouped by kind (1× cleanup, 2×,
 * 4× photo, 4× illustration, faces) with short names and tags.
 *
 *   variant "run" (default)  "" = the Settings default for `content`, shown
 *                            by name with its lock; any pick is this run
 *                            only. Controlled with value / onChange (tool
 *                            page), else the shared session override.
 *                            Each row can be made the default.
 *   variant "default"        Settings: value / onChange edit the saved
 *                            choice; "" = the recommended model.
 */
export function UpscaleModelPicker({
  value,
  onChange,
  mode,
  compact = false,
  content = "photo",
  variant = "run",
  label,
  inline = false,
}: {
  value?: string;
  onChange?: (model: string) => void;
  /** upscale_subtle | upscale_creative: shows that mode's hint. */
  mode?: string;
  compact?: boolean;
  content?: UpscaleContent;
  variant?: "run" | "default";
  label?: string;
  /**
   * One quiet row ("Model" + small select) for action rows; renders nothing
   * until the list loads, and nothing when Standard is the only choice.
   */
  inline?: boolean;
}) {
  const [session, setSession] = useUpscaleModelPref();
  const defaults = useUpscalerDefaults();
  const [fetched, setFetched] = useState<UpscaleModelOption[] | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [loaded, setLoaded] = useState(false);
  const id = useId();
  const isDefaultVariant = variant === "default";
  const current = value ?? (isDefaultVariant ? "" : session);

  useEffect(() => {
    let live = true;
    loadUpscaleModels().then((o) => {
      if (!live) return;
      setFetched(o);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    searchRef.current?.focus();
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const options = fetched ?? defaults?.models ?? null;
  const groups = useMemo(
    () =>
      groupUpscalerOptions(options ?? [], {
        query,
        defaultsOnly: isDefaultVariant,
      }),
    [options, query, isDefaultVariant],
  );
  const flat = useMemo(
    () => ["", ...groups.flatMap((g) => g.options.map((o) => o.file))],
    [groups],
  );

  const savedDefault = defaults?.resolved?.[content]?.file ?? "";
  const recommended = useMemo(
    () =>
      options
        ? (resolveDefaultModel(
            content,
            null,
            options.map((o) => o.file),
          )?.file ?? "")
        : "",
    [options, content],
  );
  const nameOf = (file: string) =>
    options?.find((o) => o.file === file)?.name ?? file;

  const usage = upscalerUsage(current, content, defaults);
  const missing =
    options !== null &&
    current !== "" &&
    !options.some((o) => o.file === current);
  const hint = mode ? UPSCALE_MODE_HINTS[mode] : undefined;
  const locked = defaults?.locked ?? true;

  const select = (m: string) => {
    if (onChange) onChange(m);
    else if (!isDefaultVariant) setSession(m);
    setOpen(false);
    setQuery("");
  };

  const makeDefault = async (file: string) => {
    setSaving(true);
    try {
      await saveUpscalerDefaults({ [content]: file });
      select("");
      showToast(
        `${nameOf(file)} is now the default for ${UPSCALE_CONTENT_LABELS[content].toLowerCase()}.`,
        "success",
      );
    } catch (e) {
      showToast(
        `Couldn't save the default: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setSaving(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + d + flat.length) % flat.length);
    } else if (e.key === "Enter" && e.target === searchRef.current) {
      e.preventDefault();
      if (flat[active] !== undefined) {
        select(flat[active]);
        triggerRef.current?.focus();
      }
    }
  };

  const defaultRowLabel = isDefaultVariant
    ? `Recommended · ${recommended ? nameOf(recommended) : options ? "workflow's own" : "best installed"}`
    : `Default${savedDefault ? ` · ${nameOf(savedDefault)}` : ""}`;
  const buttonText =
    current === ""
      ? defaultRowLabel
      : `${nameOf(current)}${missing ? " (not installed)" : ""}`;
  const listId = `${id}-list`;
  const optId = (i: number) => `${id}-opt-${i}`;

  if (inline) {
    if (options === null || (options.length === 0 && current === "")) {
      return null;
    }
    return (
      <div
        className="flex min-w-0 items-center gap-2"
        data-testid="upscale-model-picker"
      >
        <label
          htmlFor={id}
          className="shrink-0 text-[11px] text-[var(--text-muted)]"
        >
          Model
        </label>
        <select
          id={id}
          value={current}
          onChange={(e) => select(e.target.value)}
          title={
            missing
              ? "This model is not on the server"
              : current === "" && locked
                ? "Upscale model (default locked in Settings)"
                : "Upscale model"
          }
          className={`h-10 min-w-0 flex-1 truncate rounded-lg bg-[var(--bg-secondary)] px-2 text-xs focus:outline-none md:h-8 ${
            missing ? "text-amber-500" : "text-[var(--text-secondary)]"
          }`}
        >
          <option value="">{defaultRowLabel}</option>
          {current !== "" && !options.some((o) => o.file === current) && (
            <option value={current}>{`${current} (not installed)`}</option>
          )}
          {options.map((o) => (
            <option key={o.file} value={o.file}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`relative ${compact ? "space-y-1" : "space-y-1.5"}`}
      data-testid="upscale-model-picker"
    >
      <label
        htmlFor={id}
        className="block text-xs font-medium text-[var(--text-primary)]"
      >
        {label ?? "Upscale model"}
      </label>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        value={current}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setActive(Math.max(0, flat.indexOf(current)));
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="flex h-9 w-full items-center gap-1.5 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-2 text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-splash"
      >
        <span className="min-w-0 flex-1 truncate">{buttonText}</span>
        {current === "" && !isDefaultVariant && locked && (
          <Lock
            className="h-3 w-3 shrink-0 text-[var(--text-muted)]"
            aria-label="Locked in Settings"
          />
        )}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-lg"
          onKeyDown={onKey}
        >
          <div className="flex items-center gap-1.5 border-b border-[var(--border-primary)] px-2">
            <Search className="h-3.5 w-3.5 text-[var(--text-muted)]" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder="Search: anime, sharp, 2x…"
              aria-label="Search upscale models"
              aria-controls={listId}
              aria-activedescendant={optId(active)}
              className="h-8 w-full bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
          </div>
          <ul
            id={listId}
            role="listbox"
            aria-label="Upscale models"
            className="max-h-72 overflow-y-auto py-1"
          >
            <li
              id={optId(0)}
              role="option"
              aria-selected={current === ""}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select("")}
              onMouseEnter={() => setActive(0)}
              className={`flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-xs text-[var(--text-primary)] ${active === 0 ? "bg-[var(--bg-hover)]" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate">{defaultRowLabel}</span>
              {!isDefaultVariant && locked && (
                <Lock className="h-3 w-3 text-[var(--text-muted)]" />
              )}
              {current === "" && <Check className="h-3 w-3 text-splash" />}
            </li>
            {options === null && (
              <li className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
                {loaded ? "Model list unavailable (ComfyUI offline)." : "Loading models…"}
              </li>
            )}
            {groups.map((g) => (
              <li key={g.category} role="presentation">
                <div className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  {g.label}
                </div>
                <ul role="presentation">
                  {g.options.map((o) => {
                    const i = flat.indexOf(o.file);
                    const isDefault =
                      o.file ===
                      (isDefaultVariant ? recommended : savedDefault);
                    return (
                      <li
                        key={o.file}
                        id={optId(i)}
                        role="option"
                        aria-selected={current === o.file}
                        title={o.file}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => select(o.file)}
                        onMouseEnter={() => setActive(i)}
                        className={`group flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-xs text-[var(--text-primary)] ${active === i ? "bg-[var(--bg-hover)]" : ""}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1">
                            <span className="truncate">{o.name}</span>
                            {o.scale && (
                              <span className="text-[var(--text-muted)]">
                                {o.scale}×
                              </span>
                            )}
                            {isDefault && (
                              <Star
                                className="h-3 w-3 fill-current text-splash"
                                aria-label={
                                  isDefaultVariant ? "Recommended" : "Default"
                                }
                              />
                            )}
                          </span>
                          <span className="mt-0.5 flex flex-wrap gap-1">
                            {o.tags.map((t) => (
                              <span key={t} className={tagCls}>
                                {t}
                              </span>
                            ))}
                          </span>
                        </span>
                        {!isDefaultVariant &&
                          defaults &&
                          !isDefault &&
                          canBeDefault(o) && (
                            <button
                              type="button"
                              disabled={saving}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={(e) => {
                                e.stopPropagation();
                                void makeDefault(o.file);
                              }}
                              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] text-splash hover:bg-splash/10 disabled:opacity-50 ${active === i ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"}`}
                            >
                              Set as default
                            </button>
                          )}
                        {current === o.file && (
                          <Check className="h-3 w-3 shrink-0 text-splash" />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
            {options !== null && groups.length === 0 && (
              <li className="px-2 py-1.5 text-[11px] text-[var(--text-muted)]">
                {query ? "No model matches." : "No extra upscale models found."}
              </li>
            )}
          </ul>
        </div>
      )}

      {missing ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          This model is not on the server, so the run will fail. Pick another.
        </p>
      ) : (
        !isDefaultVariant && (
          <p
            className="text-[11px] text-[var(--text-muted)]"
            data-testid="upscale-model-usage"
          >
            {usageText(usage)}
          </p>
        )
      )}
      {hint && <p className="text-[11px] text-[var(--text-muted)]">{hint}</p>}
    </div>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search, X } from "lucide-react";
import {
  CIVITAI_CHECKPOINT_TYPES,
  CIVITAI_MODEL_SORTS,
  CIVITAI_PERIODS,
  CIVITAI_PERIOD_LABELS,
  civitaiTypeLabel,
  searchBaseModelGroups,
  type CivitaiBaseModel,
} from "@/lib/civitaiFilters";
import {
  HF_LIBRARIES,
  HF_SORTS,
  HF_SORT_LABELS,
  HF_TASKS,
  hfTaskLabel,
} from "@/lib/hfModels";
import {
  MODEL_SOURCES,
  activeFilterChips,
  clearModelFilters,
  filterControlsFor,
  removeFilterChip,
  showsCheckpointType,
  toggleIn,
  typeOptionsFor,
  withModelSource,
  type ModelFilters,
  type ModelScope,
  type ModelSource,
} from "@/lib/modelFilters";
import { FitsMyGpuToggle } from "./FitsMyGpuToggle";

/**
 * One filter bar for every model feed: source switch first
 * (Civitai | Civitai Red | Hugging Face), then Sort, Period, Type, Base
 * model, Task, Library, creator — each shown only when the active source
 * supports it — and a removable-chip row with "Clear all".
 *
 * Menus are anchored popovers at md+ and bottom sheets on phones (portaled
 * to <body> so the fixed tab bar can't cover them).
 */
export function ModelFilterBar({
  filters,
  onChange,
  scope,
  query,
  onQueryChange,
}: {
  filters: ModelFilters;
  onChange: (next: ModelFilters) => void;
  scope: ModelScope;
  /** Pass both to render a search field inside the bar (Workflows surface). */
  query?: string;
  onQueryChange?: (q: string) => void;
}) {
  const controls = filterControlsFor(filters.source);
  const chips = activeFilterChips(filters, scope);
  const set = (patch: Partial<ModelFilters>) =>
    onChange({ ...filters, ...patch });
  const typeOptions = typeOptionsFor(scope);
  const pickedTypes = filters.types.filter((t) => typeOptions.includes(t));

  const typeLabel =
    pickedTypes.length === 0
      ? scope === "loras"
        ? "All LoRA types"
        : "All types"
      : pickedTypes.length === 1
        ? civitaiTypeLabel(pickedTypes[0])
        : `${civitaiTypeLabel(pickedTypes[0])} +${pickedTypes.length - 1}`;
  const baseLabel =
    filters.baseModels.length === 0
      ? "Base model"
      : filters.baseModels.length === 1
        ? filters.baseModels[0]
        : `${filters.baseModels[0]} +${filters.baseModels.length - 1}`;

  return (
    <div className="pb-3" data-testid="model-filter-bar">
      <div className="noScrollbar -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
        <SourceSwitch
          value={filters.source}
          onChange={(source) => onChange(withModelSource(filters, source))}
        />

        {onQueryChange && (
          <label className="relative shrink-0">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="search"
              value={query ?? ""}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search models"
              aria-label="Search models"
              className="h-8 w-40 rounded-full bg-[var(--bg-secondary)] pl-8 pr-3 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] shadow-[inset_0_0_0_1px_var(--border-primary)] transition-[width] focus:w-56 focus:outline-none focus:shadow-[inset_0_0_0_1px_var(--border-secondary)] [&::-webkit-search-cancel-button]:hidden"
            />
          </label>
        )}

        {controls.task ? (
          <>
            <FilterMenu label="Sort" value={HF_SORT_LABELS[filters.hfSort]}>
              {(close) =>
                HF_SORTS.map((s) => (
                  <MenuOption
                    key={s}
                    selected={filters.hfSort === s}
                    onSelect={() => {
                      set({ hfSort: s });
                      close();
                    }}
                  >
                    {HF_SORT_LABELS[s]}
                  </MenuOption>
                ))
              }
            </FilterMenu>
            <FilterMenu
              label="Task"
              value={filters.hfTask ? hfTaskLabel(filters.hfTask) : "Any task"}
              active={filters.hfTask !== null}
            >
              {(close) => (
                <>
                  <MenuOption
                    selected={filters.hfTask === null}
                    onSelect={() => {
                      set({ hfTask: null });
                      close();
                    }}
                  >
                    Any task
                  </MenuOption>
                  {HF_TASKS.map((t) => (
                    <MenuOption
                      key={t}
                      selected={filters.hfTask === t}
                      onSelect={() => {
                        set({ hfTask: t });
                        close();
                      }}
                    >
                      {hfTaskLabel(t)}
                    </MenuOption>
                  ))}
                </>
              )}
            </FilterMenu>
            <FilterMenu
              label="Library"
              value={filters.hfLibrary ?? "Any library"}
              active={filters.hfLibrary !== null}
            >
              {(close) => (
                <>
                  <MenuOption
                    selected={filters.hfLibrary === null}
                    onSelect={() => {
                      set({ hfLibrary: null });
                      close();
                    }}
                  >
                    Any library
                  </MenuOption>
                  {HF_LIBRARIES.map((l) => (
                    <MenuOption
                      key={l}
                      selected={filters.hfLibrary === l}
                      onSelect={() => {
                        set({ hfLibrary: l });
                        close();
                      }}
                    >
                      {l}
                    </MenuOption>
                  ))}
                </>
              )}
            </FilterMenu>
          </>
        ) : (
          <>
            <FilterMenu label="Sort" value={filters.sort}>
              {(close) =>
                CIVITAI_MODEL_SORTS.map((s) => (
                  <MenuOption
                    key={s}
                    selected={filters.sort === s}
                    onSelect={() => {
                      set({ sort: s });
                      close();
                    }}
                  >
                    {s}
                  </MenuOption>
                ))
              }
            </FilterMenu>
            <FilterMenu
              label="Period"
              value={CIVITAI_PERIOD_LABELS[filters.period]}
              active={filters.period !== "AllTime"}
            >
              {(close) =>
                CIVITAI_PERIODS.map((p) => (
                  <MenuOption
                    key={p}
                    selected={filters.period === p}
                    onSelect={() => {
                      set({ period: p });
                      close();
                    }}
                  >
                    {CIVITAI_PERIOD_LABELS[p]}
                  </MenuOption>
                ))
              }
            </FilterMenu>
            <FilterMenu
              label="Type"
              value={typeLabel}
              active={pickedTypes.length > 0}
              multi
            >
              {() => (
                <>
                  <MenuOption
                    selected={pickedTypes.length === 0}
                    onSelect={() =>
                      set({
                        types: filters.types.filter(
                          (t) => !typeOptions.includes(t),
                        ),
                        checkpointType: null,
                      })
                    }
                  >
                    {scope === "loras" ? "All LoRA types" : "All types"}
                  </MenuOption>
                  {typeOptions.map((t) => (
                    <MenuOption
                      key={t}
                      multi
                      selected={filters.types.includes(t)}
                      onSelect={() => {
                        const types = toggleIn(filters.types, t);
                        set({
                          types,
                          checkpointType: types.includes("Checkpoint")
                            ? filters.checkpointType
                            : null,
                        });
                      }}
                    >
                      {civitaiTypeLabel(t)}
                    </MenuOption>
                  ))}
                </>
              )}
            </FilterMenu>
            {showsCheckpointType(filters, scope) && (
              <Segmented
                label="Checkpoint type"
                options={[
                  { id: "", label: "Any" },
                  ...CIVITAI_CHECKPOINT_TYPES.map((c) => ({ id: c, label: c })),
                ]}
                value={filters.checkpointType ?? ""}
                onChange={(id) =>
                  set({
                    checkpointType:
                      id === "Trained" || id === "Merge" ? id : null,
                  })
                }
              />
            )}
            <FilterMenu
              label="Base model"
              value={baseLabel}
              active={filters.baseModels.length > 0}
              multi
              wide
            >
              {() => (
                <BaseModelPicker
                  selected={filters.baseModels}
                  onChange={(baseModels) => set({ baseModels })}
                />
              )}
            </FilterMenu>
          </>
        )}

        <CreatorInput
          value={filters.creator}
          placeholder={controls.task ? "Author" : "Creator"}
          onCommit={(creator) => set({ creator })}
        />

        {controls.nsfw && (
          <button
            type="button"
            onClick={() => set({ nsfw: !filters.nsfw })}
            aria-pressed={filters.nsfw}
            title={
              filters.nsfw
                ? "Civitai Red: mature results included"
                : "Civitai Red: SFW results only"
            }
            className={`h-8 shrink-0 rounded-full px-3 text-xs transition-colors ${
              filters.nsfw
                ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                : "text-[var(--text-muted)] shadow-[inset_0_0_0_1px_var(--border-primary)]"
            }`}
          >
            NSFW
          </button>
        )}

        <FitsMyGpuToggle />
      </div>

      {chips.length > 0 && (
        <div className="noScrollbar -mx-4 mt-1.5 flex items-center gap-1.5 overflow-x-auto px-4 md:mx-0 md:flex-wrap md:px-0">
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => onChange(removeFilterChip(filters, chip.id))}
              aria-label={`Remove filter ${chip.label}`}
              className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)] pl-2.5 pr-1.5 text-xs text-[var(--accent-primary)] transition-colors hover:bg-[color-mix(in_srgb,var(--accent-primary)_22%,transparent)]"
            >
              {chip.label}
              <X className="h-3.5 w-3.5" />
            </button>
          ))}
          <button
            type="button"
            onClick={() => onChange(clearModelFilters(filters))}
            className="h-7 shrink-0 px-2 text-xs text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

// Source segmented control

function SourceSwitch({
  value,
  onChange,
}: {
  value: ModelSource;
  onChange: (s: ModelSource) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Model source"
      className="flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-[var(--bg-secondary)] p-0.5 shadow-[inset_0_0_0_1px_var(--border-primary)]"
    >
      {MODEL_SOURCES.map((s) => (
        <button
          key={s.id}
          type="button"
          role="radio"
          aria-checked={value === s.id}
          onClick={() => onChange(s.id)}
          className={`flex h-7 items-center gap-1 whitespace-nowrap rounded-full px-3 text-xs transition-colors ${
            value === s.id
              ? "bg-[var(--bg-tertiary)] font-medium text-[var(--text-primary)]"
              : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
          }`}
        >
          {s.label}
          {s.badge && (
            <span
              className="rounded-full bg-red-600 px-1.5 py-px text-[10px] font-semibold leading-tight text-white"
              aria-label="adults only"
            >
              {s.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function Segmented({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      title={label}
      className="flex h-8 shrink-0 items-center gap-0.5 rounded-full p-0.5 shadow-[inset_0_0_0_1px_var(--border-primary)]"
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={`h-7 rounded-full px-2.5 text-xs transition-colors ${
            value === o.id
              ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
              : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Creator / author input

function CreatorInput({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim().replace(/^@/, "");
    if (next !== value) onCommit(next);
  };
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      placeholder={`@${placeholder.toLowerCase()}`}
      aria-label={placeholder}
      maxLength={64}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      className="h-8 w-28 shrink-0 rounded-full bg-transparent px-3 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] shadow-[inset_0_0_0_1px_var(--border-primary)] focus:outline-none focus:shadow-[inset_0_0_0_1px_var(--border-secondary)]"
    />
  );
}

// Base-model picker: searchable, grouped by family

function BaseModelPicker({
  selected,
  onChange,
}: {
  selected: CivitaiBaseModel[];
  onChange: (next: CivitaiBaseModel[]) => void;
}) {
  const [q, setQ] = useState("");
  const groups = searchBaseModelGroups(q);
  return (
    <div className="flex min-h-0 flex-col">
      <div className="sticky top-0 z-10 bg-[var(--bg-secondary)] p-1 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search 117 base models"
            aria-label="Search base models"
            autoFocus
            className="h-9 w-full rounded-lg bg-[var(--bg-primary)] pl-8 pr-3 text-[16px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] shadow-[inset_0_0_0_1px_var(--border-primary)] focus:outline-none md:text-sm [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="mt-1.5 px-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Clear {selected.length} selected
          </button>
        )}
      </div>
      {groups.length === 0 && (
        <p className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
          No base models match “{q}”
        </p>
      )}
      {groups.map((g) => {
        const allOn = g.models.every((m) => selected.includes(m));
        return (
          <div
            key={g.family}
            role="group"
            aria-label={g.family}
            className="pb-1"
          >
            <div className="flex items-center justify-between px-3 pb-0.5 pt-2">
              <span className="text-[10px] font-medium text-[var(--text-muted)]">
                {g.family}
              </span>
              <button
                type="button"
                onClick={() =>
                  onChange(
                    allOn
                      ? selected.filter((m) => !g.models.includes(m))
                      : [...new Set([...selected, ...g.models])],
                  )
                }
                className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                {allOn ? "None" : "All"}
              </button>
            </div>
            {g.models.map((m) => (
              <MenuOption
                key={m}
                multi
                dense
                selected={selected.includes(m)}
                onSelect={() => onChange(toggleIn(selected, m))}
              >
                {m}
              </MenuOption>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// Menu primitives

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return desktop;
}

function FilterMenu({
  label,
  value,
  active = false,
  multi = false,
  wide = false,
  children,
}: {
  label: string;
  value: string;
  active?: boolean;
  multi?: boolean;
  wide?: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const desktop = useIsDesktop();
  const panelId = useId();
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);

  const panelBody = (
    <div
      ref={panelRef}
      id={panelId}
      role="dialog"
      aria-label={label}
      className={
        desktop
          ? `absolute left-0 top-full z-50 mt-1.5 max-h-[min(70vh,520px)] overflow-y-auto overscroll-contain rounded-xl bg-[var(--bg-secondary)] p-1.5 shadow-[0_0_0_1px_var(--border-primary),0_12px_32px_rgba(0,0,0,0.35)] ${wide ? "w-80" : "w-56"}`
          : "absolute inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] max-h-[70dvh] overflow-y-auto overscroll-contain rounded-2xl bg-[var(--bg-secondary)] p-2 shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_16px_48px_rgba(0,0,0,0.5)]"
      }
    >
      {!desktop && (
        <div className="flex items-center justify-between px-3 pb-1 pt-1">
          <span className="text-sm font-medium text-[var(--text-primary)]">
            {label}
          </span>
          {multi && (
            <button
              type="button"
              onClick={close}
              className="h-8 rounded-full px-3 text-sm font-medium text-[var(--accent-primary)]"
            >
              Done
            </button>
          )}
        </div>
      )}
      <div
        role={multi ? "group" : "radiogroup"}
        aria-label={label}
        className="flex flex-col"
      >
        {children(close)}
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${label}: ${value}`}
        className={`flex h-8 max-w-[14rem] items-center gap-1 rounded-full px-3 text-xs transition-colors ${
          active || open
            ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
            : "text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_var(--border-primary)] hover:text-[var(--text-primary)]"
        }`}
      >
        <span className="truncate">{value}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open &&
        (desktop
          ? panelBody
          : typeof document !== "undefined" &&
            createPortal(
              <div className="fixed inset-0 z-[60]" role="presentation">
                <div
                  className="absolute inset-0 bg-black/60"
                  onClick={close}
                  aria-hidden
                />
                {panelBody}
              </div>,
              document.body,
            ))}
    </div>
  );
}

function MenuOption({
  selected,
  onSelect,
  multi = false,
  dense = false,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  multi?: boolean;
  dense?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      onClick={onSelect}
      className={`flex w-full shrink-0 items-center gap-2.5 rounded-lg px-3 text-left transition-colors focus:outline-none focus-visible:bg-[var(--bg-hover)] ${
        dense
          ? "h-9 text-[15px] md:h-8 md:text-xs"
          : "h-11 text-[15px] md:h-8 md:text-xs"
      } ${
        selected && !multi
          ? "bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)] text-[var(--accent-primary)]"
          : "text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
      }`}
    >
      {multi && (
        <span
          aria-hidden
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
            selected
              ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-white"
              : "border-[var(--border-secondary)]"
          }`}
        >
          {selected && <Check className="h-3 w-3" />}
        </span>
      )}
      <span className="flex-1 truncate">{children}</span>
      {!multi && selected && <Check className="h-4 w-4 shrink-0" />}
    </button>
  );
}

export default ModelFilterBar;

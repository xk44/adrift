"use client";

/**
 * Lightbox creator actions (lib/ui/creatorActions.ts): a quick row of up to
 * four pinned actions, then one quiet list of groups whose submenus hold the
 * rest. Each submenu has its own show/hide + pin mode with a reset; the gear
 * opens Customize (quick-row order, group visibility and order). Handlers
 * live in Lightbox.
 */

import { useMemo, type ReactNode } from "react";
import { shallow } from "zustand/shallow";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  LayoutGrid,
  Loader2,
  Pin,
  PinOff,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import {
  QUICK_ROW_MAX,
  canPin,
  creatorActionLayout,
  groupActionIds,
  groupSpec,
  hiddenActionTools,
  isPinnedShown,
  specOf,
  type CreatorActionContext,
  type CreatorActionId,
  type CreatorActionPrefs,
  type CreatorGroupId,
  type CreatorGroupLayout,
} from "@/lib/ui/creatorActions";
import type {
  InlineRun,
  LightboxMediaKind,
  LightboxTool,
} from "@/lib/ui/lightboxTools";
import {
  selectCreatorActionPrefs,
  useCreatorActionsStore,
} from "@/store/creatorActionsStore";
import { creatorIcon } from "@/components/creatorActionIcons";
import { UpscaleModelPicker } from "@/components/upscale/UpscaleModelPicker";
import type { UpscaleContent } from "@/lib/upscale/upscalerCatalog";

export interface LightboxActionsProps {
  media: LightboxMediaKind;
  /** What the upscaler sees (photo / illustration / …): picks the default model. */
  upscaleContent?: UpscaleContent;
  external: boolean;
  /** Open item has a still image URL (Use as image / style). */
  hasImageUrl: boolean;
  canQuickEdit: boolean;
  quickEditOpen: boolean;
  /** Clip the video editor can open (Retake). */
  canRetake: boolean;
  isRunning: (run: InlineRun) => boolean;
  onRun: (run: InlineRun) => void;
  /** 3D & layers: open that Tools card with this item. */
  onOpenTool: (toolKey: string) => void;
  rerunSheetOpen: boolean;
  /** Rendered under the quick row, or inside Vary while it is open. */
  rerunSheet: ReactNode;
  openGroup: CreatorGroupId | null;
  onOpenGroup: (group: CreatorGroupId | null) => void;
  /** The open group's submenu is in show/hide mode. */
  groupEditing: boolean;
  onGroupEditing: (editing: boolean) => void;
  customizeOpen: boolean;
  onToggleCustomize: () => void;
  toolsOpen: boolean;
  onToggleTools: () => void;
  /** Tools panel; `hiddenTools` lists the actions the user hid. */
  renderToolsPanel: (hiddenTools: LightboxTool[]) => ReactNode;
}

const ICON = "h-3.5 w-3.5";
const ROW =
  "flex h-10 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-xs transition-colors md:h-8";
const ROW_IDLE =
  "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]";
const ROW_ACTIVE = "bg-[var(--bg-hover)] text-[var(--text-primary)]";
const SMALL_BUTTON =
  "flex h-10 items-center gap-1 rounded-lg px-2 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:h-7";
const ICON_BUTTON =
  "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-30 md:h-7 md:w-7";

interface ActionState {
  disabled: boolean;
  loading: boolean;
  expanded?: boolean;
  title: string;
  onClick: () => void;
}

function actionState(
  id: CreatorActionId,
  p: LightboxActionsProps,
): ActionState {
  const spec = specOf(id);
  const run = spec.run;
  const blocked =
    (spec.needs === "imageUrl" && !p.hasImageUrl) ||
    (spec.needs === "quickEdit" && !p.canQuickEdit);
  const title = blocked
    ? spec.needs === "quickEdit"
      ? "Quick edit works on still images"
      : `${spec.name}: needs a still image`
    : `${spec.name}: ${spec.hint}${spec.kbd ? ` (${spec.kbd})` : ""}`;
  return {
    disabled: blocked,
    loading: run.kind !== "open_tool" && p.isRunning(run),
    expanded:
      id === "quick_edit"
        ? p.quickEditOpen
        : id === "rerun_tweak"
          ? p.rerunSheetOpen
          : undefined,
    title,
    onClick: () =>
      run.kind === "open_tool" ? p.onOpenTool(run.toolKey) : p.onRun(run),
  };
}

// Keep RerunSheet's outside-click dismiss from firing on its own trigger
// (which would close then reopen).
const keepSheet = (id: CreatorActionId) =>
  id === "rerun_tweak"
    ? (e: React.PointerEvent) => e.stopPropagation()
    : undefined;

export function LightboxActions(props: LightboxActionsProps) {
  const {
    media,
    external,
    canRetake,
    customizeOpen,
    onToggleCustomize,
    toolsOpen,
    onToggleTools,
    openGroup,
  } = props;
  const prefs = useCreatorActionsStore(selectCreatorActionPrefs, shallow);
  const ctx: CreatorActionContext = { media, external, canRetake };
  const layout = creatorActionLayout(prefs, ctx);
  const hiddenKey = layout.hidden.join(",");
  const hiddenTools = useMemo(
    () => hiddenActionTools(layout.hidden),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by ids
    [hiddenKey],
  );
  const varyOpen = openGroup === "vary" && !props.groupEditing;

  return (
    <section
      aria-label="Creator actions"
      data-lightbox-section="Creator actions"
      data-creator-actions
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium text-[var(--text-muted)]">
          Create
        </h3>
        <button
          type="button"
          onClick={onToggleCustomize}
          aria-expanded={customizeOpen}
          aria-controls={
            customizeOpen ? "lightbox-customize-actions" : undefined
          }
          aria-label="Customize actions"
          title="Customize actions: quick row, groups and their order"
          className={`-mr-1.5 ${ICON_BUTTON} ${
            customizeOpen
              ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
              : ""
          }`}
        >
          <Settings2 className={ICON} />
        </button>
      </div>

      {customizeOpen && (
        <CreatorActionsCustomize ctx={ctx} onDone={onToggleCustomize} />
      )}

      {layout.quick.length > 0 && (
        <div
          role="group"
          aria-label="Quick actions"
          data-creator-quick
          className="flex gap-1.5"
        >
          {layout.quick.map((id) => (
            <QuickButton key={id} id={id} state={actionState(id, props)} />
          ))}
        </div>
      )}

      {props.rerunSheetOpen && !varyOpen && (
        <div className="mt-2">{props.rerunSheet}</div>
      )}

      <div
        className={`space-y-0.5 ${layout.quick.length > 0 ? "mt-3" : ""}`}
        data-creator-groups
      >
        {layout.groups.map((g) => (
          <CreatorGroup
            key={g.id}
            group={g}
            prefs={prefs}
            ctx={ctx}
            p={props}
          />
        ))}
        <button
          type="button"
          onClick={onToggleTools}
          aria-expanded={toolsOpen}
          aria-keyshortcuts="T"
          aria-label="All tools"
          title="All tools for this item (T)"
          className={`${ROW} ${toolsOpen ? ROW_ACTIVE : ROW_IDLE}`}
        >
          <LayoutGrid className={`${ICON} shrink-0 opacity-80`} />
          <span className="flex-1 truncate text-[var(--text-primary)]">
            All tools
          </span>
          <kbd className="hidden rounded border border-[var(--border-primary)] px-1 font-sans text-[10px] leading-4 text-[var(--text-muted)] md:inline">
            T
          </kbd>
          <ChevronDown
            className={`${ICON} shrink-0 text-[var(--text-muted)] transition-transform ${toolsOpen ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {layout.hidden.length > 0 && !customizeOpen && (
        <p className="mt-2 px-2 text-[11px] text-[var(--text-muted)]">
          {layout.hidden.length} hidden ·{" "}
          {toolsOpen ? "listed first in Tools" : "find them in All tools"}
        </p>
      )}

      {toolsOpen && (
        <div className="mt-2">{props.renderToolsPanel(hiddenTools)}</div>
      )}
    </section>
  );
}

function QuickButton({
  id,
  state,
}: {
  id: CreatorActionId;
  state: ActionState;
}) {
  const spec = specOf(id);
  const Icon = creatorIcon(spec.icon);
  return (
    <button
      type="button"
      onClick={state.onClick}
      onPointerDown={keepSheet(id)}
      disabled={state.disabled || state.loading}
      aria-label={spec.name}
      aria-expanded={state.expanded}
      aria-keyshortcuts={spec.kbd}
      title={state.title}
      data-creator-action={id}
      className={`flex h-14 min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[11px] transition-[color,background-color,transform] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 md:h-12 ${
        state.expanded
          ? "bg-[var(--bg-hover)] text-[var(--text-primary)] ring-1 ring-inset ring-[var(--border-secondary)]"
          : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      }`}
    >
      {state.loading ? (
        <Loader2 className={`${ICON} shrink-0 animate-spin`} />
      ) : (
        <Icon className={`${ICON} shrink-0 opacity-80`} />
      )}
      <span className="max-w-full truncate">{spec.quick}</span>
    </button>
  );
}

function CreatorGroup({
  group,
  prefs,
  ctx,
  p,
}: {
  group: CreatorGroupLayout;
  prefs: CreatorActionPrefs;
  ctx: CreatorActionContext;
  p: LightboxActionsProps;
}) {
  const spec = groupSpec(group.id);
  const Icon = creatorIcon(spec.icon);
  const open = p.openGroup === group.id;
  const editing = open && p.groupEditing;
  const bodyId = `creator-group-${group.id}`;
  const summary =
    group.actions.length > 0
      ? group.actions.map((id) => specOf(id).label).join(" · ")
      : "All hidden";

  return (
    <div data-creator-group={group.id}>
      <button
        type="button"
        onClick={() => p.onOpenGroup(open ? null : group.id)}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        aria-label={spec.label}
        title={`${spec.label}: ${summary}`}
        className={`${ROW} ${open ? ROW_ACTIVE : ROW_IDLE}`}
      >
        <Icon className={`${ICON} shrink-0 opacity-80`} />
        <span className="shrink-0 text-[var(--text-primary)]">
          {spec.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-[11px] text-[var(--text-muted)]">
          {open ? "" : summary}
        </span>
        <ChevronDown
          className={`${ICON} shrink-0 text-[var(--text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          id={bodyId}
          role="group"
          aria-label={`${spec.label} actions`}
          className="mb-1 ml-[0.9375rem] border-l border-[var(--border-primary)] py-1 pl-2"
        >
          {editing ? (
            <GroupEditor group={group} prefs={prefs} ctx={ctx} p={p} />
          ) : (
            <>
              {group.actions.map((id) => (
                <GroupItem key={id} id={id} state={actionState(id, p)} />
              ))}
              {group.id === "upscale" &&
                p.media === "image" &&
                group.actions.some((id) => id.startsWith("upscale_")) && (
                <div className="px-2 py-1 empty:hidden">
                  <UpscaleModelPicker
                    inline
                    content={p.upscaleContent ?? "photo"}
                  />
                </div>
              )}
              {group.id === "vary" && p.rerunSheetOpen && (
                <div className="py-1">{p.rerunSheet}</div>
              )}
              <div className="flex items-center gap-1 pt-0.5">
                <button
                  type="button"
                  onClick={() => p.onGroupEditing(true)}
                  aria-label={`Show or hide ${spec.label} actions`}
                  title={`Show, hide or pin ${spec.label} actions`}
                  className={SMALL_BUTTON}
                >
                  <SlidersHorizontal className="h-3 w-3" /> Show or hide
                </button>
                {group.hidden.length > 0 && (
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {group.hidden.length} hidden
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function GroupItem({ id, state }: { id: CreatorActionId; state: ActionState }) {
  const spec = specOf(id);
  const Icon = creatorIcon(spec.icon);
  return (
    <button
      type="button"
      onClick={state.onClick}
      onPointerDown={keepSheet(id)}
      disabled={state.disabled || state.loading}
      aria-label={spec.name}
      aria-expanded={state.expanded}
      aria-keyshortcuts={spec.kbd}
      title={state.title}
      data-creator-action={id}
      className={`${ROW} disabled:cursor-not-allowed disabled:opacity-50 ${state.expanded ? ROW_ACTIVE : ROW_IDLE}`}
    >
      {state.loading ? (
        <Loader2 className={`${ICON} shrink-0 animate-spin`} />
      ) : (
        <Icon className={`${ICON} shrink-0 opacity-80`} />
      )}
      <span className="shrink-0 text-[var(--text-primary)]">{spec.label}</span>
      <span className="hidden min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)] sm:block">
        {spec.hint}
      </span>
      {spec.kbd && (
        <kbd className="ml-auto hidden rounded border border-[var(--border-primary)] px-1 font-sans text-[10px] leading-4 text-[var(--text-muted)] md:inline">
          {spec.kbd}
        </kbd>
      )}
    </button>
  );
}

// Submenu show/hide mode: a checkbox per action, a pin toggle for the quick
// row, Reset to defaults and Done.
function GroupEditor({
  group,
  prefs,
  ctx,
  p,
}: {
  group: CreatorGroupLayout;
  prefs: CreatorActionPrefs;
  ctx: CreatorActionContext;
  p: LightboxActionsProps;
}) {
  const spec = groupSpec(group.id);
  const { setActionHidden, setPinned, resetGroup } =
    useCreatorActionsStore.getState();
  const ids = groupActionIds(group.id).filter(
    (id) => group.actions.includes(id) || group.hidden.includes(id),
  );
  return (
    <div data-creator-group-editor={group.id}>
      <ul>
        {ids.map((id) => {
          const a = specOf(id);
          const Icon = creatorIcon(a.icon);
          const shown = !prefs.hidden.includes(id);
          const pinned = isPinnedShown(prefs, id);
          const pinnable = canPin(prefs, id, ctx);
          return (
            <li
              key={id}
              data-customize-action={id}
              className="flex items-center gap-0.5"
            >
              <label className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 md:min-h-8">
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={(e) => setActionHidden(id, !e.target.checked)}
                  aria-label={`Show ${a.name}`}
                  className="h-4 w-4 shrink-0 accent-[var(--accent-primary)]"
                />
                <Icon className={`${ICON} shrink-0 text-[var(--text-muted)]`} />
                <span
                  className={`truncate text-xs ${shown ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}
                >
                  {a.label}
                </span>
              </label>
              <button
                type="button"
                onClick={() => {
                  // Pinning a hidden action shows it, or the pin does nothing.
                  if (!pinned && !shown) setActionHidden(id, false);
                  setPinned(id, !pinned);
                }}
                disabled={!pinnable}
                aria-pressed={pinned}
                aria-label={`Pin ${a.name} to the quick row`}
                title={
                  pinned
                    ? `Unpin ${a.name} from the quick row`
                    : pinnable
                      ? `Pin ${a.name} to the quick row`
                      : `Quick row is full (${QUICK_ROW_MAX}). Unpin one first.`
                }
                className={`${ICON_BUTTON} ${pinned ? "text-[var(--text-primary)]" : ""}`}
              >
                <Pin
                  className={`${ICON} ${pinned ? "fill-current" : "opacity-60"}`}
                />
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-1 pt-1">
        <button
          type="button"
          onClick={() => resetGroup(group.id)}
          aria-label={`Reset ${spec.label} to defaults`}
          title={`Reset ${spec.label}: show every action, default pins`}
          className={SMALL_BUTTON}
        >
          <RotateCcw className="h-3 w-3" /> Reset to defaults
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => p.onGroupEditing(false)}
          aria-label={`Done editing ${spec.label}`}
          title="Back to the menu"
          className="flex h-10 items-center rounded-lg bg-[var(--bg-secondary)] px-3 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] md:h-7"
        >
          Done
        </button>
      </div>
    </div>
  );
}

// Customize (gear): quick-row order, group visibility and order, reset all.

export function CreatorActionsCustomize({
  ctx,
  onDone,
}: {
  ctx: CreatorActionContext;
  onDone: () => void;
}) {
  const prefs = useCreatorActionsStore(selectCreatorActionPrefs, shallow);
  const { setGroupHidden, setPinned, movePinned, moveGroup, reset } =
    useCreatorActionsStore.getState();
  const quick = creatorActionLayout(prefs, ctx).quick;

  return (
    <div
      id="lightbox-customize-actions"
      role="group"
      aria-label="Customize actions"
      data-creator-customize
      className="mb-3 space-y-3 rounded-xl border border-[var(--border-primary)] bg-[var(--bg-primary)] p-2"
    >
      <div className="flex items-center gap-1 pl-1">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--text-primary)]">
          Customize actions
        </span>
        <button
          type="button"
          onClick={reset}
          aria-label="Reset actions to default"
          title="Reset everything: default quick row, every group and action shown"
          className={SMALL_BUTTON}
        >
          <RotateCcw className="h-3 w-3" /> Reset all
        </button>
        <button
          type="button"
          onClick={onDone}
          aria-label="Done customizing"
          title="Close Customize"
          className="flex h-10 items-center rounded-lg bg-[var(--bg-secondary)] px-3 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] md:h-7"
        >
          Done
        </button>
      </div>

      <div data-customize-section="quick">
        <p className="px-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
          Quick row · up to {QUICK_ROW_MAX}
        </p>
        {quick.length === 0 ? (
          <p className="px-1 text-[11px] text-[var(--text-muted)]">
            Empty. Pin actions from a group&apos;s Show or hide.
          </p>
        ) : (
          <ul>
            {quick.map((id, i) => {
              const a = specOf(id);
              const Icon = creatorIcon(a.icon);
              return (
                <li
                  key={id}
                  data-customize-pin={id}
                  className="flex items-center gap-0.5"
                >
                  <span className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-1 md:min-h-8">
                    <Icon
                      className={`${ICON} shrink-0 text-[var(--text-muted)]`}
                    />
                    <span className="truncate text-xs text-[var(--text-primary)]">
                      {a.name}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => movePinned(id, -1, ctx)}
                    disabled={i === 0}
                    aria-label={`Move ${a.name} earlier`}
                    title={`Move ${a.name} earlier`}
                    className={ICON_BUTTON}
                  >
                    <ArrowUp className={ICON} />
                  </button>
                  <button
                    type="button"
                    onClick={() => movePinned(id, 1, ctx)}
                    disabled={i === quick.length - 1}
                    aria-label={`Move ${a.name} later`}
                    title={`Move ${a.name} later`}
                    className={ICON_BUTTON}
                  >
                    <ArrowDown className={ICON} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setPinned(id, false)}
                    aria-label={`Unpin ${a.name}`}
                    title={`Unpin ${a.name}: it stays in its group`}
                    className={ICON_BUTTON}
                  >
                    <PinOff className={ICON} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div data-customize-section="groups">
        <p className="px-1 pb-1 text-[11px] font-medium text-[var(--text-muted)]">
          Groups
        </p>
        <ul>
          {prefs.groupOrder.map((g, i) => {
            const spec = groupSpec(g);
            const Icon = creatorIcon(spec.icon);
            const shown = !prefs.hiddenGroups.includes(g);
            return (
              <li
                key={g}
                data-customize-group={g}
                className="flex items-center gap-0.5"
              >
                <label className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 md:min-h-8">
                  <input
                    type="checkbox"
                    checked={shown}
                    onChange={(e) => setGroupHidden(g, !e.target.checked)}
                    aria-label={`Show ${spec.label}`}
                    className="h-4 w-4 shrink-0 accent-[var(--accent-primary)]"
                  />
                  <Icon
                    className={`${ICON} shrink-0 text-[var(--text-muted)]`}
                  />
                  <span
                    className={`truncate text-xs ${shown ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}`}
                  >
                    {spec.label}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => moveGroup(g, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${spec.label} up`}
                  title={`Move ${spec.label} up`}
                  className={ICON_BUTTON}
                >
                  <ArrowUp className={ICON} />
                </button>
                <button
                  type="button"
                  onClick={() => moveGroup(g, 1)}
                  disabled={i === prefs.groupOrder.length - 1}
                  aria-label={`Move ${spec.label} down`}
                  title={`Move ${spec.label} down`}
                  className={ICON_BUTTON}
                >
                  <ArrowDown className={ICON} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="px-1 text-[11px] leading-snug text-[var(--text-muted)]">
        Single actions: open a group, then Show or hide. Hidden actions stay in
        All tools (T); gallery hover buttons follow these settings.
      </p>
    </div>
  );
}

export default LightboxActions;

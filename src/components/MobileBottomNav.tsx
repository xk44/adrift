"use client";

import { useEffect, useRef, useState } from "react";
import {
  selectQueuedJobCount,
  selectRunningJobCount,
  useGenerationStore,
  useUIStore,
} from "@/store";
import type { NavKey } from "@/types";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useProfileIdentity } from "@/lib/ui/profileIdentity";
import {
  Menu,
  Moon,
  Sun,
  X,
  ChevronRight,
  ListChecks,
  User as UserIcon,
} from "lucide-react";
import { useQueueDrawerStore } from "@/store/queueDrawerStore";
import {
  connectionDotClass,
  connectionLabel,
  connectionTitle,
  deriveConnectionState,
} from "@/lib/ui/connectionState";
import {
  destinationForNav,
  isDestinationActive,
  mobileFooterDestinations,
  mobileMenuDestinations,
  mobileTabDestinations,
  navigateToDestination,
  type NavDestination,
} from "@/lib/ui/navRegistry";

/** Bottom tab bar: Menu first, then the primary destinations from the registry. */
const primaryTabs = mobileTabDestinations();

/** Full-height Menu panel rows (everything that is not a primary tab). */
const moreItems = mobileMenuDestinations();

/** Paired half-width tiles at the bottom of the Menu panel. */
const footerItems = mobileFooterDestinations();

/** Which Menu row (if any) owns the current page. Exported for tests. */
export function menuItemForNav(nav: NavKey): NavKey | null {
  const owner = destinationForNav(nav);
  if (!owner || owner.mobileTab) return null;
  return owner.key;
}

export function MobileBottomNav() {
  const identity = useProfileIdentity();
  const [moreOpen, setMoreOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // Tab stays in the panel, focus returns to the Menu tab on close. The
  // effect below picks the first row, so the hook does not move focus.
  // Escape goes through the dialog stack (topmost only, marked handled) so
  // the page's global Escape doesn't also close settings/lightbox below.
  useDialogFocus(panelRef, moreOpen, {
    initialFocus: "none",
    onEscape: () => setMoreOpen(false),
  });

  const queuedJobCount = useGenerationStore(selectQueuedJobCount);
  const runningJobCount = useGenerationStore(selectRunningJobCount);
  const wsConnected = useGenerationStore((s) => s.wsConnected);
  const wsReconnecting = useGenerationStore((s) => s.wsReconnecting);
  const comfyReachable = useGenerationStore((s) => s.comfyReachable);
  const queueRemaining = useGenerationStore((s) => s.queueRemaining);
  const activeNav = useUIStore((s) => s.activeNav);
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const setStylesHubTab = useUIStore((s) => s.setStylesHubTab);
  const theme = useUIStore((s) => s.hostTheme ?? s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);

  const createQueueCount = queuedJobCount + runningJobCount;
  const openQueueDrawer = useQueueDrawerStore((s) => s.setOpen);
  const connState = deriveConnectionState({
    wsConnected,
    comfyReachable,
    wsReconnecting,
  });

  // Focus moves into the Menu panel on open
  useEffect(() => {
    if (!moreOpen) return;
    panelRef.current
      ?.querySelector<HTMLButtonElement>("button[data-menu-row]")
      ?.focus({ preventScroll: true });
  }, [moreOpen]);

  const handleTabPress = (key: NavKey) => {
    navigateToDestination(key, { setActiveNav, setStylesHubTab });
    setMoreOpen(false);
  };

  const menuOwner = menuItemForNav(activeNav);

  return (
    <div className="md:hidden" role="navigation" aria-label="Mobile navigation">
      {/* Menu panel — full height above the tab bar, card rows */}
      {moreOpen && (
        <div
          ref={panelRef}
          id="mobile-menu-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          className="fixed inset-x-0 top-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 flex flex-col bg-[color-mix(in_srgb,var(--bg-primary)_94%,transparent)] backdrop-blur-xl animate-fade-in"
        >
          <div className="microScrollbar flex-1 overflow-y-auto overscroll-contain px-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-3">
            {/* Top row: avatar (opens Profile), connection, queue, theme.
                No name label, same as the desktop sidebar. */}
            <div className="flex items-center gap-3 px-2 pb-3 animate-sheet-up">
              <button
                type="button"
                onClick={() => handleTabPress("profile")}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-[background-color,transform] duration-150 hover:bg-[var(--bg-hover)] active:scale-[0.96]"
                aria-label="Open profile page"
              >
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bg-tertiary)] text-sm font-medium text-[var(--text-primary)]"
                  aria-hidden
                >
                  {identity.initial ?? <UserIcon className="h-4 w-4" />}
                </span>
              </button>
              <span
                className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-[var(--text-secondary)]"
                title={connectionTitle(connState, queueRemaining)}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${connectionDotClass(connState)}`}
                />
                <span className="truncate">
                  {connectionLabel(connState, queueRemaining)}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setMoreOpen(false);
                  openQueueDrawer(true);
                }}
                className="relative flex h-10 w-10 items-center justify-center rounded-full text-[var(--text-secondary)] transition-[color,background-color,transform] duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] active:scale-[0.96]"
                aria-label={
                  createQueueCount > 0
                    ? `Job queue: ${createQueueCount} active`
                    : "Job queue"
                }
                aria-haspopup="dialog"
                title="Job queue"
              >
                <ListChecks className="h-5 w-5" />
                {createQueueCount > 0 && (
                  <span
                    className="absolute top-0.5 right-0.5 min-w-[16px] h-4 flex items-center justify-center px-1 text-[9px] font-bold bg-[var(--accent-primary)] text-white rounded-full tabular-nums"
                    aria-hidden
                  >
                    {createQueueCount > 99 ? "99+" : createQueueCount}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={toggleTheme}
                className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--text-secondary)] transition-[color,background-color,transform] duration-150 hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] active:scale-[0.96]"
                aria-label={
                  theme === "dark"
                    ? "Switch to light mode"
                    : "Switch to dark mode"
                }
                title={theme === "dark" ? "Light mode" : "Dark mode"}
              >
                {theme === "dark" ? (
                  <Sun className="h-5 w-5" />
                ) : (
                  <Moon className="h-5 w-5" />
                )}
              </button>
            </div>

            <div className="space-y-2">
              {moreItems.map((item, i) => (
                <MenuRow
                  key={item.key}
                  item={item}
                  isActive={menuOwner === item.key}
                  onPress={() => handleTabPress(item.key)}
                  index={i}
                />
              ))}
              <div className="grid grid-cols-2 gap-2">
                {footerItems.map((item, i) => (
                  <MenuRow
                    key={item.key}
                    item={item}
                    isActive={menuOwner === item.key}
                    onPress={() => handleTabPress(item.key)}
                    index={moreItems.length + i}
                    compact
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="fixed bottom-0 inset-x-0 z-40 bg-[color-mix(in_srgb,var(--bg-primary)_88%,transparent)] backdrop-blur-xl shadow-[0_-1px_0_0_var(--border-primary)] pb-[env(safe-area-inset-bottom)]">
        <div className="flex h-14">
          {/* Menu tab — icon cross-fades Menu ↔ X */}
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-label={moreOpen ? "Close menu" : "Open menu"}
            aria-expanded={moreOpen}
            aria-controls="mobile-menu-panel"
            className={`flex-1 flex flex-col items-center justify-center gap-1 transition-[color,transform] duration-150 active:scale-[0.96] ${
              menuOwner && !moreOpen
                ? "text-[var(--text-primary)]"
                : "text-[var(--text-tertiary)]"
            }`}
          >
            <span className="relative h-6 w-6">
              <Menu
                className={`absolute inset-0 h-6 w-6 transition-[opacity,transform,filter] duration-200 [transition-timing-function:var(--ease-out)] ${
                  moreOpen
                    ? "opacity-0 scale-[0.25] blur-[4px]"
                    : "opacity-100 scale-100 blur-0"
                }`}
                aria-hidden
              />
              <X
                className={`absolute inset-0 h-6 w-6 transition-[opacity,transform,filter] duration-200 [transition-timing-function:var(--ease-out)] ${
                  moreOpen
                    ? "opacity-100 scale-100 blur-0"
                    : "opacity-0 scale-[0.25] blur-[4px]"
                }`}
                aria-hidden
              />
            </span>
            <span className="text-[11px] font-medium leading-none">Menu</span>
          </button>

          {primaryTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = isDestinationActive(tab, activeNav);
            const badgeCount = tab.key === "create" ? createQueueCount : 0;

            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => handleTabPress(tab.key)}
                aria-label={tab.label}
                aria-current={isActive ? "page" : undefined}
                className={`flex-1 flex flex-col items-center justify-center gap-1 transition-[color,transform] duration-150 active:scale-[0.96] ${
                  isActive
                    ? "text-splash"
                    : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                }`}
              >
                <span className="relative">
                  <Icon className="h-6 w-6" />
                  {badgeCount > 0 && (
                    <span className="absolute -top-1 -right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-splash px-1 text-[9px] font-bold tabular-nums text-white shadow-[0_0_0_2px_var(--bg-primary)]">
                      {badgeCount > 99 ? "99+" : badgeCount}
                    </span>
                  )}
                </span>
                <span className="text-[11px] font-medium leading-none">
                  {tab.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MenuRow({
  item,
  isActive,
  onPress,
  index,
  compact = false,
}: {
  item: Pick<NavDestination, "key" | "label" | "icon">;
  isActive: boolean;
  onPress: () => void;
  index: number;
  compact?: boolean;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      data-menu-row
      onClick={onPress}
      aria-current={isActive ? "page" : undefined}
      style={{ animationDelay: `${Math.min(index, 10) * 18}ms` }}
      className={`group flex w-full items-center gap-3.5 rounded-2xl px-4 h-14 text-left text-[15px] font-medium animate-sheet-up [animation-fill-mode:both] transition-[background-color,color,transform] duration-150 active:scale-[0.98] shadow-[inset_0_0_0_1px_var(--border-primary)] ${
        isActive
          ? "bg-[var(--bg-secondary)] text-splash"
          : "bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
      }`}
    >
      <Icon className="h-5 w-5 shrink-0 opacity-90" />
      <span className="flex-1 truncate">{item.label}</span>
      {!compact && (
        <ChevronRight
          className="h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform duration-150 group-hover:translate-x-0.5"
          aria-hidden
        />
      )}
    </button>
  );
}

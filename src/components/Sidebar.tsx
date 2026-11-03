"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  useUIStore,
  useGenerationStore,
  selectErrorCount,
  selectQueuedJobCount,
  selectRunningJobCount,
} from "@/store";
import { showToast } from "@/components/Toast";
import { nextTabIndex } from "@/components/ui/Tabs";
import { useProfileIdentity } from "@/lib/ui/profileIdentity";
import { User as UserIcon } from "lucide-react";
import type { NavKey } from "@/types";
import {
  Moon,
  Sun,
  Bug,
  LogOut,
  MoreHorizontal,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCw,
  Copy,
  Trash2,
  ListChecks,
  Compass,
  MapPin,
} from "lucide-react";
import { startTour } from "@/store/tourStore";
import { startCurrentPageTour } from "@/components/tour/tourEntry";
import { AdriftMark } from "./AdriftMark";
import { QueueDrawer } from "./QueueDrawer";
import { useQueueDrawerStore } from "@/store/queueDrawerStore";
import { hasQueueActivity } from "@/lib/queue/queueEntries";
import {
  connectionDotClass,
  connectionLabel,
  connectionTitle,
  deriveConnectionState,
  errorBadgeText,
  formatErrorReport,
} from "@/lib/ui/connectionState";
import {
  isDestinationActive,
  navDestinationsIn,
  navigateToDestination,
  type NavDestination,
} from "@/lib/ui/navRegistry";

const primaryItems = navDestinationsIn("primary");
const moreItems = navDestinationsIn("more");
const accountItems = navDestinationsIn("account");

/** Remembers whether the sidebar "More" group is open (per browser). */
const MORE_OPEN_KEY = "adrift.sidebar.moreOpen";

/** Nav icon size, matched to the denser rows. */
const NAV_ICON = "w-[18px] h-[18px] shrink-0";

/** Close a popover on outside mousedown or Escape while it is open. */
function useDismissable(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  setOpen: (open: boolean) => void,
  onEscape?: () => void,
) {
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Handled here: the page's global Escape must not also close a
      // layer underneath (settings, lightbox).
      e.preventDefault();
      setOpen(false);
      onEscape?.();
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, ref, setOpen, onEscape]);
}

/** Enabled menu items of an open role="menu", in DOM order. */
export function menuItemsIn(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'),
  );
}

export function Sidebar() {
  const identity = useProfileIdentity();
  const activeNav = useUIStore((s) => s.activeNav);
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const setStylesHubTab = useUIStore((s) => s.setStylesHubTab);
  const theme = useUIStore((s) => s.hostTheme ?? s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const queuedJobCount = useGenerationStore(selectQueuedJobCount);
  const runningJobCount = useGenerationStore(selectRunningJobCount);
  const activeJobCount = queuedJobCount + runningJobCount;
  const queueDrawerOpen = useQueueDrawerStore((s) => s.open);
  const toggleQueueDrawer = useQueueDrawerStore((s) => s.toggle);
  // Idle but this session has finished/failed jobs: keep a quiet opener.
  const hasRecentJobs = useGenerationStore((s) => hasQueueActivity(s.runs));

  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  // Sign Out only exists when sign-in is on (ADMIN_API_KEY set); checked the
  // first time the menu opens.
  const [signInEnabled, setSignInEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!accountMenuOpen || signInEnabled !== null) return;
    let alive = true;
    fetch("/api/auth/devices", { cache: "no-store" })
      .then(async (res) => {
        const data = res.ok
          ? ((await res.json().catch(() => null)) as {
              enabled?: boolean;
            } | null)
          : null;
        if (alive) setSignInEnabled(Boolean(data?.enabled));
      })
      .catch(() => {
        if (alive) setSignInEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, [accountMenuOpen, signInEnabled]);
  const signOut = useCallback(async () => {
    setAccountMenuOpen(false);
    try {
      const res = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "X-Requested-With": "XMLHttpRequest" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.reload();
    } catch {
      showToast("Couldn't sign out. Try again.", "error");
    }
  }, []);

  // Close account menu on outside click / Escape
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const accountMenuListRef = useRef<HTMLDivElement>(null);
  const focusAccountTrigger = useCallback(
    () => accountTriggerRef.current?.focus(),
    [],
  );
  useDismissable(
    accountMenuOpen,
    accountMenuRef,
    setAccountMenuOpen,
    focusAccountTrigger,
  );
  // Menu button pattern: focus moves to the first item on open; arrows,
  // Home and End rove between items; Tab leaves and closes.
  useEffect(() => {
    if (!accountMenuOpen) return;
    menuItemsIn(accountMenuListRef.current)[0]?.focus();
  }, [accountMenuOpen]);
  const onAccountMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      setAccountMenuOpen(false);
      return;
    }
    const items = menuItemsIn(e.currentTarget);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = nextTabIndex(
      e.key,
      current === -1 ? (e.key === "ArrowUp" ? 0 : -1) : current,
      items.map(() => false),
    );
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  };

  // "More" group: closed by default so first-time users see a short list.
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(MORE_OPEN_KEY) === "1") setMoreOpen(true);
    } catch {
      /* storage blocked — stay closed */
    }
  }, []);
  const toggleMore = () => {
    const next = !moreOpen;
    setMoreOpen(next);
    try {
      window.localStorage.setItem(MORE_OPEN_KEY, next ? "1" : "0");
    } catch {
      /* storage blocked — still toggles for this visit */
    }
  };
  // Landing on a page inside "More" (palette, shortcut, link) opens the
  // group so you can see where you are; you can still fold it again.
  const moreHasActive = moreItems.some((d) =>
    isDestinationActive(d, activeNav),
  );
  useEffect(() => {
    if (moreHasActive) setMoreOpen(true);
  }, [moreHasActive]);
  const goTo = (key: NavKey) =>
    navigateToDestination(key, { setActiveNav, setStylesHubTab });

  // Determine if any job is currently running for splash overlay
  const hasRunningJobs = activeJobCount > 0;

  // Info pages that live in the account menu still light up its trigger
  const accountMenuActive = accountItems.some((d) =>
    isDestinationActive(d, activeNav),
  );

  return (
    <aside
      className={`glass-surface relative h-full hidden md:flex flex-col bg-transparent transition-[width] duration-200 ease-out ${
        sidebarCollapsed ? "w-14" : "w-48"
      }`}
    >
      {/* Header: wordmark + collapse toggle on one row; the collapsed rail
          stacks the mark above the expand toggle. */}
      <div
        className={`relative pt-4 pb-1 ${
          sidebarCollapsed
            ? "px-2 flex flex-col items-center gap-2"
            : "pl-4 pr-2 flex items-center gap-1"
        }`}
      >
        {sidebarCollapsed ? (
          <AdriftMark
            title="Adrift"
            className="w-7 h-7 text-[var(--accent-primary)]"
          />
        ) : (
          <span className="flex-1 min-w-0 flex items-center gap-2 text-base font-semibold tracking-tight text-[var(--text-primary)]">
            <AdriftMark className="w-6 h-6 text-[var(--accent-primary)]" />
            Adrift
          </span>
        )}
        <button
          type="button"
          onClick={toggleSidebar}
          className={`flex items-center justify-center w-8 h-8 shrink-0 rounded-full text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors ${
            sidebarCollapsed ? "" : "order-last"
          }`}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse to icons"}
          data-testid="sidebar-toggle"
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className="w-4 h-4" />
          ) : (
            <PanelLeftClose className="w-4 h-4" />
          )}
        </button>
        {/* Running job count badge on logo area; opens the queue drawer */}
        {hasRunningJobs ? (
          <button
            type="button"
            onClick={toggleQueueDrawer}
            className={`${sidebarCollapsed ? "absolute top-2 right-1" : ""} min-w-[18px] h-[18px] flex items-center justify-center px-1 text-[10px] font-bold bg-[var(--accent-primary)] text-white rounded-full tabular-nums shadow-[0_0_8px_var(--accent-primary)] hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)]`}
            aria-label={`Job queue: ${activeJobCount} active`}
            aria-haspopup="dialog"
            aria-expanded={queueDrawerOpen}
            title="Show job queue"
            data-testid="queue-badge"
          >
            {activeJobCount > 99 ? "99+" : activeJobCount}
          </button>
        ) : (
          hasRecentJobs && (
            <button
              type="button"
              onClick={toggleQueueDrawer}
              className={`${sidebarCollapsed ? "absolute top-2 right-1" : ""} w-[18px] h-[18px] flex items-center justify-center rounded-full text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]`}
              aria-label="Job queue: recent jobs"
              aria-haspopup="dialog"
              aria-expanded={queueDrawerOpen}
              title="Show recent jobs"
              data-testid="queue-badge"
            >
              <ListChecks className="w-3.5 h-3.5" aria-hidden />
            </button>
          )
        )}
      </div>
      <QueueDrawer />

      <nav className="flex-1 overflow-y-auto py-2" aria-label="Main navigation">
        <div className="px-2 space-y-px">
          {primaryItems.map((item) => (
            <NavButton
              key={item.key}
              item={item}
              isActive={isDestinationActive(item, activeNav)}
              onClick={() => goTo(item.key)}
              collapsed={sidebarCollapsed}
              badge={item.key === "create" ? activeJobCount : undefined}
            />
          ))}
        </div>

        {/* More — everything else, folded away until asked for */}
        <div className="mt-4 px-2">
          <button
            type="button"
            onClick={toggleMore}
            className={`nav-item w-full text-[var(--text-tertiary)] ${sidebarCollapsed ? "justify-center" : ""}`}
            aria-expanded={moreOpen}
            aria-controls="sidebar-more"
            title={
              sidebarCollapsed
                ? moreOpen
                  ? "Show less"
                  : "More pages"
                : undefined
            }
            aria-label={sidebarCollapsed ? "More pages" : undefined}
          >
            {sidebarCollapsed ? (
              <MoreHorizontal className={NAV_ICON} aria-hidden />
            ) : (
              <>
                <ChevronRight
                  className={`w-4 h-4 shrink-0 transition-transform duration-150 ${moreOpen ? "rotate-90" : ""}`}
                  aria-hidden
                />
                <span className="text-xs font-medium">
                  More
                </span>
              </>
            )}
          </button>
          {moreOpen && (
            <div id="sidebar-more" className="space-y-px">
              {moreItems.map((item) => (
                <NavButton
                  key={item.key}
                  item={item}
                  isActive={isDestinationActive(item, activeNav)}
                  onClick={() => goTo(item.key)}
                  collapsed={sidebarCollapsed}
                />
              ))}
            </div>
          )}
        </div>
      </nav>

      {/* Footer — one compact row (stacked in the collapsed rail): the
          account avatar (its menu also holds Help / Updates / Report Bug /
          theme) and the ComfyUI status dot. No name label: the avatar is
          enough. */}
      <div
        className={`p-2 ${
          sidebarCollapsed
            ? "flex flex-col items-center gap-1"
            : "flex items-center justify-between gap-1"
        }`}
      >
        {/* Account: avatar-only trigger for the overflow menu */}
        <div className="relative" ref={accountMenuRef}>
          <button
            ref={accountTriggerRef}
            type="button"
            onClick={() => setAccountMenuOpen((o) => !o)}
            className={`flex items-center justify-center w-8 h-8 rounded-full hover:bg-[var(--bg-hover)] transition-colors ${accountMenuActive ? "ring-1 ring-[var(--accent-primary)]" : ""}`}
            title="Menu"
            aria-label="Menu"
            aria-expanded={accountMenuOpen}
            aria-haspopup="menu"
          >
            {/* Avatar: profile initial, or a person icon until a name is set */}
            <span
              className="flex items-center justify-center w-6 h-6 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-xs font-medium shrink-0"
              aria-hidden
            >
              {identity.initial ?? <UserIcon className="w-3.5 h-3.5" />}
            </span>
          </button>

          {accountMenuOpen && (
            <div
              className={`absolute z-50 ${sidebarCollapsed ? "left-full ml-2 bottom-0" : "left-0 bottom-full mb-1"} min-w-[200px] p-1 rounded-xl shadow-xl bg-[var(--bg-secondary)] border border-[var(--border-primary)]`}
              ref={accountMenuListRef}
              role="menu"
              aria-label="Menu"
              onKeyDown={onAccountMenuKeyDown}
            >
              {accountItems.map((item) => {
                const Icon = item.icon;
                const current = isDestinationActive(item, activeNav);
                return (
                  <button
                    key={item.key}
                    onClick={() => {
                      goTo(item.key);
                      setAccountMenuOpen(false);
                    }}
                    className={`dropdown-item w-full ${current ? "!text-[var(--accent-primary)]" : ""}`}
                    role="menuitem"
                    tabIndex={-1}
                    aria-current={current ? "page" : undefined}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
              <button
                onClick={() => {
                  setAccountMenuOpen(false);
                  startTour();
                }}
                className="dropdown-item w-full"
                role="menuitem"
                tabIndex={-1}
                data-testid="account-take-tour"
              >
                <Compass className="w-4 h-4" />
                <span>Take the tour</span>
              </button>
              <button
                onClick={() => {
                  setAccountMenuOpen(false);
                  startCurrentPageTour();
                }}
                className="dropdown-item w-full"
                role="menuitem"
                tabIndex={-1}
                data-testid="account-page-tour"
              >
                <MapPin className="w-4 h-4" />
                <span>What&apos;s on this page</span>
              </button>
              {/* Report Bug — opens the report section on Help */}
              <button
                onClick={() => {
                  setActiveNav("help");
                  setAccountMenuOpen(false);
                  window.setTimeout(() => {
                    document
                      .getElementById("report-problem")
                      ?.scrollIntoView({ block: "start" });
                  }, 50);
                }}
                className="dropdown-item w-full"
                role="menuitem"
                tabIndex={-1}
              >
                <Bug className="w-4 h-4" />
                <span>Report a problem</span>
              </button>
              <button
                onClick={() => {
                  toggleTheme();
                  setAccountMenuOpen(false);
                }}
                className="dropdown-item w-full"
                role="menuitem"
                tabIndex={-1}
                aria-label={
                  theme === "dark"
                    ? "Switch to light mode"
                    : "Switch to dark mode"
                }
              >
                {theme === "dark" ? (
                  <Sun className="w-4 h-4" />
                ) : (
                  <Moon className="w-4 h-4" />
                )}
                <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
              </button>
              {signInEnabled && (
                <>
                  <div
                    className="my-1 h-px bg-[var(--border-primary)]"
                    role="separator"
                  />
                  <button
                    onClick={() => void signOut()}
                    className="dropdown-item w-full text-[var(--error)]"
                    role="menuitem"
                    tabIndex={-1}
                  >
                    <LogOut className="w-4 h-4" />
                    <span>Sign Out</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* ComfyUI status dot */}
        <SidebarStatus
          collapsed={sidebarCollapsed}
          className={sidebarCollapsed ? "order-first" : ""}
        />
      </div>
    </aside>
  );
}

interface NavButtonProps {
  item: Pick<NavDestination, "key" | "label" | "icon">;
  isActive: boolean;
  onClick: () => void;
  collapsed: boolean;
  isBeta?: boolean;
  badge?: number;
}

function NavButton({
  item,
  isActive,
  onClick,
  collapsed,
  isBeta,
  badge,
}: NavButtonProps) {
  const Icon = item.icon;
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null);
  const showTip = (el: HTMLElement) => {
    if (!collapsed) return;
    const r = el.getBoundingClientRect();
    setTip({ top: r.top + r.height / 2, left: r.right + 8 });
  };
  const hideTip = () => setTip(null);

  return (
    <button
      onClick={onClick}
      className={`relative nav-item w-full ${isActive ? "nav-item-active" : ""} ${collapsed ? "justify-center" : ""}`}
      aria-current={isActive ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
      onMouseEnter={(e) => showTip(e.currentTarget)}
      onMouseLeave={hideTip}
      onFocus={(e) => showTip(e.currentTarget)}
      onBlur={hideTip}
    >
      {collapsed &&
        tip &&
        createPortal(
          <span
            aria-hidden="true"
            data-testid="rail-tooltip"
            className="pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-md px-2 py-1 text-xs bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border-primary)] shadow-lg"
            style={{ top: tip.top, left: tip.left }}
          >
            {item.label}
          </span>,
          document.body,
        )}
      <Icon className={NAV_ICON} />
      {!collapsed && (
        <>
          <span>{item.label}</span>
          {badge != null && badge > 0 && (
            <span className="ml-auto min-w-[18px] h-[18px] flex items-center justify-center px-1.5 text-[10px] font-bold bg-[var(--accent-primary)] text-white rounded-full tabular-nums">
              {badge > 99 ? "99+" : badge}
            </span>
          )}
          {isBeta && !badge && (
            <span className="ml-auto px-1.5 py-0.5 text-[10px] font-medium bg-[var(--accent-primary)] text-white rounded">
              Beta
            </span>
          )}
        </>
      )}
      {collapsed && badge != null && badge > 0 && (
        <span className="absolute top-0 right-0 min-w-[16px] h-4 flex items-center justify-center px-1 text-[9px] font-bold bg-[var(--accent-primary)] text-white rounded-full tabular-nums">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

// ComfyUI connection status (sidebar footer dot + popover)

function SidebarStatus({
  collapsed,
  className = "",
}: {
  collapsed: boolean;
  className?: string;
}) {
  const wsConnected = useGenerationStore((s) => s.wsConnected);
  const wsReconnecting = useGenerationStore((s) => s.wsReconnecting);
  const comfyReachable = useGenerationStore((s) => s.comfyReachable);
  const queueRemaining = useGenerationStore((s) => s.queueRemaining);
  const errorCount = useGenerationStore(selectErrorCount);
  const errors = useGenerationStore((s) => s.errors);
  const clearAllErrors = useGenerationStore((s) => s.clearAllErrors);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissable(open, ref, setOpen);

  const state = deriveConnectionState({
    wsConnected,
    comfyReachable,
    wsReconnecting,
  });
  const dotClass = connectionDotClass(state);
  const label = connectionLabel(state, queueRemaining);
  const title = connectionTitle(state, queueRemaining);
  const badge = errorBadgeText(errorCount);
  const tooltip = badge
    ? `${title} · ${errorCount} error${errorCount > 1 ? "s" : ""}`
    : title;

  const handleRetry = () => {
    window.dispatchEvent(new Event("cj:ws-reconnect"));
  };

  const handleCopyErrors = () => {
    if (errors.length === 0) return;
    const text = formatErrorReport(errors);
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        showToast(
          `${errors.length} error${errors.length > 1 ? "s" : ""} copied to clipboard`,
          "info",
        );
      })
      .catch(() => {
        showToast(errors[0]?.message ?? "Error occurred", "error");
      });
  };

  return (
    <div ref={ref} className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative flex items-center justify-center w-8 h-8 rounded-full hover:bg-[var(--bg-hover)] transition-colors"
        title={open ? undefined : tooltip}
        aria-label={`Connection status: ${tooltip}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="sidebar-status-dot"
      >
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        {badge && (
          <span
            className="absolute top-0.5 right-0 min-w-[14px] h-[14px] px-[3px] rounded-full bg-[var(--error)] text-white text-[9px] font-semibold leading-[14px] text-center tabular-nums opacity-90"
            aria-hidden
          >
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="ComfyUI status"
          className={`absolute z-50 ${collapsed ? "left-full ml-2 bottom-0" : "left-0 bottom-full mb-1"} w-[272px] p-3 rounded-xl shadow-xl bg-[var(--bg-secondary)] border border-[var(--border-primary)] text-sm animate-fade-in`}
        >
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
            <span className="flex-1 min-w-0 truncate font-medium text-[var(--text-primary)]">
              {label}
            </span>
            {state !== "connected" && (
              <button
                type="button"
                onClick={handleRetry}
                className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              >
                <RotateCw className="w-3 h-3" aria-hidden />
                Retry
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">{title}</p>

          <div className="mt-3 pt-2 border-t border-[var(--border-primary)]">
            {errors.length === 0 ? (
              <p className="text-xs text-[var(--text-tertiary)]">
                No recent errors.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-[var(--text-secondary)]">
                    Recent errors ({errorCount})
                  </span>
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={handleCopyErrors}
                      className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                      title="Copy errors to clipboard"
                      aria-label="Copy errors to clipboard"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => clearAllErrors()}
                      className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                      title="Clear all errors"
                      aria-label="Clear all errors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <ul className="mt-1.5 max-h-40 overflow-y-auto space-y-1.5">
                  {errors.slice(0, 5).map((err) => (
                    <li
                      key={`${err.timestamp}-${err.message}`}
                      className="text-xs leading-snug"
                    >
                      <span className="text-[var(--text-tertiary)] tabular-nums">
                        {new Date(err.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>{" "}
                      <span className="text-[var(--text-secondary)] break-words">
                        {err.message}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default Sidebar;

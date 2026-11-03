"use client";

import { STORAGE_KEYS, readLocalStorage } from "@/lib/storageKeys";
import { PageHeader } from "@/components/PageHeader";
import { useCallback, useEffect, useState } from "react";
import { useUIStore } from "@/store";
import {
  getAllVersions,
  formatDate,
  filterChangelog,
  getEntryKind,
  UPDATES_TABS,
  type ChangelogEntry,
  type UpdatesTab,
} from "@/lib/changelog";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Bell,
  Megaphone,
  ScrollText,
} from "lucide-react";

const READ_KEY = STORAGE_KEYS.readVersions;

function loadReadVersions(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = readLocalStorage(READ_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveReadVersions(set: Set<string>) {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify([...set]));
  } catch {
    /* quota / private browsing */
  }
}

export function UpdatesPage() {
  const activeNav = useUIStore((s) => s.activeNav);
  const allVersions = getAllVersions();

  const [readVersions, setReadVersions] =
    useState<Set<string>>(loadReadVersions);
  // Collapsed state: each version can be collapsed; default: latest expanded, rest collapsed
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    allVersions.forEach((v, i) => {
      if (i > 0) init[v.version] = true;
    });
    return init;
  });
  const [copiedVersion, setCopiedVersion] = useState<string | null>(null);
  const [tab, setTab] = useState<UpdatesTab>("all");

  // Mark versions as read when viewing the page
  useEffect(() => {
    if (activeNav !== "updates") return;
    setReadVersions((prev) => {
      const next = new Set(prev);
      let changed = false;
      allVersions.forEach((v) => {
        if (!next.has(v.version)) {
          next.add(v.version);
          changed = true;
        }
      });
      if (changed) saveReadVersions(next);
      return next;
    });
  }, [activeNav, allVersions]);

  const toggleCollapse = useCallback((version: string) => {
    setCollapsed((prev) => ({ ...prev, [version]: !prev[version] }));
  }, []);

  const expandAll = useCallback(() => {
    setCollapsed({});
  }, []);

  const collapseAll = useCallback(() => {
    const next: Record<string, boolean> = {};
    allVersions.forEach((v) => {
      next[v.version] = true;
    });
    setCollapsed(next);
  }, [allVersions]);

  const handleCopyVersion = useCallback((version: string) => {
    navigator.clipboard?.writeText(`v${version}`);
    setCopiedVersion(version);
    setTimeout(() => setCopiedVersion(null), 1500);
  }, []);

  const unreadCount = allVersions.filter(
    (v) => !readVersions.has(v.version),
  ).length;
  const allExpanded = allVersions.every((v) => !collapsed[v.version]);
  const visibleVersions = filterChangelog(allVersions, tab);
  const latestVersion = allVersions[0]?.version;

  if (activeNav !== "updates") return null;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="microScrollbar flex-1 overflow-y-auto px-4 pb-6 md:px-6">
        <PageHeader
          title="Updates"
          subtitle="Adrift release history"
          badge={
            unreadCount > 0 ? (
              <span className="rounded-full bg-splash px-2 py-0.5 text-[11px] font-bold tabular-nums tracking-normal text-white">
                {unreadCount} new
              </span>
            ) : undefined
          }
          actions={
            <button
              onClick={allExpanded ? collapseAll : expandAll}
              className="flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_var(--border-primary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] active:scale-[0.96] transition-[color,background-color,transform] duration-150"
            >
              {allExpanded ? (
                <>
                  <ChevronUp className="h-3 w-3" />
                  Collapse all
                </>
              ) : (
                <>
                  <ChevronDown className="h-3 w-3" />
                  Expand all
                </>
              )}
            </button>
          }
        />
        <UpdatesTabs value={tab} onChange={setTab} />
        <ol className="mx-auto max-w-4xl pb-8" aria-label="Release timeline">
          {visibleVersions.length === 0 ? (
            <li className="py-16 text-center text-sm text-[var(--text-muted)]">
              Nothing posted here yet.
            </li>
          ) : (
            visibleVersions.map((entry) => (
              <TimelineEntry
                key={entry.version}
                entry={entry}
                isLatest={entry.version === latestVersion}
                isUnread={!readVersions.has(entry.version)}
                isCollapsed={!!collapsed[entry.version]}
                isCopied={copiedVersion === entry.version}
                onToggleCollapse={() => toggleCollapse(entry.version)}
                onCopyVersion={() => handleCopyVersion(entry.version)}
              />
            ))
          )}
        </ol>
      </div>
    </div>
  );
}

function UpdatesTabs({
  value,
  onChange,
}: {
  value: UpdatesTab;
  onChange: (tab: UpdatesTab) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Filter updates"
      className="mx-auto mb-8 flex w-fit items-center gap-1 rounded-full p-1 shadow-[inset_0_0_0_1px_var(--border-primary)]"
    >
      {UPDATES_TABS.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={`h-7 rounded-full px-3 text-xs font-medium transition-[color,background-color] duration-150 ${
              active
                ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

function KindBadge({ entry }: { entry: ChangelogEntry }) {
  const isAnnouncement = getEntryKind(entry) === "announcement";
  const Icon = isAnnouncement ? Megaphone : ScrollText;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-medium ${
        isAnnouncement ? "text-splash" : "text-light-400 dark:text-dark-500"
      }`}
    >
      <Icon className="h-3 w-3" />
      {isAnnouncement ? "Announcement" : "Changelog"}
    </span>
  );
}

function EntryMeta({
  entry,
  isLatest,
  isUnread,
  isCopied,
  onCopyVersion,
}: {
  entry: ChangelogEntry;
  isLatest: boolean;
  isUnread: boolean;
  isCopied: boolean;
  onCopyVersion: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 md:flex-col md:items-start md:gap-1">
      <time
        dateTime={entry.date}
        className="text-sm font-medium text-light-primary dark:text-dark-primary"
      >
        {formatDate(entry.date)}
      </time>
      <button
        type="button"
        onClick={onCopyVersion}
        className="group/ver flex items-center gap-1 font-mono text-[11px] text-light-400 transition-colors duration-150 hover:text-light-primary dark:text-dark-500 dark:hover:text-dark-primary"
        title="Copy version"
      >
        v{entry.version}
        {isCopied ? (
          <Check className="h-2.5 w-2.5 text-emerald-500" />
        ) : (
          <Copy className="h-2.5 w-2.5 opacity-0 transition-opacity duration-150 group-hover/ver:opacity-70" />
        )}
      </button>
      <KindBadge entry={entry} />
      {(isLatest || isUnread) && (
        <div className="flex items-center gap-1">
          {isLatest && (
            <span className="rounded-full bg-splash/10 px-2 py-0.5 text-[10px] font-medium text-splash">
              Latest
            </span>
          )}
          {isUnread && (
            <span className="flex items-center gap-1 rounded-full bg-splash/10 px-2 py-0.5 text-[10px] font-medium text-splash">
              <Bell className="h-2.5 w-2.5" />
              New
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function TimelineEntry({
  entry,
  isLatest,
  isUnread,
  isCollapsed,
  isCopied,
  onToggleCollapse,
  onCopyVersion,
}: {
  entry: ChangelogEntry;
  isLatest: boolean;
  isUnread: boolean;
  isCollapsed: boolean;
  isCopied: boolean;
  onToggleCollapse: () => void;
  onCopyVersion: () => void;
}) {
  const changeCount = entry.highlights.length + (entry.fixes?.length ?? 0);
  const meta = (
    <EntryMeta
      entry={entry}
      isLatest={isLatest}
      isUnread={isUnread}
      isCopied={isCopied}
      onCopyVersion={onCopyVersion}
    />
  );
  return (
    <li className="md:grid md:grid-cols-[176px_minmax(0,1fr)]">
      {/* Date column (desktop) */}
      <div className="hidden pr-6 pt-1 md:block">
        <div className="sticky top-4">{meta}</div>
      </div>

      {/* Rail + article */}
      <div className="relative border-l border-light-200 pb-12 pl-5 dark:border-dark-750 md:pl-8">
        <span
          aria-hidden="true"
          className={`absolute -left-[5px] top-2 h-2.5 w-2.5 rounded-full ring-4 ring-[var(--bg-primary)] ${
            isUnread || isLatest ? "bg-splash" : "bg-light-300 dark:bg-dark-300"
          }`}
        />
        <div className="mb-3 md:hidden">{meta}</div>
        <article>
          <h2 className="text-balance text-xl font-semibold tracking-tight text-light-primary dark:text-dark-primary md:text-2xl">
            {entry.title}
          </h2>
          {entry.summary && (
            <p className="mt-3 text-pretty text-sm leading-relaxed text-light-500 dark:text-dark-400">
              {entry.summary}
            </p>
          )}
          {entry.image && !isCollapsed && (
            <figure className="mt-4 overflow-hidden rounded-xl border border-light-100 bg-light-input dark:border-dark-750 dark:bg-dark-input">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={entry.image.src}
                alt={entry.image.alt}
                loading="lazy"
                decoding="async"
                className="block aspect-[16/9] w-full object-cover"
              />
            </figure>
          )}

          {!isCollapsed && (
            <div className="mt-4 space-y-4">
              {entry.highlights.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] font-medium text-light-400 dark:text-dark-500">
                    {isLatest ? "New features" : "Changes"}
                  </p>
                  <ul className="space-y-1.5">
                    {entry.highlights.map((item) => (
                      <li
                        key={item}
                        className="flex items-start gap-2 text-sm text-light-500 dark:text-dark-400"
                      >
                        <span className="mt-2 h-1 w-1 flex-shrink-0 rounded-full bg-splash/60" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {entry.fixes && entry.fixes.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[11px] font-medium text-emerald-600 dark:text-emerald-500">
                    Bug fixes
                  </p>
                  <ul className="space-y-1.5">
                    {entry.fixes.map((fix) => (
                      <li
                        key={fix}
                        className="flex items-start gap-1.5 text-sm text-light-500 dark:text-dark-400"
                      >
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />
                        {fix}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {changeCount > 0 && (
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-expanded={!isCollapsed}
              className="mt-3 flex items-center gap-1 text-xs font-medium text-light-400 transition-colors duration-150 hover:text-light-primary dark:text-dark-500 dark:hover:text-dark-primary"
            >
              {isCollapsed ? (
                <>
                  <ChevronDown className="h-3 w-3" />
                  Show {changeCount} change{changeCount !== 1 ? "s" : ""}
                </>
              ) : (
                <>
                  <ChevronUp className="h-3 w-3" />
                  Hide details
                </>
              )}
            </button>
          )}
        </article>
      </div>
    </li>
  );
}

export default UpdatesPage;

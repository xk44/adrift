"use client";

import { PageHeader } from "@/components/PageHeader";
import { showToast } from "@/components/Toast";
import { useEffect, useState } from "react";
import { useUIStore, useGenerationStore } from "@/store";
import { buildBugReport, issueUrlForReport } from "@/lib/ui/bugReport";
import {
  navigateToDestination,
  whatsWhereEntries,
} from "@/lib/ui/navRegistry";
import { openOnboarding } from "@/store/onboardingStore";
import { startTour, tourResumePoint } from "@/store/tourStore";
import {
  HelpCircle,
  ExternalLink,
  MessageCircle,
  Activity,
  Bug,
  Copy,
  CheckCircle,
  AlertTriangle,
  Keyboard,
  RefreshCw,
  Map as MapIcon,
  Wand2,
  Compass,
} from "lucide-react";

export function HelpPage() {
  const activeNav = useUIStore((s) => s.activeNav);
  const [bugDescription, setBugDescription] = useState("");
  const [copied, setCopied] = useState(false);

  const comfyReachable = useGenerationStore((s) => s.comfyReachable);
  const wsConnected = useGenerationStore((s) => s.wsConnected);
  const errors = useGenerationStore((s) => s.errors);
  const errorCount = errors.length;

  if (activeNav !== "help") return null;

  // Nothing is sent anywhere: the report is copied, or opened as a
  // pre-filled issue the user can read and send themselves.
  const currentReport = () =>
    buildBugReport({
      description: bugDescription,
      comfyReachable,
      wsConnected,
      errors,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      page: typeof window !== "undefined" ? window.location.pathname : undefined,
    });

  const handleCopyReport = async () => {
    try {
      await navigator.clipboard.writeText(currentReport());
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      showToast("Could not copy. Select the text and copy it by hand.", "error");
    }
  };

  const handleOpenIssue = () => {
    window.open(
      issueUrlForReport(currentReport(), bugDescription),
      "_blank",
      "noopener,noreferrer",
    );
  };

  const allGood = comfyReachable && wsConnected;
  const partial = comfyReachable && !wsConnected;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="microScrollbar flex-1 overflow-y-auto px-4 pb-6 md:px-6">
        <PageHeader
          title="Help"
          subtitle="What's where, server status, shortcuts and reporting a problem"
        />
        <div className="mx-auto max-w-2xl space-y-4">
          {/* Server Status */}
          <div className="rounded-xl border border-light-100 bg-light-input p-4 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark">
            <div className="flex items-start gap-3">
              <Activity className="h-5 w-5 text-emerald-500 mt-0.5" />
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-balance text-light-primary dark:text-dark-primary">
                  Server Status
                </h3>
                <div className="mt-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-light-500 dark:text-dark-400">
                      ComfyUI Backend
                    </span>
                    <div className="flex items-center gap-1.5">
                      {comfyReachable ? (
                        <>
                          <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-300">
                            Online
                          </span>
                        </>
                      ) : (
                        <>
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                          <span className="text-xs font-medium text-amber-600 dark:text-amber-300">
                            Offline
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-light-500 dark:text-dark-400">
                      WebSocket
                    </span>
                    <div className="flex items-center gap-1.5">
                      {wsConnected ? (
                        <>
                          <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-300">
                            Connected
                          </span>
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 text-light-400 dark:text-dark-500" />
                          <span className="text-xs font-medium text-light-400 dark:text-dark-500">
                            Disconnected
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  {errorCount > 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-light-500 dark:text-dark-400">
                        Recent Errors
                      </span>
                      <span className="text-xs font-medium text-rose-500">
                        {errorCount}
                      </span>
                    </div>
                  )}
                </div>
                <p className="mt-2 text-xs text-light-400 dark:text-dark-500">
                  {allGood
                    ? "All systems operational."
                    : partial
                      ? "ComfyUI is reachable, but live updates are off. Progress may show up late."
                      : "Adrift cannot reach ComfyUI. Check that ComfyUI is running, or change the address Adrift uses."}
                </p>
                {!allGood && !partial && (
                  <div className="mt-2 space-y-1">
                    <button
                      type="button"
                      onClick={() => openOnboarding("connect")}
                      className="btn btn-secondary text-xs px-3 py-1"
                    >
                      Change connection
                    </button>
                    <p className="text-[11px] text-light-400 dark:text-dark-500">
                      Advanced: the server address can also be set with
                      COMFY_HTTP_URL in .env.local.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <WhatsWhere />

          {/* Report a problem — copy the report or open a pre-filled issue; nothing is sent automatically */}
          <div
            id="report-problem"
            className="scroll-mt-4 rounded-xl border border-light-100 bg-light-input p-4 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark"
          >
            <div className="flex items-center gap-3 mb-3">
              <Bug className="h-5 w-5 text-rose-400" />
              <h3 className="text-sm font-semibold text-balance text-light-primary dark:text-dark-primary">
                Report a problem
              </h3>
            </div>
            <p className="text-xs text-pretty text-light-500 dark:text-dark-400 mb-3">
              Describe what went wrong. Adrift does not send reports anywhere
              by itself: copy the report and paste it where you ask for help,
              or open a new issue with it filled in. The report includes your
              text, the connection status, your browser and any recent errors.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleCopyReport();
              }}
              className="space-y-3"
            >
              <textarea
                aria-label="Describe the issue"
                value={bugDescription}
                onChange={(e) => setBugDescription(e.target.value)}
                placeholder="What went wrong? What did you click just before?"
                rows={4}
                className="input w-full resize-none text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="submit"
                  disabled={!bugDescription.trim()}
                  className="btn btn-primary text-sm px-4 py-1.5 disabled:opacity-40"
                >
                  <Copy className="w-3.5 h-3.5" />
                  Copy report
                </button>
                <button
                  type="button"
                  onClick={handleOpenIssue}
                  disabled={!bugDescription.trim()}
                  className="btn btn-secondary text-sm px-4 py-1.5 disabled:opacity-40"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open an issue
                </button>
                {copied && (
                  <span
                    role="status"
                    className="flex items-center gap-1.5 text-xs text-emerald-500"
                  >
                    <CheckCircle className="w-3.5 h-3.5" />
                    Copied to clipboard
                  </span>
                )}
              </div>
            </form>
          </div>

          {/* Help links — the shortcuts row opens the keyboard shortcuts list */}
          {[
            {
              icon: ExternalLink,
              title: "ComfyUI Documentation",
              desc: "Official ComfyUI docs and guides",
              href: "https://docs.comfy.org/",
            },
            {
              icon: MessageCircle,
              title: "Community Discord",
              desc: "Join the ComfyUI community",
              href: "https://discord.com/invite/comfyui",
            },
            {
              icon: Keyboard,
              title: "Keyboard Shortcuts",
              desc: "Press ? anywhere (outside a text box) to see them all",
              action: "shortcuts" as const,
            },
          ].map(({ icon: Icon, title, desc, href, action }) => (
            <button
              key={title}
              onClick={() => {
                if (action === "shortcuts") {
                  // Dispatch the question-mark keyboard shortcut
                  window.dispatchEvent(
                    new KeyboardEvent("keydown", { key: "?" }),
                  );
                } else if (href) {
                  window.open(href, "_blank", "noopener,noreferrer");
                }
              }}
              className="w-full text-left flex items-center gap-4 rounded-xl border border-light-100 bg-light-input p-4 shadow-panel transition-[color,background-color] duration-150 hover:bg-light-50 dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark dark:hover:bg-dark-750"
            >
              <Icon className="h-5 w-5 text-light-400 dark:text-dark-500" />
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-balance text-light-primary dark:text-dark-primary">
                  {title}
                </h3>
                <p className="mt-0.5 text-xs text-pretty text-light-500 dark:text-dark-400">
                  {desc}
                </p>
              </div>
              {href && (
                <ExternalLink className="h-3.5 w-3.5 text-light-300 dark:text-dark-600" />
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * "What's where": every working page with its one-line hint, generated from
 * the nav registry so it never drifts from the sidebar. Rows navigate.
 */
export function WhatsWhere() {
  const setActiveNav = useUIStore((s) => s.setActiveNav);
  const setStylesHubTab = useUIStore((s) => s.setStylesHubTab);
  // Read after mount: the saved stop lives in localStorage.
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  useEffect(() => {
    setResumeAt(tourResumePoint()?.index ?? null);
  }, []);
  return (
    <section
      aria-labelledby="help-whats-where"
      className="rounded-xl border border-light-100 bg-light-input p-4 shadow-panel dark:border-dark-750 dark:bg-dark-input dark:shadow-panel-dark"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-3">
        <MapIcon className="h-5 w-5 text-light-400 dark:text-dark-500" />
        <h2
          id="help-whats-where"
          className="flex-1 text-sm font-semibold text-balance text-light-primary dark:text-dark-primary"
        >
          What&apos;s where
        </h2>
        <button
          type="button"
          onClick={() => openOnboarding()}
          className="btn btn-secondary text-xs px-3 py-1"
        >
          <Wand2 className="w-3.5 h-3.5" aria-hidden />
          Run setup guide
        </button>
        <button
          type="button"
          onClick={() => startTour()}
          data-testid="help-take-tour"
          className="btn btn-secondary text-xs px-3 py-1"
          title={
            resumeAt !== null ? `Picks up at stop ${resumeAt + 1}` : undefined
          }
        >
          <Compass className="w-3.5 h-3.5" aria-hidden />
          {resumeAt !== null ? "Resume the tour" : "Take the tour"}
        </button>
        {resumeAt !== null && (
          <button
            type="button"
            onClick={() => startTour({ fresh: true })}
            data-testid="help-restart-tour"
            className="btn btn-secondary text-xs px-3 py-1"
          >
            Start over
          </button>
        )}
      </div>
      <ul className="divide-y divide-light-100 dark:divide-dark-750">
        {whatsWhereEntries().map((d) => {
          const Icon = d.icon;
          return (
            <li key={d.key}>
              <button
                type="button"
                onClick={() =>
                  navigateToDestination(d.key, {
                    setActiveNav,
                    setStylesHubTab,
                  })
                }
                className="flex w-full items-center gap-3 rounded-md px-1 py-2 text-left transition-colors hover:bg-light-50 dark:hover:bg-dark-750"
              >
                <Icon className="h-4 w-4 shrink-0 text-light-400 dark:text-dark-500" />
                <span className="w-24 shrink-0 text-sm font-medium text-light-primary dark:text-dark-primary">
                  {d.label}
                </span>
                <span className="min-w-0 flex-1 text-xs text-pretty text-light-500 dark:text-dark-400">
                  {d.hint}
                </span>
                {d.shortcut && (
                  <kbd className="hidden shrink-0 rounded border border-light-100 px-1.5 text-[11px] text-light-500 sm:inline dark:border-dark-750 dark:text-dark-400">
                    {d.shortcut}
                  </kbd>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default HelpPage;
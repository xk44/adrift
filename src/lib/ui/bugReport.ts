/**
 * Bug report helpers for the Help page.
 *
 * Adrift has no report server, so nothing is "submitted". The Help page
 * builds a plain-text report the user can copy, and offers a link that opens
 * a new issue with the report pre-filled. Both are honest about where the
 * text goes: nowhere, until the user pastes or sends it.
 */
import { formatErrorReport } from "@/lib/ui/connectionState";

/** The public repo's new-issue page; override with NEXT_PUBLIC_ISSUES_URL (e.g. for a fork). */
export const DEFAULT_ISSUES_URL = "https://github.com/xk44/adrift/issues/new";

export function issuesUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_ISSUES_URL?.trim();
  return fromEnv || DEFAULT_ISSUES_URL;
}

export interface BugReportInput {
  description: string;
  comfyReachable: boolean;
  wsConnected: boolean;
  errors?: readonly { message: string; timestamp: number; promptId?: string }[];
  userAgent?: string;
  page?: string;
  now?: Date;
}

/** Markdown report: the user's words first, then the facts that help debug. */
export function buildBugReport(input: BugReportInput): string {
  const description = input.description.trim() || "(no description)";
  const lines = [
    "## What happened",
    "",
    description,
    "",
    "## Details",
    "",
    `- ComfyUI: ${input.comfyReachable ? "reachable" : "not reachable"}`,
    `- Live updates (WebSocket): ${input.wsConnected ? "connected" : "disconnected"}`,
  ];
  if (input.page) lines.push(`- Page: ${input.page}`);
  if (input.userAgent) lines.push(`- Browser: ${input.userAgent}`);
  lines.push(`- Time: ${(input.now ?? new Date()).toISOString()}`);

  const errors = input.errors ?? [];
  if (errors.length > 0) {
    lines.push(
      "",
      "## Recent errors",
      "",
      formatErrorReport(errors.slice(0, 10)),
    );
  }
  return lines.join("\n");
}

/** Keep pre-filled issue links well under common URL length limits. */
export const MAX_ISSUE_URL_LENGTH = 7000;

/** A "new issue" link with title and body filled in (body trimmed to fit). */
export function issueUrlForReport(
  report: string,
  description: string,
  base: string = issuesUrl(),
): string {
  const firstLine = description.trim().split("\n")[0] ?? "";
  const title =
    firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
  const build = (body: string) => {
    const params = new URLSearchParams();
    if (title) params.set("title", title);
    params.set("body", body);
    return `${base}${base.includes("?") ? "&" : "?"}${params.toString()}`;
  };

  let body = report;
  let url = build(body);
  const note =
    "\n\n(Report shortened; paste the copied report for the full text.)";
  while (url.length > MAX_ISSUE_URL_LENGTH && body.length > 0) {
    const over = url.length - MAX_ISSUE_URL_LENGTH;
    body = body.slice(0, Math.max(0, body.length - Math.max(over, 200)));
    url = build(body + note);
  }
  return url;
}

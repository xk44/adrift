/**
 * Changelog data source for the Updates page.
 */

export type ChangelogKind = "announcement" | "changelog";

export type UpdatesTab = "all" | "announcements" | "changelog";

export const UPDATES_TABS: ReadonlyArray<{ value: UpdatesTab; label: string }> =
  [
    { value: "all", label: "All" },
    { value: "announcements", label: "Announcements" },
    { value: "changelog", label: "Changelog" },
  ];

export interface ChangelogImage {
  src: string;
  alt: string;
}

export interface ChangelogEntry {
  version: string;
  /** "YYYY-MM" or "YYYY-MM-DD" */
  date: string;
  title: string;
  /** Defaults to "changelog" when omitted. */
  kind?: ChangelogKind;
  /** Short lead paragraph shown above the highlights. */
  summary?: string;
  image?: ChangelogImage;
  highlights: string[];
  fixes?: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: "0.2.0",
    date: "2026-10-25",
    title: "Adrift Tools: one place for image and video workflows",
    kind: "announcement",
    summary:
      "The tool suite now has a home of its own. Browse every tool as a card with a live preview, open it, drop in your media, and run it without leaving the app.",
    image: {
      src: "/tool-previews/action--remove_object.webp",
      alt: "Lantern-lit night market used as a tool preview card",
    },
    highlights: [
      "Tools page: a searchable catalog of image and video tools with preview cards and one-click open",
      "Grid Video: build beat-synced grid music videos from your clips, with poster, infection, and mosaic layouts",
      "Smart masks: select a subject by clicking it instead of painting the mask by hand",
      "Video tools: background swap, object and person removal, and motion effects for existing footage",
      "Tool cards show whether the required models are installed before you run anything",
    ],
    fixes: [
      "Tool runs report readable error messages instead of raw backend output",
    ],
  },
  {
    version: "0.1.0-alpha",
    date: "2026-04",
    title: "Adrift Alpha",
    highlights: [
      "Prompt-first web UI with ComfyUI backend",
      "Workflow management, discovery, and packs",
      "Real-time generation with WebSocket progress",
      "Image prompts, style references (--sref), and LoRA support",
      "Canvas editor with inpainting",
      "Gallery organization with folders and favorites",
      "Community model hub integration",
      "Style reference images and LoRA shortcodes",
      "Moodboard management with apply-to-prompt",
      "Model-aware adapter resolution across SDXL, Flux, and SD1.5",
    ],
    fixes: [],
  },
  {
    version: "0.0.9-dev",
    date: "2026-04",
    title: "Internal Dev Preview",
    highlights: [
      "Route mapper with path-first navigation",
      "Dynamic workflow control schema generation",
      "Pack browser with requirement/status panels",
      "Account settings, profile, help, and updates pages",
    ],
    fixes: [],
  },
];

/** Entry kind, defaulting older entries to "changelog". */
export function getEntryKind(entry: ChangelogEntry): ChangelogKind {
  return entry.kind ?? "changelog";
}

/** Entries visible under an Updates tab, newest first (source order). */
export function filterChangelog(
  entries: readonly ChangelogEntry[],
  tab: UpdatesTab,
): ChangelogEntry[] {
  if (tab === "all") return [...entries];
  const kind: ChangelogKind =
    tab === "announcements" ? "announcement" : "changelog";
  return entries.filter((e) => getEntryKind(e) === kind);
}

export function getLatestVersion(): ChangelogEntry {
  return CHANGELOG[0];
}

export function getAllVersions(): ChangelogEntry[] {
  return CHANGELOG;
}

/**
 * Format a date string for display: "2026-04" -> "April 2026",
 * "2026-10-25" -> "October 25, 2026".
 */
export function formatDate(dateStr: string): string {
  const [year, month, day] = dateStr.split("-");
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const monthIndex = parseInt(month ?? "1", 10) - 1;
  const monthName = monthNames[monthIndex] ?? month;
  const dayNum = day ? parseInt(day, 10) : NaN;
  if (Number.isFinite(dayNum)) return `${monthName} ${dayNum}, ${year}`;
  return `${monthName} ${year}`;
}
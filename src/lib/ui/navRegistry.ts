/**
 * One source of truth for app navigation.
 *
 * Sidebar (desktop), MobileBottomNav (tab bar + Menu panel), CommandPalette
 * and KeyboardHelp all read this list, so a page has the same label, icon
 * and shortcut everywhere. Add a page here, not in a component.
 *
 * Groups:
 *  - primary: the seven pages you work in, number keys 1-7
 *  - more:    everything else, tucked under "More" in the sidebar
 *  - account: profile, settings, Setup, help, updates (account menu /
 *             Menu panel). Setup holds workflows, button routing, node
 *             packs and model downloads.
 */
import type { ComponentType } from "react";
import type { NavKey, StylesHubTab } from "@/types";
import {
  Bell,
  BookImage,
  Compass,
  Grid3X3,
  HelpCircle,
  ListTodo,
  PenTool,
  Settings,
  Settings2,
  Sparkles,
  SwatchBook,
  User,
  UserCircle,
  Users,
  Wrench,
} from "lucide-react";

export type NavIcon = ComponentType<{ className?: string }>;
export type NavGroup = "primary" | "more" | "account";

export interface NavDestination {
  key: NavKey;
  label: string;
  icon: NavIcon;
  group: NavGroup;
  /** One plain sentence: what you do on this page. */
  hint: string;
  /** Shown as a tab in the mobile bottom bar. */
  mobileTab?: boolean;
  /** Single-key shortcut (no modifiers, outside text fields). */
  shortcut?: string;
  /** Extra words the command palette matches. */
  keywords?: string[];
  /** Other nav keys that belong to this page (light it up as active). */
  aliases?: NavKey[];
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  // Primary
  {
    key: "explore",
    label: "Explore",
    icon: Compass,
    group: "primary",
    hint: "Browse images and styles for ideas",
    mobileTab: true,
    shortcut: "1",
    keywords: ["browse", "discover", "feed", "civitai", "inspiration"],
  },
  {
    key: "create",
    label: "Create",
    icon: Sparkles,
    group: "primary",
    hint: "Type a prompt and make images or video",
    mobileTab: true,
    shortcut: "2",
    keywords: ["generate", "imagine", "prompt", "gallery", "new"],
  },
  {
    key: "edit",
    label: "Edit",
    icon: PenTool,
    group: "primary",
    hint: "Paint over, extend or fix part of an image",
    shortcut: "3",
    keywords: ["editor", "inpaint", "mask", "paint", "outpaint"],
  },
  {
    key: "organize",
    label: "Organize",
    icon: Grid3X3,
    group: "primary",
    hint: "Sort your images into folders",
    mobileTab: true,
    shortcut: "4",
    keywords: ["folders", "sort", "manage", "library"],
  },
  {
    key: "tools",
    label: "Tools",
    icon: Wrench,
    group: "primary",
    hint: "Upscale, remove backgrounds, animate, make audio and 3D",
    mobileTab: true,
    shortcut: "5",
    keywords: ["upscale", "video", "audio", "3d", "background", "relight"],
  },

  {
    key: "styles",
    label: "Styles",
    icon: SwatchBook,
    group: "primary",
    hint: "Save looks and reuse them in any prompt",
    shortcut: "6",
    keywords: ["sref", "style", "library", "vault", "creator", "look", "map", "clusters", "train"],
    aliases: ["library", "style-creator", "style-vault"],
  },
  {
    key: "characters",
    label: "Characters",
    icon: Users,
    group: "primary",
    hint: "Keep a person or figure consistent across images",
    shortcut: "7",
    keywords: ["character", "dataset", "lora", "face", "likeness"],
  },

  // More
  {
    key: "moodboards",
    label: "Moodboards",
    icon: BookImage,
    group: "more",
    hint: "Collect reference images in one place",
    keywords: ["reference", "board", "collection"],
  },
  {
    key: "personalize",
    label: "Personalize",
    icon: User,
    group: "more",
    hint: "Pick between image pairs to teach Adrift your taste",
    keywords: ["taste", "vote", "preference", "rank"],
  },
  {
    key: "tasks",
    label: "Tasks",
    icon: ListTodo,
    group: "more",
    hint: "Compare, rank and rate images",
    keywords: ["compare", "rankings", "rate", "history", "challenge"],
  },
  // Account
  {
    key: "profile",
    label: "Profile",
    icon: UserCircle,
    group: "account",
    hint: "Your name, picture and favourite images",
    keywords: ["account", "me"],
  },
  {
    key: "account-settings",
    label: "Settings",
    icon: Settings,
    group: "account",
    hint: "Appearance, devices, connections, API keys and data export",
    keywords: [
      "account",
      "preferences",
      "theme",
      "appearance",
      "dark",
      "light",
      "devices",
      "sign out",
      "civitai",
      "key",
      "export",
      "backend",
    ],
  },
  {
    key: "setup",
    label: "Setup",
    icon: Settings2,
    group: "account",
    hint: "Workflows, button routing, node packs and models",
    keywords: [
      "workflows",
      "comfyui",
      "button routing",
      "pipelines",
      "assign",
      "node packs",
      "custom nodes",
      "install",
      "models",
      "download",
      "civitai",
      "manager",
    ],
  },
  {
    key: "help",
    label: "Help",
    icon: HelpCircle,
    group: "account",
    hint: "Server status, shortcuts and reporting a problem",
    keywords: ["support", "docs", "bug", "report", "problem"],
  },
  {
    key: "updates",
    label: "Updates",
    icon: Bell,
    group: "account",
    hint: "What changed in each release",
    keywords: ["changelog", "news", "release"],
  },
];

export function navDestinationsIn(group: NavGroup): NavDestination[] {
  return NAV_DESTINATIONS.filter((d) => d.group === group);
}

/** Mobile bottom-bar tabs, in registry order. */
export function mobileTabDestinations(): NavDestination[] {
  return NAV_DESTINATIONS.filter((d) => d.mobileTab);
}

/** Mobile Menu panel rows: every non-tab destination except Help/Updates. */
export function mobileMenuDestinations(): NavDestination[] {
  return NAV_DESTINATIONS.filter(
    (d) => !d.mobileTab && d.key !== "help" && d.key !== "updates",
  );
}

/** Half-width tiles at the bottom of the mobile Menu panel. */
export function mobileFooterDestinations(): NavDestination[] {
  return NAV_DESTINATIONS.filter(
    (d) => d.key === "help" || d.key === "updates",
  );
}

/** The registry entry that owns a nav key (aliases included), if any. */
export function destinationForNav(nav: NavKey): NavDestination | undefined {
  return NAV_DESTINATIONS.find(
    (d) => d.key === nav || d.aliases?.includes(nav),
  );
}

/** True when `nav` is this destination's page (or one of its aliases). */
export function isDestinationActive(
  dest: NavDestination,
  nav: NavKey,
): boolean {
  return dest.key === nav || !!dest.aliases?.includes(nav);
}

/** Number-key shortcuts → nav key, built from the registry. */
export function navShortcutMap(): Record<string, NavKey> {
  const map: Record<string, NavKey> = {};
  for (const d of NAV_DESTINATIONS) {
    if (d.shortcut) map[d.shortcut] = d.key;
  }
  return map;
}

/**
 * Go to a destination. Styles opens the Styles hub on its Browse tab (the
 * hub's legacy keys stay routable through `aliases`).
 */
export function navigateToDestination(
  key: NavKey,
  actions: {
    setActiveNav: (nav: NavKey) => void;
    setStylesHubTab?: (tab: StylesHubTab) => void;
  },
): void {
  if (key === "styles") {
    actions.setStylesHubTab?.("library");
    actions.setActiveNav("library");
    return;
  }
  actions.setActiveNav(key);
}

/**
 * The Help page's "What's where" list: every page you work in (primary and
 * More) plus Setup, in nav order, with its one-line hint. The other account
 * pages are left out.
 */
export function whatsWhereEntries(): NavDestination[] {
  return NAV_DESTINATIONS.filter(
    (d) => d.group !== "account" || d.key === "setup",
  );
}

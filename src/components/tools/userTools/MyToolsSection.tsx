"use client";

import { useMemo } from "react";
import { Wrench } from "lucide-react";
import type { HubCategory } from "@/lib/tools/hub";
import {
  filterUserTools,
  MY_TOOLS_GROUP,
  userToolSubtitle,
} from "@/lib/userTools/registry";
import { userToolKey } from "@/lib/userTools/types";
import { useUserTools } from "@/store/userToolsStore";
import { TOOL_ICONS, ToolCover } from "../ToolCover";

/**
 * "My tools": workflows the user imported (file or Civitai), shown above
 * the built-in groups and filtered by the same search + category.
 */
export function MyToolsSection({
  query,
  only,
  onOpen,
}: {
  query: string;
  only: HubCategory | null;
  onOpen: (key: string) => void;
}) {
  const tools = useUserTools();
  const shown = useMemo(
    () => filterUserTools(tools ?? [], query, only),
    [tools, query, only],
  );
  if (shown.length === 0) return null;
  return (
    <section
      aria-label={MY_TOOLS_GROUP}
      className="animate-fade-in"
      data-testid="my-tools"
    >
      <h2 className="mb-0.5 flex items-baseline gap-2 text-[15px] font-medium text-light-primary dark:text-dark-primary">
        {MY_TOOLS_GROUP}
        <span className="text-xs font-normal tabular-nums text-light-500 dark:text-dark-400">
          {shown.length}
        </span>
      </h2>
      <p className="mb-3 text-xs text-light-500 dark:text-dark-400">
        Workflows you imported. They run in your own ComfyUI.
      </p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-8 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
        {shown.map((t) => {
          const key = userToolKey(t.id);
          const icon = TOOL_ICONS[t.icon] ? t.icon : "Wrench";
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onOpen(key)}
              data-testid={`tool-card-${key}`}
              className="group flex min-w-0 flex-1 flex-col gap-2 rounded-lg text-left transition-transform duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-splash focus-visible:ring-offset-2 focus-visible:ring-offset-light-bg active:scale-[0.98] dark:focus-visible:ring-offset-dark-bg"
            >
              <span className="relative block w-full overflow-hidden rounded-lg">
                <ToolCover
                  card={{ key, hubCategory: t.category, icon }}
                  className="aspect-[16/10] w-full rounded-lg transition-[filter] duration-200 group-hover:brightness-110"
                />
                <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                  <Wrench className="h-2.5 w-2.5" /> Mine
                </span>
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5 px-0.5">
                <span className="truncate text-[13px] font-medium leading-snug text-light-primary dark:text-dark-primary">
                  {t.name}
                </span>
                <span className="line-clamp-2 min-h-[2.75em] text-[11px] leading-snug text-pretty text-light-500 dark:text-dark-400">
                  {userToolSubtitle(t)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

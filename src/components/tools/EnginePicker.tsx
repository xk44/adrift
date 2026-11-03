"use client";

import { BADGE_LABEL, badgeLinks } from "@/lib/tools/licenseBadges";
import {
  engineBadge,
  engineLicenseNote,
  engineSources,
  type EditEngine,
  type EditEngineId,
} from "@/lib/tools/templates";
import { Segmented } from "./ToolRunner";

/** Model picker for templates/apps; hidden when only one engine can run. */
export function EnginePicker({
  engines,
  value,
  onChange,
}: {
  engines: EditEngine[];
  value: EditEngine | null;
  onChange: (id: EditEngineId) => void;
}) {
  const note = value ? engineLicenseNote(value) : null;
  return (
    <div className="space-y-1.5">
      {engines.length > 1 && (
        <Segmented
          label="Model"
          value={value?.id ?? ""}
          options={engines.map((e) => ({ id: e.id, label: e.label }))}
          onChange={(id) => onChange(id as EditEngineId)}
        />
      )}
      {value && (
        <p className="text-[11px] text-light-500 dark:text-dark-400">
          Runs on {value.model} ·{" "}
          <span data-testid="engine-badge" data-badge={engineBadge(value)}>
            {BADGE_LABEL[engineBadge(value)]}
          </span>
          {note ? <span data-testid="tool-license"> · {note}</span> : null}
          {badgeLinks(engineSources(value)).map((s) => (
            <a
              key={s.url}
              href={s.url!}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-1 underline decoration-dotted underline-offset-2 hover:text-splash"
            >
              License
            </a>
          ))}
        </p>
      )}
    </div>
  );
}

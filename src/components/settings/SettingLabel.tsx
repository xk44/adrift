"use client";

import { CircleHelp } from "lucide-react";

interface SettingLabelProps {
  label: string;
  helpUrl?: string;
  className?: string;
}

export function SettingLabel({
  label,
  helpUrl,
  className = "",
}: SettingLabelProps) {
  const content = (
    <span className="group/group inline-flex items-center gap-1 text-sm font-medium text-[var(--text-secondary)]">
      <span
        className={
          helpUrl
            ? "cursor-help decoration-dotted decoration-1 underline-offset-2 hover:underline"
            : ""
        }
      >
        {label}
      </span>
      <CircleHelp className="h-3.5 w-3.5 pl-[3px] text-[var(--text-muted)] opacity-0 transition-opacity duration-150 group-hover/group:opacity-100" />
    </span>
  );

  if (!helpUrl) {
    return <div className={className}>{content}</div>;
  }

  return (
    <div className={className}>
      <a
        href={helpUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex"
      >
        {content}
      </a>
    </div>
  );
}

export default SettingLabel;

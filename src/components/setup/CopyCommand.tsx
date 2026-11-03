"use client";

import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { showToast } from "@/components/Toast";

/** Copy text, with a textarea fallback for non-secure (LAN http) origins. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** A terminal command in a mono box with a Copy button (44 px target). */
export function CopyCommand({
  command,
  label,
}: {
  command: string;
  /** What the command does, for screen readers ("Start ComfyUI"). */
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    const ok = await copyText(command);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      showToast(
        "Couldn't copy. Select the command and copy it by hand.",
        "error",
      );
    }
  }, [command]);

  return (
    <div className="flex items-stretch gap-1.5 min-w-0">
      <code
        className="flex-1 min-w-0 overflow-x-auto whitespace-pre rounded-lg bg-[var(--bg-tertiary)] px-2.5 py-2 font-mono text-[11px] leading-5 text-[var(--text-primary)] shadow-[inset_0_0_0_1px_var(--border-primary)] select-all noScrollbar"
        data-testid="copy-command-text"
      >
        {command}
      </code>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? `${label}: copied` : `Copy command: ${label}`}
        title="Copy"
        className="inline-flex min-h-[44px] min-w-[44px] flex-shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_var(--border-primary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-accent)]"
      >
        {copied ? (
          <Check className="h-4 w-4 text-[var(--success)]" aria-hidden />
        ) : (
          <Copy className="h-4 w-4" aria-hidden />
        )}
      </button>
    </div>
  );
}

export default CopyCommand;

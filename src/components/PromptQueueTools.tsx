"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useWorkflowImport } from "@/hooks/useWorkflowImport";
import { readImportFile } from "@/lib/pngMeta";

export interface PromptQueueToolsHandle {
  /** Open the file picker for a workflow JSON / Adrift PNG. */
  openImport: () => void;
}

/**
 * Prompt-bar import plumbing: a hidden file input (opened from the prompt
 * bar's "…" menu via the ref handle) plus a window-level drop handler that
 * imports a workflow JSON / Adrift PNG dropped where nothing else claimed it.
 * Always mounted so the file dialog outlives the menu that opened it.
 * "Run next" lives in the same menu and toggles `runNext` in the UI store.
 */
export const PromptQueueTools = forwardRef<PromptQueueToolsHandle>(
  function PromptQueueTools(_props, ref) {
    const importFile = useWorkflowImport();
    const inputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(
      ref,
      () => ({ openImport: () => inputRef.current?.click() }),
      [],
    );

    useEffect(() => {
      const over = (e: DragEvent) => {
        if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
      };
      const drop = async (e: DragEvent) => {
        if (e.defaultPrevented || !e.dataTransfer?.types.includes("Files"))
          return;
        const file = Array.from(e.dataTransfer?.files ?? []).find((f) =>
          /\.(json|png)$/i.test(f.name),
        );
        // Claim synchronously: dragover above made file drops legal anywhere,
        // and a preventDefault after an await is too late — the browser would
        // already have navigated the tab to the dropped file.
        e.preventDefault();
        if (!file) return;
        // Plain PNGs (no metadata) dropped outside a drop zone: ignore quietly.
        if (
          /\.png$/i.test(file.name) &&
          (await readImportFile(file)).kind === "none"
        ) {
          return;
        }
        void importFile(file);
      };
      window.addEventListener("dragover", over);
      window.addEventListener("drop", drop);
      return () => {
        window.removeEventListener("dragover", over);
        window.removeEventListener("drop", drop);
      };
    }, [importFile]);

    return (
      <input
        ref={inputRef}
        type="file"
        accept=".png,.json,image/png,application/json"
        className="hidden"
        aria-label="Import workflow JSON or Adrift PNG"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void importFile(f);
        }}
      />
    );
  },
);

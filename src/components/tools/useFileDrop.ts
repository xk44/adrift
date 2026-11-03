"use client";

import { useRef, useState, type DragEvent } from "react";

/** True when a drag carries files (not text or a link dragged off the page). */
export function dragHasFiles(
  types: ArrayLike<string> | null | undefined,
): boolean {
  return !!types && Array.from(types).includes("Files");
}

/**
 * Drop target for the tool inputs (image / video / audio): handlers for the
 * wrapper plus `over` while a file is held above it, so the zone can light
 * up. Enter/leave are depth-counted because they also fire for children.
 */
export function useFileDrop(onFile: (file: File | undefined) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const handlers = {
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      if (!dragHasFiles(e.dataTransfer?.types)) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
    },
    onDragLeave: () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      onFile(e.dataTransfer?.files?.[0]);
    },
  };
  return { over, handlers };
}

/** Input wrapper; `over` adds a dashed splash outline while a file hovers. */
export function dropZoneClass(over: boolean): string {
  return `space-y-2 rounded-xl transition-[outline-color,background-color] duration-150 motion-reduce:transition-none ${
    over
      ? "bg-splash/5 outline-dashed outline-2 outline-offset-4 outline-splash"
      : "outline-none"
  }`;
}

/** "From gallery" / "Upload" buttons of the tool inputs. */
export const INPUT_PICK_BUTTON =
  "flex min-h-9 items-center gap-1.5 rounded-lg border border-light-100 px-3 py-2 text-xs text-light-primary transition-colors hover:border-splash focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:border-dark-750 dark:text-dark-primary";

/** "or drop ... here": pointer devices only (a phone has nothing to drop). */
export const DROP_HINT =
  "self-center text-[11px] text-light-500 dark:text-dark-400 [@media(hover:none)]:hidden";

/** The small "Remove" link above a picked input. */
export const INPUT_REMOVE_BUTTON =
  "flex items-center gap-1 rounded text-[11px] text-light-500 hover:text-splash focus:outline-none focus-visible:ring-2 focus-visible:ring-splash dark:text-dark-400";

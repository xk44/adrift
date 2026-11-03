"use client";

import { useEffect } from "react";
import { useUserToolsStore } from "@/store/userToolsStore";
import { isUserToolSelection } from "@/lib/userTools/types";

/**
 * `?tool=user:<id>` deep link: user tools are not catalog cards, so the
 * Tools page's card lookup never matches them. Returns the key to open.
 */
export function userToolDeepLinkKey(wanted: string | null): string | null {
  return isUserToolSelection(wanted) ? wanted : null;
}

/**
 * Explore "Import into Adrift" while a tool runner is open: go back to the
 * tool list so the import dialog (which lives in the list header) can open.
 */
export function useReturnToListOnImport(
  selected: string | null,
  back: () => void,
): void {
  const pending = useUserToolsStore((s) => s.pendingImportUrl);
  useEffect(() => {
    if (pending && selected) back();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, selected]);
}

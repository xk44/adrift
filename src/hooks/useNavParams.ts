/**
 * useNavParams — convenience hook for reading route params in page components.
 *
 * The UI store holds `navParams` (populated by useNavSync from the URL).
 * This hook memo-izes the params object and exposes the most common fields
 * (id, username) as sugar.
 *
 * Usage:
 *   const { id, username, params } = useNavParams();
 *   if (id) { …show detail view… }
 */
import { useMemo } from "react";
import { useUIStore } from "@/store";
import type { NavParams } from "@/types";

export interface NavParamsResult {
  /** Raw params object from the store. */
  params: NavParams;
  /** Generic ID param (from /moodboards/:id, /styles/:id, /style-creator/:id). */
  id: string | undefined;
  /** Username param (from /@username). */
  username: string | undefined;
  /** True when any dynamic param is present (page is in "detail" mode). */
  hasParams: boolean;
}

/**
 * Select and memoize nav params for the current route.
 *
 * The selector returns a new object on every store update, so we do a
 * shallow-compare memo to avoid unnecessary re-renders.
 */
export function useNavParams(): NavParamsResult {
  const params = useUIStore((s) => s.navParams);

  return useMemo(() => {
    const id = params.id;
    const username = params.username;
    return {
      params,
      id,
      username,
      hasParams: Object.keys(params).length > 0,
    };
  }, [params]);
}
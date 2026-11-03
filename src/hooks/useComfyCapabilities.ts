"use client";

/**
 * Client view of ComfyUI server capabilities (GET /api/comfy/capabilities).
 * One in-flight/settled request is shared across components; null until
 * loaded or when the route fails (callers treat null as "old server").
 */

import { useEffect, useState } from "react";
import type { ComfyCapabilities } from "@/lib/comfy/capabilities";

let shared: Promise<ComfyCapabilities | null> | null = null;

export function fetchComfyCapabilities(
  opts: { fresh?: boolean } = {},
): Promise<ComfyCapabilities | null> {
  if (!shared || opts.fresh) {
    shared = fetch(
      `/api/comfy/capabilities${opts.fresh ? "?fresh=1" : ""}`,
      { cache: "no-store" },
    )
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          capabilities?: ComfyCapabilities;
        } | null;
        return res.ok && data?.ok && data.capabilities
          ? data.capabilities
          : null;
      })
      .catch(() => null)
      .then((caps) => {
        // Retry next time instead of caching a failure / unreachable server.
        if (!caps?.reachable) shared = null;
        return caps;
      });
  }
  return shared;
}

/** Test hook: forget the shared request. */
export function resetComfyCapabilitiesClientCache(): void {
  shared = null;
}

export function useComfyCapabilities(): ComfyCapabilities | null {
  const [caps, setCaps] = useState<ComfyCapabilities | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchComfyCapabilities().then((c) => {
      if (alive) setCaps(c);
    });
    return () => {
      alive = false;
    };
  }, []);
  return caps;
}

"use client";

/**
 * Client view of GET /api/integrations. One request is shared across
 * components; everything reads as "not configured" until it answers.
 */

import { useEffect, useState } from "react";
import { NO_INTEGRATIONS, type Integrations } from "@/lib/integrations";

let shared: Promise<Integrations> | null = null;

export function fetchIntegrations(): Promise<Integrations> {
  shared ??= fetch("/api/integrations", { cache: "no-store" })
    .then(async (res) => {
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        integrations?: Partial<Integrations>;
      } | null;
      if (!res.ok || !data?.ok || !data.integrations) throw new Error("no data");
      return { ...NO_INTEGRATIONS, ...data.integrations };
    })
    .catch(() => {
      shared = null; // retry on the next mount
      return NO_INTEGRATIONS;
    });
  return shared;
}

/** Test hook: forget the shared request. */
export function resetIntegrationsClientCache(): void {
  shared = null;
}

export function useIntegrations(): Integrations {
  const [value, setValue] = useState<Integrations>(NO_INTEGRATIONS);
  useEffect(() => {
    let alive = true;
    void fetchIntegrations().then((v) => {
      if (alive) setValue(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return value;
}

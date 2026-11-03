/**
 * Client cache of the global upscaler preference (/api/settings/upscaler),
 * shared by every picker on the page. One GET per page load; saves update the
 * cache and notify subscribers. The first successful load also moves the old
 * per-browser choice (localStorage "adrift.upscale-model") into the server
 * preference as the photo default, when none is set yet.
 */
import { upscaleModelScale, type UpscaleModelOption } from "./upscaleModels";
import { describeUpscaler, canBeDefault } from "./upscalerCatalog";
import type { ResolvedDefaults, UpscalerPref } from "./upscalerPref";
import { takeLegacyUpscaleModel } from "./upscalePrefs";

export interface UpscalerDefaults {
  pref: UpscalerPref;
  locked: boolean;
  available: boolean;
  models: UpscaleModelOption[] | null;
  resolved: ResolvedDefaults | null;
}

export const UPSCALER_SETTINGS_API = "/api/settings/upscaler";

type Listener = (d: UpscalerDefaults | null) => void;
const listeners = new Set<Listener>();
let current: UpscalerDefaults | null = null;
let pending: Promise<UpscalerDefaults | null> | null = null;

function parse(d: unknown): UpscalerDefaults | null {
  if (!d || typeof d !== "object") return null;
  const r = d as Record<string, unknown>;
  if (r.ok !== true || !r.pref || typeof r.pref !== "object") return null;
  return {
    pref: r.pref as UpscalerPref,
    locked: r.locked !== false,
    available: r.available === true,
    models: Array.isArray(r.models) ? (r.models as UpscaleModelOption[]) : null,
    resolved:
      r.resolved && typeof r.resolved === "object"
        ? (r.resolved as ResolvedDefaults)
        : null,
  };
}

function publish(d: UpscalerDefaults | null): void {
  current = d;
  for (const l of listeners) l(d);
}

export function getUpscalerDefaults(): UpscalerDefaults | null {
  return current;
}

export function subscribeUpscalerDefaults(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

async function migrateLegacy(d: UpscalerDefaults): Promise<UpscalerDefaults> {
  const legacy = takeLegacyUpscaleModel();
  if (!legacy || d.pref.photo) return d;
  if (!canBeDefault(describeUpscaler(legacy, upscaleModelScale(legacy)))) return d;
  try {
    return (await saveUpscalerDefaults({ photo: legacy })) ?? d;
  } catch {
    return d;
  }
}

/** Cached GET (fresh = refetch). null = not reachable / not allowed. */
export function loadUpscalerDefaults(
  fresh = false,
): Promise<UpscalerDefaults | null> {
  if (current && !fresh) return Promise.resolve(current);
  if (pending && !fresh) return pending;
  const p: Promise<UpscalerDefaults | null> = fetch(
    fresh ? `${UPSCALER_SETTINGS_API}?fresh=1` : UPSCALER_SETTINGS_API,
  )
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => parse(j))
    .then(async (d) => {
      if (!d) return null;
      const out = await migrateLegacy(d);
      if (!current || current === d) publish(out);
      return out;
    })
    .catch(() => null)
    .finally(() => {
      if (pending === p) pending = null;
    });
  pending = p;
  return p;
}

/** PUT a patch (file / null per content, scale, lock); throws on failure. */
export async function saveUpscalerDefaults(
  patch: Record<string, unknown>,
): Promise<UpscalerDefaults | null> {
  const res = await fetch(UPSCALER_SETTINGS_API, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || j.ok === false)
    throw new Error(
      typeof j.error === "string" ? j.error : `HTTP ${res.status}`,
    );
  const d = parse(j);
  if (d) publish(d);
  return d;
}

/** Test hook. */
export function resetUpscalerDefaultsCache(): void {
  current = null;
  pending = null;
}

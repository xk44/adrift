/**
 * Normalizers for StyleVault API responses read through `/api/vault/*`.
 *
 * StyleVaultPage's original types drifted from the real FastAPI shapes
 * (stylevault/api/app.py): points come wrapped in `{points}`, cluster nodes
 * carry `name` (not `label`), style search returns `{results}` keyed by
 * `style_node_id`, asset search returns `{results, total_count}`, runs list
 * `models[]` instead of `embedding_model`. These accept both the real shape
 * and the legacy one so older servers/tests keep working.
 */

export interface VaultUmapPoint {
  asset_id: number;
  x: number;
  y: number;
  cluster_id: number | null;
}

export interface VaultStyleOption {
  id: number;
  style_name: string | null;
  source_cluster_id: number | null;
  codes?: string[];
}

export interface VaultAssetHit {
  asset_id: number;
  sha256?: string;
  source_path: string;
  score?: number | null;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** `GET umap/runs/{id}/points` → `{run_id, count, points: [...]}`. */
export function normalizeUmapPoints(data: unknown): VaultUmapPoint[] {
  const rows = Array.isArray(data)
    ? data
    : isObj(data) && Array.isArray(data.points)
      ? data.points
      : [];
  const out: VaultUmapPoint[] = [];
  for (const row of rows) {
    if (!isObj(row)) continue;
    const x = num(row.x);
    const y = num(row.y);
    if (x == null || y == null) continue;
    out.push({
      asset_id: num(row.asset_id) ?? num(row.style_id) ?? out.length,
      x,
      y,
      cluster_id: num(row.cluster_id),
    });
  }
  return out;
}

/** `GET styles/search` → `{results: [{style_node_id, style_name, cluster_id, codes, score}]}`. */
export function normalizeStyleSearch(data: unknown): VaultStyleOption[] {
  const rows = Array.isArray(data)
    ? data
    : isObj(data) && Array.isArray(data.results)
      ? data.results
      : [];
  const out: VaultStyleOption[] = [];
  for (const row of rows) {
    if (!isObj(row)) continue;
    const id = num(row.style_node_id) ?? num(row.id);
    if (id == null) continue;
    out.push({
      id,
      style_name: typeof row.style_name === "string" ? row.style_name : null,
      source_cluster_id: num(row.cluster_id) ?? num(row.source_cluster_id),
      codes: Array.isArray(row.codes)
        ? row.codes.filter((c): c is string => typeof c === "string")
        : undefined,
    });
  }
  return out;
}

/** `GET search` → `{query, count, total_count, results: [...]}`. */
export function normalizeAssetSearch(data: unknown): {
  items: VaultAssetHit[];
  total: number | null;
} {
  if (Array.isArray(data))
    return { items: data as VaultAssetHit[], total: null };
  if (!isObj(data)) return { items: [], total: null };
  const items = Array.isArray(data.results)
    ? (data.results.filter(isObj) as unknown as VaultAssetHit[])
    : [];
  return { items, total: num(data.total_count) };
}

/** Real nodes carry `name`; legacy test data used `label`. */
export function clusterNodeLabel(node: {
  id: number;
  name?: string | null;
  label?: string | null;
}): string {
  return node.name || node.label || `Cluster ${node.id}`;
}

/** "color-histogram + clip" from `models[]`, falling back to legacy `embedding_model`. */
export function umapRunModelLabel(run: {
  models?: { name?: string }[] | null;
  embedding_model?: string | null;
}): string | null {
  const names = (run.models ?? [])
    .map((m) => m?.name)
    .filter((n): n is string => !!n);
  if (names.length) return names.join(" + ");
  return run.embedding_model || null;
}

/** FastAPI errors are `{detail}`; the proxy's own are `{error}`. */
export function vaultErrorMessage(body: unknown, status: number): string {
  if (isObj(body)) {
    if (typeof body.error === "string" && body.error) return body.error;
    if (typeof body.detail === "string" && body.detail) return body.detail;
  }
  return `HTTP ${status}`;
}

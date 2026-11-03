/**
 * Optional-node bypass warnings in job-route responses.
 *
 * /api/jobs/imagine, /api/jobs/action and /api/jobs/tool return
 * `warnings.nodes` (see src/lib/comfy/optionalNodes.ts) when an optional
 * custom node is missing and was bypassed at queue time. Clients toast them.
 */
export function nodeWarningsOf(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const warnings = (data as { warnings?: unknown }).warnings;
  if (!warnings || typeof warnings !== "object") return [];
  const nodes = (warnings as { nodes?: unknown }).nodes;
  return Array.isArray(nodes)
    ? nodes.filter((w): w is string => typeof w === "string" && w.length > 0)
    : [];
}

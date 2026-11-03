/**
 * Optional external services. Adrift has built-in defaults for their URLs,
 * but the features that need them only show when the URL is set explicitly
 * (env), so a fresh install has no buttons that always fail.
 */
export interface Integrations {
  /** STYLEVAULT_API_URL: Describe, dataset import / auto-sort / auto-caption. */
  styleVault: boolean;
  /** NEVO_BACKEND_URL: the prompt bar's Evolve (NEvo) menu. */
  nevo: boolean;
}

export const NO_INTEGRATIONS: Integrations = { styleVault: false, nevo: false };

export function integrationsFromEnv(
  source: Record<string, string | undefined> = process.env,
): Integrations {
  return {
    styleVault: Boolean(source.STYLEVAULT_API_URL?.trim()),
    nevo: Boolean(source.NEVO_BACKEND_URL?.trim()),
  };
}

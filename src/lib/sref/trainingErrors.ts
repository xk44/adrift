/**
 * Plain-language messages for StyleVault training errors shown in the UI.
 */

/** The vault proxy's 400 for a folder outside CJ_VAULT_DATASET_ROOTS. */
export const DATASET_ROOTS_HINT =
  "That folder isn't allowed yet. Add it (or a folder above it) to CJ_VAULT_DATASET_ROOTS in .env.local, restart Adrift, and try again. Or train from a cluster.";

/** Message to show for a failed training start. */
export function trainingStartErrorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (text.includes("CJ_VAULT_DATASET_ROOTS")) return DATASET_ROOTS_HINT;
  return text.replace(/^Error:\s*/, "");
}

/**
 * Which workflow pack Create uses when no model is picked.
 *
 * Krea 2 is the built-in default (the wizard's "Images: best quality" pack).
 * CJ_DEFAULT_PACK overrides it on the server; NEXT_PUBLIC_CJ_DEFAULT_PACK is
 * its browser mirror (next.config.ts), where CJ_DEFAULT_PACK is undefined.
 * The defaults read process.env.<NAME> literally so Next can inline the
 * NEXT_PUBLIC_ value into the client bundle.
 */
export const BUILTIN_DEFAULT_PACK_ID = "krea2";

/** Starter pack (starterPacks.json) that installs each default engine. */
export const STARTER_PACK_FOR_ENGINE: Readonly<Record<string, string>> = {
  krea2: "images-best",
  "krea2-draft": "images-draft",
  sdxl: "images-fast",
};

export function resolveDefaultPackId(
  serverValue: string | undefined = process.env.CJ_DEFAULT_PACK,
  publicValue: string | undefined = process.env.NEXT_PUBLIC_CJ_DEFAULT_PACK,
): string {
  return serverValue?.trim() || publicValue?.trim() || BUILTIN_DEFAULT_PACK_ID;
}

import { slotOptions, type StarterPacksDoc } from "./starterPacks";

/**
 * License fields every starter pack and every pack file must carry:
 * a non-empty `licenseName`, and a `licenseUrl` that is either an https
 * link or an explicit `null` ("no verified link"). Returns one message per
 * problem; empty means valid.
 */
export function validatePackLicenses(doc: StarterPacksDoc): string[] {
  const errs: string[] = [];
  const check = (
    where: string,
    v: { licenseName?: unknown; licenseUrl?: unknown },
  ) => {
    if (typeof v.licenseName !== "string" || !v.licenseName.trim())
      errs.push(`${where}: missing licenseName`);
    if (!("licenseUrl" in v) || v.licenseUrl === undefined)
      errs.push(`${where}: missing licenseUrl (use null when unknown)`);
    else if (v.licenseUrl !== null) {
      if (typeof v.licenseUrl !== "string" || !isHttpsUrl(v.licenseUrl))
        errs.push(`${where}: licenseUrl must be an https link or null`);
    }
  };
  for (const pack of doc.packs) {
    check(`pack ${pack.id}`, pack);
    for (const f of pack.files)
      for (const o of slotOptions(f)) check(`pack ${pack.id} file ${o.dest}`, o);
  }
  return errs;
}

export function isHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !!u.hostname;
  } catch {
    return false;
  }
}

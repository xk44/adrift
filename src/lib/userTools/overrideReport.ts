/**
 * Attach ranked stand-in files to the missing-model reports of an import
 * analysis (see modelOverrides.ts). Pure.
 */

import type { BackendProfile } from "@/lib/models/compat";
import type { ObjectInfoIndex } from "@/lib/oj/inputSpec";
import {
  loaderInputOptions,
  modelFamily,
  rankOverrideCandidates,
  suggestOverride,
} from "./modelOverrides";
import type { MissingModelReport } from "./types";

export function withOverrideCandidates(
  missing: MissingModelReport[],
  objectInfo: ObjectInfoIndex,
  profile: BackendProfile | null,
): MissingModelReport[] {
  return missing.map((m) => {
    const options =
      loaderInputOptions(
        objectInfo as Record<string, unknown>,
        m.classType,
        m.input,
      ) ?? [];
    const candidates = rankOverrideCandidates(m.file, options, {
      classType: m.classType,
      input: m.input,
      profile,
    });
    return {
      ...m,
      candidates,
      suggested: suggestOverride(candidates),
      optionCount: options.filter((o) => typeof o === "string" && o !== m.file)
        .length,
      family: modelFamily(m.file),
    };
  });
}

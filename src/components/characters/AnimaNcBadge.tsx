import { LicenseLink } from "@/components/models/LicenseLink";
import { licenseUrlFor } from "@/lib/models/licenseLinks";
import { ANIMA_LICENSE } from "@/lib/oj/animaRef";

/** "Non-commercial" badge linking the Anima weights' license. */
export function AnimaNcBadge() {
  return (
    <LicenseLink
      name={ANIMA_LICENSE}
      url={licenseUrlFor(ANIMA_LICENSE)}
      className="shrink-0 rounded bg-[var(--warning)]/15 px-1 text-[10px] font-medium text-[var(--warning)] hover:underline"
    >
      Non-commercial
    </LicenseLink>
  );
}

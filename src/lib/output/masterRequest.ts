/**
 * Read the per-run master-file choice off a job request: an explicit
 * `output_format` body field wins, else the `adrift_master` cookie the
 * output-format picker sets. Server-side only by convention (takes a Request).
 */

import {
  masterChoiceFromCookieHeader,
  parseMasterChoice,
  type MasterChoice,
} from "@/lib/output/saveNodes";

export function masterChoiceFromRequest(
  request: Pick<Request, "headers">,
  body: unknown,
): MasterChoice | null {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const raw = (body as Record<string, unknown>).output_format;
    // Explicit body field (even "png"/"h264" defaults) overrides the cookie.
    if (raw && typeof raw === "object") return parseMasterChoice(raw);
  }
  return masterChoiceFromCookieHeader(request.headers.get("cookie"));
}

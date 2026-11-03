/** VL captioners sometimes answer with a markdown sheet (headings, **Label:** lines, bullets)
 *  despite the prompt; fold that into one prose line usable as a prompt. */
export function plainCaption(raw: string): string {
  const parts = raw
    .replace(/\*\*|__|`/g, "")
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(#+|[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l && !/^(visual\s+)?prompt\s*:?$/i.test(l))
    .map((l) => l.replace(/^[A-Z][A-Za-z ]{1,24}:\s+/, "").trim())
    .filter(Boolean)
    .map((l) => (/[.!?]$/.test(l) ? l : `${l}.`));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

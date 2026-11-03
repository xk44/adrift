/**
 * Turn raw feed errors (Civitai / Hugging Face proxy messages, fetch
 * failures, JSON parse errors) into one short sentence a person can act on.
 * Pure and unit-tested; the Explore image feed and the model feeds share it.
 *
 * `needsKey` is set only for Civitai auth refusals (401/403): the UI then
 * offers a link to Settings, where the Civitai API key lives.
 */
export interface FeedErrorInfo {
  message: string;
  needsKey: boolean;
}

export type FeedErrorSource = "civitai" | "hf";

const SOURCE_LABEL: Record<FeedErrorSource, string> = {
  civitai: "Civitai",
  hf: "Hugging Face",
};

function statusOf(raw: string): number | null {
  // "Civitai API error 401: …", "Model search failed (429)", "HTTP 503"
  const m =
    raw.match(/\berror\s+(\d{3})\b/i) ??
    raw.match(/\((\d{3})\)/) ??
    raw.match(/\bHTTP\s+(\d{3})\b/i);
  return m ? Number(m[1]) : null;
}

export function describeFeedError(
  raw: string | null | undefined,
  source: FeedErrorSource = "civitai",
): FeedErrorInfo {
  const label = SOURCE_LABEL[source];
  const text = (raw ?? "").trim();
  const status = statusOf(text);
  const lower = text.toLowerCase();

  if (
    source === "civitai" &&
    (status === 401 ||
      status === 403 ||
      lower.includes("unauthorized") ||
      lower.includes("requires authentication"))
  ) {
    return {
      message:
        "Civitai turned this request away. Add a Civitai API key in Settings, then try again.",
      needsKey: true,
    };
  }
  if (
    status === 429 ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  ) {
    return {
      message: `${label} is limiting requests right now. Wait a minute, then try again.`,
      needsKey: false,
    };
  }
  if (
    (status !== null && status >= 500) ||
    lower.includes("exhausted retries") ||
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("fetch failed") ||
    lower.includes("timed out") ||
    lower.includes("timeout")
  ) {
    return {
      message: `Couldn't reach ${label}. Check your connection, then try again.`,
      needsKey: false,
    };
  }
  // A non-JSON reply (proxy/HTML error page) surfaces as a JSON parse error.
  if (
    lower.includes("unexpected token") ||
    lower.includes("is not valid json")
  ) {
    return {
      message: `${label} sent back something unexpected. Try again in a moment.`,
      needsKey: false,
    };
  }
  return {
    message: text || `Couldn't load from ${label}.`,
    needsKey: false,
  };
}

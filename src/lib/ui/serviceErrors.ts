/**
 * Turn raw upstream error strings ("http://127.0.0.1:8188/customnode/getlist
 * ?mode=cache failed: 404") into a sentence a beginner can act on. The raw
 * text is kept as `detail` so it can sit behind a <details> disclosure.
 */
export interface FriendlyServiceError {
  /** Plain-language headline/sentence. */
  summary: string;
  /** Original error text for the "Technical details" disclosure, if any. */
  detail: string | null;
}

const NETWORK_RE =
  /failed to fetch|networkerror|load failed|network request failed/i;
const UNREACHABLE_RE =
  /econnrefused|enotfound|etimedout|fetch failed|socket hang up|aborted|timed? ?out/i;
const MANAGER_ROUTE_RE = /\/customnode\/|\/externalmodel\/|\/manager\//i;
const MISSING_RE = /\b(404|405|501)\b|not found/i;

export function friendlyManagerError(raw: string | null | undefined): FriendlyServiceError {
  const text = (raw ?? "").trim();
  if (!text) {
    return {
      summary: "ComfyUI-Manager isn't installed or isn't responding.",
      detail: null,
    };
  }
  if (NETWORK_RE.test(text)) {
    return {
      summary: "Couldn't reach the Adrift server. Check that it is running.",
      detail: text,
    };
  }
  if (
    (MANAGER_ROUTE_RE.test(text) && (MISSING_RE.test(text) || UNREACHABLE_RE.test(text))) ||
    UNREACHABLE_RE.test(text)
  ) {
    return {
      summary: "ComfyUI-Manager isn't installed or isn't responding.",
      detail: text,
    };
  }
  return {
    summary: "ComfyUI-Manager returned an error.",
    detail: text,
  };
}

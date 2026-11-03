/**
 * Small display rules for the setup wizard's Connect step (pure, testable).
 */

/**
 * "This computer" probes the default ports on its own, except when the
 * address is pinned by COMFY_HTTP_URL and already answering: a failed look
 * on 8188/8000 would then contradict the "Connected" line above it.
 */
export function shouldAutoProbeLocal(opts: {
  choice: string;
  hasResult: boolean;
  busy: boolean;
  envLocked: boolean;
  reachable: boolean;
}): boolean {
  if (opts.envLocked && opts.reachable) return false;
  return opts.choice === "local" && !opts.hasResult && !opts.busy;
}

/**
 * Split a message into text and CLI flags ("--listen") so the flags can be
 * kept on one line. Odd indexes are flags.
 */
export function splitCliFlags(message: string): string[] {
  return message.split(/(--[\w-]+)/);
}

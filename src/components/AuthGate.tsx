"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import {
  completeLogin,
  installAuthFetch,
  submitLogin,
  subscribeAuthGate,
} from "@/lib/authFetch";
import { isOverlayMode } from "@/lib/overlay";
import {
  OVERLAY_LOGIN_NOTICE,
  overlayLoginBlocked,
  parentOrigin,
} from "@/lib/overlay/crossSite";

// Install at module load (before any page effect fires its first fetch).
installAuthFetch();

/**
 * Key prompt shown when any /api call returns 401. Posts the key to
 * /api/auth/login (which sets an httpOnly cookie) and then lets the blocked
 * requests retry. The key itself is never persisted client-side.
 */
export function AuthGate() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLFormElement>(null);
  // Inside the ComfyUI overlay on another site the session cookie isn't
  // sent, so a sign-in here wouldn't stick: say so and offer a real tab.
  const [crossHost, setCrossHost] = useState(false);

  useEffect(() => {
    return subscribeAuthGate(setOpen);
  }, []);

  useEffect(() => {
    if (!open || !isOverlayMode()) return;
    setCrossHost(
      overlayLoginBlocked(
        window.location.origin,
        parentOrigin(window.location, document.referrer),
      ),
    );
  }, [open]);

  // Modal: Tab stays inside, focus returns to the opener after sign-in. No
  // Escape: every request is blocked until the key is entered.
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      if (await submitLogin(key.trim())) {
        setKey("");
        completeLogin();
      } else {
        setError("Wrong key");
      }
    } catch {
      setError("Login request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-4">
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-gate-title"
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-3 rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-5 text-[var(--text-primary)]"
      >
        <h2 id="auth-gate-title" className="text-base font-semibold">
          Sign in
        </h2>
        <p className="text-sm text-[var(--text-secondary)]">
          Enter the admin key to continue.
        </p>
        {crossHost && (
          <div
            className="space-y-2 rounded border border-[var(--border-secondary)] p-3"
            data-testid="overlay-login-notice"
          >
            <p className="text-sm text-[var(--text-secondary)]">
              {OVERLAY_LOGIN_NOTICE}
            </p>
            <button
              type="button"
              onClick={() =>
                window.open(
                  window.location.origin + window.location.pathname,
                  "_blank",
                  "noopener",
                )
              }
              className="w-full rounded border border-[var(--border-secondary)] px-3 py-2 text-sm font-medium"
            >
              Open in tab
            </button>
          </div>
        )}
        <input
          aria-label="Admin key"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="ADMIN_API_KEY"
          className="w-full rounded border border-[var(--border-secondary)] bg-transparent px-3 py-2 text-sm outline-none"
        />
        {error && <p className="text-sm text-[var(--error)]">{error}</p>}
        <button
          type="submit"
          disabled={busy || !key.trim()}
          className="w-full rounded bg-[var(--text-primary)] px-3 py-2 text-sm font-medium text-[var(--bg-primary)] disabled:opacity-50"
        >
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}

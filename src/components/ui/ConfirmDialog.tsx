"use client";

/**
 * Shared confirm dialog: the app's replacement for window.confirm.
 *
 * Either render <ConfirmDialog open … /> yourself, or use useConfirm():
 *
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (!(await confirm({ title: "Delete 3 images?", confirmLabel: "Delete", danger: true }))) return;
 *   …
 *   return <>{…}{confirmDialog}</>;
 *
 * Escape and the backdrop cancel. Focus starts on Cancel for dangerous
 * actions (Enter does not delete by accident), else on the confirm button,
 * and Tab stays inside the dialog.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface ConfirmOptions {
  title: string;
  /** Detail line under the title. */
  message?: ReactNode;
  /** Default "OK". */
  confirmLabel?: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** Red confirm button, focus starts on Cancel. */
  danger?: boolean;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  const msgId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const prev =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    (danger ? cancelRef : okRef).current?.focus();
    return () => prev?.focus?.();
  }, [open, danger]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    // Modal: page shortcuts (Space = play, Delete, …) must not see these keys.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [cancelRef.current, okRef.current].filter(
      (x): x is HTMLButtonElement => !!x,
    );
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.shiftKey
      ? items[(i <= 0 ? items.length : i) - 1]
      : items[(i + 1) % items.length];
    e.preventDefault();
    next.focus();
  };

  const node = (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60"
        aria-hidden
        onClick={onCancel}
        data-testid="confirm-backdrop"
      />
      <div
        ref={boxRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? msgId : undefined}
        onKeyDown={onKeyDown}
        className="relative w-full max-w-sm rounded-xl border border-[var(--border-secondary)] bg-[var(--bg-primary)] p-4 shadow-2xl"
        data-testid="confirm-dialog"
      >
        <h2
          id={titleId}
          className="text-sm font-medium text-[var(--text-primary)]"
        >
          {title}
        </h2>
        {message && (
          <div id={msgId} className="mt-1.5 text-xs text-[var(--text-muted)]">
            {message}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="h-8 rounded-lg border border-[var(--border-secondary)] px-3 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            {cancelLabel}
          </button>
          <button
            ref={okRef}
            type="button"
            onClick={onConfirm}
            className={`h-8 rounded-lg px-3 text-xs font-medium text-white ${
              danger
                ? "bg-red-600 hover:bg-red-700"
                : "bg-[var(--accent-primary)] hover:opacity-90"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
  return mounted && typeof document !== "undefined"
    ? createPortal(node, document.body)
    : node;
}

/**
 * Promise-style confirm. Returns [confirm, dialog]: render `dialog`
 * somewhere in the component; `confirm(opts)` resolves true / false.
 * A second confirm while one is open cancels the first.
 */
export function useConfirm(): [
  (opts: ConfirmOptions) => Promise<boolean>,
  ReactNode,
] {
  const [state, setState] = useState<
    (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  >(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  // Never leave a caller hanging on unmount.
  useEffect(() => () => pending.current?.(false), []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        pending.current?.(false);
        pending.current = resolve;
        setState({ ...opts, resolve });
      }),
    [],
  );

  const settle = (ok: boolean) => {
    state?.resolve(ok);
    if (pending.current === state?.resolve) pending.current = null;
    setState(null);
  };

  const dialog = state ? (
    <ConfirmDialog
      open
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel}
      cancelLabel={state.cancelLabel}
      danger={state.danger}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return [confirm, dialog];
}

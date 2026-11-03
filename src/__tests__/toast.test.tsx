import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ToastContainer,
  TOAST_DEFAULT_MS,
  TOAST_ERROR_MIN_MS,
  TOAST_MAX_VISIBLE,
  enqueueToast,
  toastDuration,
  type ToastItem,
} from "@/components/Toast";

const item = (id: string): ToastItem => ({ id, message: id, type: "info" });

describe("toast timing", () => {
  it("errors stay at least TOAST_ERROR_MIN_MS, even when a caller asks for less", () => {
    expect(toastDuration("error")).toBe(TOAST_ERROR_MIN_MS);
    expect(toastDuration("error", 3000)).toBe(TOAST_ERROR_MIN_MS);
    expect(toastDuration("error", 20000)).toBe(20000);
    expect(TOAST_ERROR_MIN_MS).toBeGreaterThanOrEqual(8000);
  });

  it("success/info keep the requested or default duration", () => {
    expect(toastDuration("info")).toBe(TOAST_DEFAULT_MS);
    expect(toastDuration("success", 1500)).toBe(1500);
  });
});

describe("toast stack", () => {
  it("caps the visible stack, dropping the oldest first", () => {
    let q: ToastItem[] = [];
    for (let i = 0; i < TOAST_MAX_VISIBLE + 3; i++) q = enqueueToast(q, item(`t${i}`));
    expect(q).toHaveLength(TOAST_MAX_VISIBLE);
    expect(q[0].id).toBe("t3");
    expect(q.at(-1)?.id).toBe(`t${TOAST_MAX_VISIBLE + 2}`);
  });

  it("renders a polite status region and an assertive alert region", () => {
    const html = renderToStaticMarkup(createElement(ToastContainer));
    expect(html).toMatch(/role="status" aria-live="polite"/);
    expect(html).toMatch(/role="alert" aria-live="assertive"/);
    expect(html).toContain("md:bottom-6");
  });
});

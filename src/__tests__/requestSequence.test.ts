import { describe, expect, it } from "vitest";
import {
  createRequestSequence,
  isAbortError,
} from "@/lib/util/requestSequence";

describe("requestSequence", () => {
  it("aborts the previous request and marks only the newest ticket current", () => {
    const sequence = createRequestSequence();

    const first = sequence.begin();
    const second = sequence.begin();

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it("cancels the active request", () => {
    const sequence = createRequestSequence();
    const ticket = sequence.begin();

    sequence.cancel();

    expect(ticket.signal.aborted).toBe(true);
    expect(ticket.isCurrent()).toBe(false);
  });

  it("identifies DOM abort errors", () => {
    expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
    expect(isAbortError(new Error("AbortError"))).toBe(false);
  });
});

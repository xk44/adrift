import { describe, it, expect } from "vitest";
import { friendlyManagerError } from "@/lib/ui/serviceErrors";

describe("friendlyManagerError", () => {
  it("maps a Manager 404 to a plain sentence and keeps the raw URL as detail", () => {
    const raw = "http://127.0.0.1:8188/customnode/getlist?mode=cache failed: 404";
    const r = friendlyManagerError(raw);
    expect(r.summary).toBe("ComfyUI-Manager isn't installed or isn't responding.");
    expect(r.summary).not.toContain("http");
    expect(r.detail).toBe(raw);
  });

  it("treats a refused connection the same way", () => {
    expect(friendlyManagerError("connect ECONNREFUSED 127.0.0.1:8188").summary).toMatch(
      /isn't installed or isn't responding/,
    );
  });

  it("explains browser network failures as the Adrift server being down", () => {
    expect(friendlyManagerError("Failed to fetch").summary).toMatch(/Adrift server/);
  });

  it("falls back to a generic sentence with the raw text as detail", () => {
    const r = friendlyManagerError("HTTP 500");
    expect(r.summary).toBe("ComfyUI-Manager returned an error.");
    expect(r.detail).toBe("HTTP 500");
  });

  it("handles empty input", () => {
    expect(friendlyManagerError("").detail).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { captionText } from "@/lib/moodboards/captions";

describe("captionText — activation trigger prefix", () => {
  it("prepends the trigger when absent", () => {
    expect(captionText("a photo of a dog", "ohwx")).toBe(
      "ohwx, a photo of a dog",
    );
  });

  it("does not double-prefix when the caption already leads with the trigger", () => {
    expect(captionText("ohwx, a photo", "ohwx")).toBe("ohwx, a photo");
    expect(captionText("ohwx a photo", "ohwx")).toBe("ohwx a photo");
    expect(captionText("ohwx", "ohwx")).toBe("ohwx");
  });

  it("prepends when the trigger only appears as a substring of another word", () => {
    // The bug: substring match saw "cat" inside "catwalk" and skipped the
    // activation prefix, so the LoRA never learned the "cat" trigger.
    expect(captionText("catwalk photo", "cat")).toBe("cat, catwalk photo");
    expect(captionText("a scattered mess", "cat")).toBe(
      "cat, a scattered mess",
    );
  });

  it("prepends when the trigger appears mid-caption but not at the start", () => {
    expect(captionText("a big cat sitting", "cat")).toBe(
      "cat, a big cat sitting",
    );
  });

  it("is case-insensitive on the leading-trigger check", () => {
    expect(captionText("OHWX, a photo", "ohwx")).toBe("OHWX, a photo");
  });

  it("handles empty inputs", () => {
    expect(captionText("", "ohwx")).toBe("ohwx");
    expect(captionText("a photo", "")).toBe("a photo");
  });
});

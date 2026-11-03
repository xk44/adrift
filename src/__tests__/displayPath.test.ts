import { describe, it, expect } from "vitest";
import { compactPath } from "@/lib/ui/displayPath";

describe("compactPath", () => {
  it("hides the home directory and keeps the last two segments", () => {
    expect(compactPath("/Users/someone/Projects/ComfyUI/user/default/workflows")).toBe(
      "~/…/default/workflows",
    );
    expect(compactPath("/home/someone/ComfyUI/user/default/workflows")).toBe(
      "~/…/default/workflows",
    );
  });

  it("uses an ellipsis without ~ for non-home paths", () => {
    expect(compactPath("/opt/comfy/user/default/workflows")).toBe("…/default/workflows");
  });

  it("handles Windows paths", () => {
    expect(compactPath("C:\\Users\\someone\\ComfyUI\\user\\workflows")).toBe(
      "~\\…\\user\\workflows",
    );
  });

  it("leaves short paths and empty input alone", () => {
    expect(compactPath("")).toBe("");
    expect(compactPath("workflows")).toBe("workflows");
    expect(compactPath("/a/b")).toBe("/a/b");
  });

  it("never contains the user name", () => {
    expect(compactPath("/Users/someone/x/y/z")).not.toContain("someone");
  });
});

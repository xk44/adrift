import { describe, expect, it } from "vitest";
import {
  FOLLOW_CAM_CLASSES,
  FOLLOW_CAM_FALLBACK_NOTE,
  followCamFallback,
} from "@/lib/oj/followCamFallback";

const withNodes = Object.fromEntries(FOLLOW_CAM_CLASSES.map((c) => [c, {}]));
const without = { KSampler: {} };

describe("followCamFallback", () => {
  it("leaves off / unset / unknown listing alone", () => {
    expect(followCamFallback({ followSubject: "off" }, without)).toEqual({
      kind: "ok",
    });
    expect(followCamFallback({}, without)).toEqual({ kind: "ok" });
    expect(followCamFallback({ followSubject: "auto" }, null)).toEqual({
      kind: "ok",
    });
  });

  it("keeps auto / on when the nodes are installed", () => {
    expect(followCamFallback({ followSubject: "auto" }, withNodes)).toEqual({
      kind: "ok",
    });
    expect(followCamFallback({ followSubject: "on" }, withNodes)).toEqual({
      kind: "ok",
    });
  });

  it("drops auto to full frame with a note when nodes are missing", () => {
    expect(followCamFallback({ followSubject: "auto" }, without)).toEqual({
      kind: "off",
      note: FOLLOW_CAM_FALLBACK_NOTE,
    });
  });

  it("refuses an explicit on, naming the missing classes", () => {
    const partial = { ...withNodes } as Record<string, unknown>;
    delete partial.CJFollowCamPaste;
    const res = followCamFallback({ followSubject: "on" }, partial);
    expect(res.kind).toBe("refuse");
    if (res.kind === "refuse") {
      expect(res.error).toContain("CJFollowCamPaste");
      expect(res.error).not.toContain("CJFollowCamTrack");
    }
  });
});

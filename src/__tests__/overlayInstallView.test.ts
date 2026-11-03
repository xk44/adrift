// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  overlayInstallView,
  type OverlayInstallStatus,
} from "@/lib/overlay/installView";
import {
  OVERLAY_LOGIN_NOTICE,
  overlayLoginBlocked,
  parentOrigin,
  sameSite,
} from "@/lib/overlay/crossSite";

const base: OverlayInstallStatus = {
  comfyLocal: true,
  comfyUrl: "http://127.0.0.1:8188",
  customNodesDir: "/srv/ComfyUI/custom_nodes",
  customNodes: true,
  installed: "missing",
  configUrl: null,
  adriftUrl: "http://127.0.0.1:3000",
  loaded: false,
  loadedFrom: [],
  frameAllowed: true,
  remoteSteps: "steps",
};

describe("overlayInstallView", () => {
  it("offers the install when missing", () => {
    expect(overlayInstallView(base).kind).toBe("install");
  });
  it("remote ComfyUI shows the copyable steps", () => {
    const v = overlayInstallView({ ...base, comfyLocal: false });
    expect(v).toMatchObject({ kind: "remote", steps: "steps" });
  });
  it("no custom_nodes folder", () => {
    expect(overlayInstallView({ ...base, customNodes: false }).kind).toBe(
      "noCustomNodes",
    );
  });
  it("something else in the way", () => {
    expect(overlayInstallView({ ...base, installed: "other" }).kind).toBe(
      "blocked",
    );
  });
  it("installed but not loaded asks for a restart", () => {
    const v = overlayInstallView({
      ...base,
      installed: "linked",
      configUrl: base.adriftUrl,
    });
    expect(v).toMatchObject({ kind: "restart", urlStale: false });
    expect(v.text).toMatch(/Restart ComfyUI/);
  });
  it("loaded is done; a different saved address is flagged", () => {
    const v = overlayInstallView({
      ...base,
      installed: "copy",
      loaded: true,
      configUrl: "http://localhost:3000",
    });
    expect(v).toMatchObject({ kind: "done", urlStale: true });
  });
});

describe("overlay cross-host login", () => {
  it("same host on other ports is the same site", () => {
    expect(sameSite("http://localhost:3000", "http://localhost:8188")).toBe(true);
    expect(sameSite("https://a.example.com", "https://b.example.com")).toBe(true);
  });
  it("different hosts or schemes are not", () => {
    expect(sameSite("http://localhost:3000", "http://127.0.0.1:8188")).toBe(false);
    expect(sameSite("http://10.0.0.2:3000", "http://10.0.0.3:8188")).toBe(false);
    expect(sameSite("https://a.example.com", "http://a.example.com")).toBe(false);
  });
  it("parent origin from ancestorOrigins, then referrer", () => {
    expect(
      parentOrigin({ ancestorOrigins: { length: 1, 0: "http://h:8188" } }, ""),
    ).toBe("http://h:8188");
    expect(parentOrigin({}, "http://h:8188/?x=1")).toBe("http://h:8188");
    expect(parentOrigin({}, "")).toBeNull();
  });
  it("blocked when cross-site or unknown", () => {
    expect(overlayLoginBlocked("http://localhost:3000", "http://localhost:8188")).toBe(false);
    expect(overlayLoginBlocked("http://localhost:3000", "http://10.0.0.3:8188")).toBe(true);
    expect(overlayLoginBlocked("http://localhost:3000", null)).toBe(true);
    expect(OVERLAY_LOGIN_NOTICE).toMatch(/Open Adrift in its own tab/);
  });
});

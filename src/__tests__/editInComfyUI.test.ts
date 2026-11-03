import { describe, expect, it } from "vitest";
import {
  buildEditInComfyMessages,
  buildShowGraphMessage,
  comfyFrontendUrl,
  openedComfyToast,
} from "@/lib/comfy/editInComfyUI";
import { parseCjMessage } from "@/lib/overlay/protocol";

const LOCAL = { protocol: "http:", hostname: "localhost" };
const LAN = { protocol: "http:", hostname: "192.168.1.20" };

describe("comfyFrontendUrl (standalone Edit in ComfyUI)", () => {
  it("prefers the saved-connection ws override", () => {
    expect(
      comfyFrontendUrl({
        wsOverride: "wss://gpu.example:8443",
        envWsBase: "ws://127.0.0.1:8188",
        page: LOCAL,
      }),
    ).toBe("https://gpu.example:8443/");
  });

  it("uses the public env ws base, swapping loopback for a remote page host", () => {
    expect(
      comfyFrontendUrl({ envWsBase: "ws://127.0.0.1:8188", page: LOCAL }),
    ).toBe("http://127.0.0.1:8188/");
    expect(
      comfyFrontendUrl({ envWsBase: "ws://127.0.0.1:8188", page: LAN }),
    ).toBe("http://192.168.1.20:8188/");
  });

  it("keeps a subpath and handles a bare host:port env value", () => {
    expect(
      comfyFrontendUrl({ envWsBase: "wss://box.lan/comfy/", page: LOCAL }),
    ).toBe("https://box.lan/comfy/");
    expect(
      comfyFrontendUrl({
        envWsBase: "gpu.lan:8188",
        page: { protocol: "https:", hostname: "x" },
      }),
    ).toBe("https://gpu.lan:8188/");
  });

  it("falls back to the server URL only for a relative ws proxy path", () => {
    expect(comfyFrontendUrl({ envWsBase: "/comfy-ws", page: LOCAL })).toBeNull();
    expect(
      comfyFrontendUrl({
        envWsBase: "/comfy-ws",
        httpUrl: "http://127.0.0.1:8188",
        page: LAN,
      }),
    ).toBe("http://192.168.1.20:8188/");
  });

  it("defaults to the page host on :8188", () => {
    expect(comfyFrontendUrl({ page: LAN })).toBe("http://192.168.1.20:8188/");
  });

  it("toast names the workflow and the sidebar", () => {
    expect(openedComfyToast("Flux Dev")).toBe(
      "Opened ComfyUI — load Flux Dev from the Workflows sidebar",
    );
  });
});

describe("buildEditInComfyMessages (overlay)", () => {
  const wf = { nodes: [{ id: 1, type: "KSampler" }], links: [] };

  it("sends a named load-workflow then show-graph, both with the nonce", () => {
    const [load, show] = buildEditInComfyMessages(wf, "sub/flux.json", "n-123");
    expect(load).toMatchObject({
      type: "cj:load-workflow",
      payload: { workflow: wf, name: "sub/flux.json" },
      nonce: "n-123",
      version: 1,
    });
    expect(show).toMatchObject({
      type: "cj:show-graph",
      payload: {},
      nonce: "n-123",
    });
    expect(parseCjMessage(load).ok).toBe(true);
    expect(parseCjMessage(show).ok).toBe(true);
  });

  it("refuses to build without a host session nonce", () => {
    expect(() => buildEditInComfyMessages(wf, "a.json", "")).toThrow();
    expect(() => buildShowGraphMessage("")).toThrow();
  });
});

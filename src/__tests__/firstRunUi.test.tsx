/**
 * First-run status hook (shared fetch, auth fallback, reconnect nudge) and
 * the checklist / offline card renders. fetch is stubbed.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstRunStatus } from "@/lib/setup/firstRun";

const mockState = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/hooks/useFirstRunStatus", async (orig) => {
  const real = await orig<typeof import("@/hooks/useFirstRunStatus")>();
  return { ...real, useFirstRunStatus: () => mockState.value };
});

import {
  __resetFirstRunStatus,
  isKnownOffline,
  refreshFirstRunStatus,
} from "@/hooks/useFirstRunStatus";
import { FirstRunChecklist } from "@/components/setup/FirstRunChecklist";
import { OfflineCard } from "@/components/setup/OfflineCard";

function status(over: Partial<FirstRunStatus> = {}): FirstRunStatus {
  return {
    ok: true,
    comfy: { reachable: true, url: "http://127.0.0.1:8188" },
    comfyRoot: "/srv/ComfyUI",
    createModel: {
      state: "ok",
      packId: "sdxl",
      packName: "SDXL",
      using: "a.safetensors",
      missing: [],
    },
    ...over,
  };
}

const offlineStatus = status({
  comfy: { reachable: false, url: "http://127.0.0.1:8188" },
  createModel: {
    state: "unknown",
    packId: "sdxl",
    packName: "SDXL",
    missing: [],
  },
});

function hookValue(
  s: FirstRunStatus | null,
  extra: Record<string, unknown> = {},
) {
  return {
    status: s,
    loading: false,
    error: null,
    checkedAt: 1,
    offline: s ? !s.comfy.reachable : false,
    wsConnected: false,
    refresh: vi.fn(),
    ...extra,
  };
}

describe("refreshFirstRunStatus", () => {
  const dispatchEvent = vi.fn();
  beforeEach(() => {
    __resetFirstRunStatus();
    dispatchEvent.mockReset();
    vi.stubGlobal("window", { dispatchEvent });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("dedupes concurrent checks and passes the picked model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(status()));
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([
      refreshFirstRunStatus({ model: "my model.safetensors", force: true }),
      refreshFirstRunStatus({ force: true }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/setup/first-run?model=my%20model.safetensors",
    );
    // Fresh result: a non-forced check is skipped.
    await refreshFirstRunStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("without admin access falls back to /api/health", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(json({ comfyui: "disconnected" }));
    vi.stubGlobal("fetch", fetchMock);
    await refreshFirstRunStatus({ force: true });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/health");
  });

  it("offline -> online nudges the socket to reconnect", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(offlineStatus))
      .mockResolvedValueOnce(json(status()));
    vi.stubGlobal("fetch", fetchMock);
    await refreshFirstRunStatus({ force: true });
    expect(dispatchEvent).not.toHaveBeenCalled();
    await refreshFirstRunStatus({ force: true });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0][0].type).toBe("cj:ws-reconnect");
  });
});

describe("isKnownOffline", () => {
  const snap = (s: FirstRunStatus | null) => ({
    status: s,
    loading: false,
    error: null,
    checkedAt: 0,
  });
  it("only when the probe says unreachable and the socket is down", () => {
    expect(isKnownOffline(snap(offlineStatus), false)).toBe(true);
    expect(isKnownOffline(snap(offlineStatus), true)).toBe(false);
    expect(isKnownOffline(snap(null), false)).toBe(false);
    expect(isKnownOffline(snap(status()), false)).toBe(false);
  });
});

describe("FirstRunChecklist", () => {
  it("offline never reads as 'No images yet'; shows the start command", () => {
    mockState.value = hookValue(offlineStatus);
    const html = renderToStaticMarkup(<FirstRunChecklist />);
    expect(html).not.toContain("No images yet");
    expect(html).toContain(
      'data-testid="first-run-row-comfy" data-state="fail"',
    );
    expect(html).toContain("COMFY_DIR=/srv/ComfyUI scripts/start-comfyui.sh");
    expect(html).toContain("--enable-cors-header");
    expect(html).toContain("Check again");
  });

  it("missing model shows the starter download", () => {
    mockState.value = hookValue(
      status({
        createModel: {
          state: "fail",
          packId: "sdxl",
          packName: "SDXL",
          missing: ["checkpoints/*"],
          starter: {
            label: "SDXL base 1.0",
            file: "sd_xl_base_1.0.safetensors",
            folder: "checkpoints",
            url: "https://huggingface.co/x/resolve/abc/sd_xl_base_1.0.safetensors",
            sizeBytes: 6_938_078_334,
          },
        },
      }),
    );
    const html = renderToStaticMarkup(<FirstRunChecklist />);
    expect(html).toContain(
      'data-testid="first-run-row-model" data-state="fail"',
    );
    expect(html).toContain("a model in models/checkpoints");
    expect(html).toContain("6.9 GB");
    expect(html).toContain(
      "curl -L -C - -o /srv/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors",
    );
  });

  it("missing Krea 2 model shows the starter pack command", () => {
    mockState.value = hookValue(
      status({
        createModel: {
          state: "fail",
          packId: "krea2",
          packName: "Krea 2",
          missing: ["diffusion_models/krea2_turbo_bf16.safetensors"],
          starterPack: {
            id: "images-best",
            title: "Images: best quality",
            sizeBytes: 35_412_858_238,
            command:
              "node scripts/fetch-models.mjs --pack images-best --comfy /srv/ComfyUI --yes",
          },
        },
      }),
    );
    const html = renderToStaticMarkup(<FirstRunChecklist />);
    expect(html).toContain("Images: best quality");
    expect(html).toContain("35.4 GB");
    expect(html).toContain("--pack images-best --comfy /srv/ComfyUI --yes");
    expect(html).not.toContain("SDXL");
  });

  it("all good: offers the sample prompt, no fix commands", () => {
    mockState.value = hookValue(status());
    const html = renderToStaticMarkup(<FirstRunChecklist />);
    expect(html).toContain("first-run-sample");
    expect(html).toContain("Model ready: a.safetensors");
    expect(html).not.toContain("copy-command-text");
    expect(html).not.toContain("Check again");
  });

  it("remote ComfyUI: no local start command", () => {
    mockState.value = hookValue(
      status({
        comfy: { reachable: false, url: "http://192.168.1.20:8188" },
        createModel: {
          state: "unknown",
          packId: "",
          packName: "",
          missing: [],
        },
      }),
    );
    const html = renderToStaticMarkup(<FirstRunChecklist />);
    expect(html).not.toContain("start-comfyui.sh");
    // The fix is a button into the Setup wizard; the env var is the
    // advanced footnote, not the instruction.
    expect(html).toContain('data-testid="change-connection"');
    expect(html).toContain("Change connection");
    expect(html).toContain("COMFY_HTTP_URL");
    expect(html).not.toContain("fix COMFY_HTTP_URL");
  });

  it("local ComfyUI down: start command, no Change connection", () => {
    mockState.value = hookValue(offlineStatus);
    const html = renderToStaticMarkup(<FirstRunChecklist />);
    expect(html).toContain("start-comfyui.sh");
    expect(html).not.toContain('data-testid="change-connection"');
  });
});

describe("OfflineCard", () => {
  it("renders when offline, with a 44px Retry", () => {
    mockState.value = hookValue(offlineStatus);
    const html = renderToStaticMarkup(
      <OfflineCard dismissed={false} onDismiss={() => {}} />,
    );
    expect(html).toContain('data-testid="offline-card"');
    expect(html).toContain("Retry");
    expect(html).toMatch(/min-h-\[44px\][^"]*"[^>]*>[\s\S]*Retry/);
    expect(html).toContain("scripts/start-comfyui.sh");
  });

  it("remote ComfyUI down: Change connection instead of 'fix COMFY_HTTP_URL'", () => {
    mockState.value = hookValue(
      status({
        comfy: { reachable: false, url: "http://gpu-box.local:8188" },
        createModel: { state: "unknown", packId: "", packName: "", missing: [] },
      }),
    );
    const html = renderToStaticMarkup(
      <OfflineCard dismissed={false} onDismiss={() => {}} />,
    );
    expect(html).toContain('data-testid="change-connection"');
    expect(html).not.toContain("fix COMFY_HTTP_URL");
    expect(html).not.toContain("start-comfyui.sh");
  });

  it("hidden when online or dismissed", () => {
    mockState.value = hookValue(status());
    expect(
      renderToStaticMarkup(
        <OfflineCard dismissed={false} onDismiss={() => {}} />,
      ),
    ).toBe("");
    mockState.value = hookValue(offlineStatus);
    expect(
      renderToStaticMarkup(<OfflineCard dismissed onDismiss={() => {}} />),
    ).toBe("");
  });
});

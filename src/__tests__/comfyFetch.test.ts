import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://comfy.test:8188/" },
}));

import {
  comfyFetch,
  comfyUrl,
  isComfyAuthConfigured,
  withComfyAuth,
} from "@/lib/comfy/comfyFetch";

const fetchMock = vi.fn(async () => new Response("{}"));

function lastCall(): [string, RequestInit | undefined] {
  const call = fetchMock.mock.calls.at(-1) as unknown as [
    string,
    RequestInit | undefined,
  ];
  return call;
}

function authOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}

describe("comfyFetch", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("prefixes the configured base (trailing slash stripped)", async () => {
    await comfyFetch("/object_info");
    expect(lastCall()[0]).toBe("http://comfy.test:8188/object_info");
    expect(comfyUrl("history?max_items=3")).toBe(
      "http://comfy.test:8188/history?max_items=3",
    );
  });

  it("passes init through untouched when no token is configured", async () => {
    vi.stubEnv("COMFY_BEARER", "");
    const init = { method: "POST", headers: { "X-A": "1" } };
    await comfyFetch("/prompt", init);
    expect(lastCall()[1]).toEqual(init);
    expect(isComfyAuthConfigured()).toBe(false);
  });

  it("adds Authorization: Bearer when COMFY_BEARER is set", async () => {
    vi.stubEnv("COMFY_BEARER", "  s3cret  ");
    await comfyFetch("/queue", { headers: { "Content-Type": "x" } });
    const [, init] = lastCall();
    expect(authOf(init)).toBe("Bearer s3cret");
    expect(new Headers(init?.headers).get("content-type")).toBe("x");
  });

  it("overrides a caller Authorization header with the ComfyUI token", () => {
    vi.stubEnv("COMFY_BEARER", "tok");
    const init = withComfyAuth({ headers: { Authorization: "Bearer admin" } });
    expect(authOf(init)).toBe("Bearer tok");
  });

  it("uses an explicit baseUrl and still authenticates", async () => {
    vi.stubEnv("COMFY_BEARER", "tok");
    await comfyFetch("/system_stats", { baseUrl: "http://127.0.0.1:8189" });
    const [url, init] = lastCall();
    expect(url).toBe("http://127.0.0.1:8189/system_stats");
    expect(authOf(init)).toBe("Bearer tok");
    expect(init).not.toHaveProperty("baseUrl");
  });

  it("only sends the token to absolute URLs on a ComfyUI origin", async () => {
    vi.stubEnv("COMFY_BEARER", "tok");
    await comfyFetch("http://comfy.test:8188/view?filename=a.png");
    expect(authOf(lastCall()[1])).toBe("Bearer tok");

    await comfyFetch("http://stylevault.test:8000/img.png");
    expect(authOf(lastCall()[1])).toBeNull();

    await comfyFetch("http://comfy.test:9999/view");
    expect(authOf(lastCall()[1])).toBeNull();
  });
});

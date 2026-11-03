/**
 * lib/net/bindPolicy + instrumentation: a non-loopback bind (CJ_HOST)
 * without ADMIN_API_KEY refuses to boot.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindRequiresKey, isLoopbackHostname } from "@/lib/net/bindPolicy";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bindPolicy", () => {
  it("recognises loopback names only", () => {
    for (const h of ["localhost", "a.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopbackHostname(h), h).toBe(true);
    }
    for (const h of ["0.0.0.0", "::", "192.168.1.20", "studio.local", "example.com"]) {
      expect(isLoopbackHostname(h), h).toBe(false);
    }
  });

  it("requires a key only for a non-loopback CJ_HOST", () => {
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("CJ_HOST", "");
    expect(bindRequiresKey()).toBe(false);
    vi.stubEnv("CJ_HOST", "127.0.0.1");
    expect(bindRequiresKey()).toBe(false);
    vi.stubEnv("CJ_HOST", "0.0.0.0");
    expect(bindRequiresKey()).toBe(true);
    vi.stubEnv("ADMIN_API_KEY", "k".repeat(40));
    expect(bindRequiresKey()).toBe(false);
  });

  it("instrumentation refuses to boot on 0.0.0.0 without a key", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("CJ_HOST", "0.0.0.0");
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { register } = await import("@/instrumentation");
    await expect(register()).rejects.toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/ADMIN_API_KEY/);
  });

  it("treats a wildcard HOSTNAME (standalone server.js / Docker) as exposed when CJ_HOST is unset", () => {
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("CJ_HOST", "");
    vi.stubEnv("HOSTNAME", "0.0.0.0");
    expect(bindRequiresKey()).toBe(true);
    vi.stubEnv("HOSTNAME", "my-box");
    expect(bindRequiresKey()).toBe(false);
    // docker-compose publishes on loopback and says so via CJ_HOST.
    vi.stubEnv("HOSTNAME", "0.0.0.0");
    vi.stubEnv("CJ_HOST", "127.0.0.1");
    expect(bindRequiresKey()).toBe(false);
  });

  async function bootWith(env: Record<string, string>, argv: string[]) {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("CJ_HOST", "");
    vi.stubEnv("HOSTNAME", "");
    vi.stubEnv("__NEXT_PRIVATE_ORIGIN", "");
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const origArgv = process.argv;
    process.argv = argv;
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    // lib/env's startup check pings ComfyUI; keep tests offline.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    try {
      const { register } = await import("@/instrumentation");
      await register().catch((e: Error) => {
        if (!/^exit /.test(e.message)) throw e;
      });
    } finally {
      process.argv = origArgv;
    }
    return exit.mock.calls.length > 0;
  }

  it("instrumentation refuses a bare `next start` (no -H, no CJ_HOST) without a key", async () => {
    expect(await bootWith({}, ["node", "next", "start"])).toBe(true);
  });

  it("instrumentation refuses `next start -H 0.0.0.0` without a key", async () => {
    expect(await bootWith({}, ["node", "next", "start", "-H", "0.0.0.0"])).toBe(true);
  });

  it("instrumentation boots `next start -H 127.0.0.1` without a key", async () => {
    expect(await bootWith({}, ["node", "next", "start", "-H", "127.0.0.1"])).toBe(false);
  });

  it("instrumentation boots Docker published on loopback (CJ_HOST from compose)", async () => {
    expect(
      await bootWith({ HOSTNAME: "0.0.0.0", CJ_HOST: "127.0.0.1" }, ["node", "server.js"]),
    ).toBe(false);
    expect(await bootWith({ HOSTNAME: "0.0.0.0", CJ_HOST: "0.0.0.0" }, ["node", "server.js"])).toBe(
      true,
    );
  });
});

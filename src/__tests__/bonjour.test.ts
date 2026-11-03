import { spawn } from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

import { buildBonjourArgs, initBonjour, shouldAdvertise } from "@/lib/bonjour";

const spawnMock = vi.mocked(spawn);

beforeEach(() => {
  delete (globalThis as { __cjBonjour?: unknown }).__cjBonjour;
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ once: vi.fn(), kill: vi.fn() } as never);
  vi.stubEnv("HOSTNAME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Bonjour advertising", () => {
  it("constructs the dns-sd registration arguments", () => {
    expect(buildBonjourArgs("studio-mac", "0.3.0", 4000)).toEqual([
      "-R",
      "Adrift (studio-mac)",
      "_cj._tcp",
      "local.",
      "4000",
      "version=0.3.0",
      "path=/api/health",
    ]);
  });

  it.skipIf(process.platform !== "darwin")(
    "spawns dns-sd only once across repeated initialization",
    () => {
      vi.stubEnv("CJ_HOST", "0.0.0.0");
      initBonjour();
      initBonjour();

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith(
        "dns-sd",
        expect.arrayContaining(["-R", "_cj._tcp", "path=/api/health"]),
        { stdio: "ignore" },
      );
    },
  );

  it("does not advertise when bound to loopback or the default", () => {
    vi.stubEnv("CJ_HOST", "127.0.0.1");
    initBonjour();
    expect(spawnMock).not.toHaveBeenCalled();

    delete (globalThis as { __cjBonjour?: unknown }).__cjBonjour;
    vi.stubEnv("CJ_HOST", "");
    initBonjour();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("advertises only for a non-loopback bind host", () => {
    expect(shouldAdvertise("0.0.0.0")).toBe(true);
    expect(shouldAdvertise("192.0.2.10")).toBe(true);
    expect(shouldAdvertise("::")).toBe(true);
    expect(shouldAdvertise("127.0.0.1")).toBe(false);
    expect(shouldAdvertise("localhost")).toBe(false);
    expect(shouldAdvertise("::1")).toBe(false);
    expect(shouldAdvertise("")).toBe(false);
  });
});

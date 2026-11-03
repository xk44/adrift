/**
 * Calm startup logs (critique #23): ADMIN_API_KEY warning only when the
 * server may be reachable from other machines; a missing saved-workflows
 * folder is info, not a warning.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminKeyNotice,
  isLoopbackHost,
  resolveBindHost,
} from "@/lib/bindHost";

describe("isLoopbackHost", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "localhost",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
  ])("%s is loopback", (h) => expect(isLoopbackHost(h)).toBe(true));
  it.each([
    "0.0.0.0",
    "::",
    "[::]",
    "192.168.1.10",
    "10.0.0.2",
    "example.com",
    "128.0.0.1",
  ])("%s is not loopback", (h) => expect(isLoopbackHost(h)).toBe(false));
});

describe("resolveBindHost", () => {
  it("reads -H / --hostname from argv (next start)", () => {
    expect(
      resolveBindHost({
        env: {},
        argv: ["node", "next", "start", "-H", "127.0.0.1"],
      }),
    ).toEqual({
      host: "127.0.0.1",
      kind: "loopback",
    });
    expect(
      resolveBindHost({ env: {}, argv: ["next", "--hostname=0.0.0.0"] }),
    ).toEqual({
      host: "0.0.0.0",
      kind: "network",
    });
  });

  it("reads Next's origin in the dev worker", () => {
    expect(
      resolveBindHost({
        env: { __NEXT_PRIVATE_ORIGIN: "http://127.0.0.1:3000" },
        argv: [],
      }),
    ).toEqual({ host: "127.0.0.1", kind: "loopback" });
    expect(
      resolveBindHost({
        env: { __NEXT_PRIVATE_ORIGIN: "http://192.168.1.5:3000" },
        argv: [],
      }).kind,
    ).toBe("network");
  });

  it("treats a bare localhost origin as unknown (Next writes it for 'all interfaces' too)", () => {
    expect(
      resolveBindHost({
        env: { __NEXT_PRIVATE_ORIGIN: "http://localhost:3000" },
        argv: [],
      }),
    ).toEqual({ host: null, kind: "unknown" });
    expect(resolveBindHost({ env: {}, argv: [] }).kind).toBe("unknown");
    expect(
      resolveBindHost({ env: { __NEXT_PRIVATE_ORIGIN: "not a url" }, argv: [] })
        .kind,
    ).toBe("unknown");
  });

  it("treats a [::1] origin as unknown (Next writes it for -H :: too)", () => {
    expect(
      resolveBindHost({
        env: { __NEXT_PRIVATE_ORIGIN: "http://[::1]:3000" },
        argv: [],
      }).kind,
    ).toBe("unknown");
  });

  it("a wildcard HOSTNAME (standalone server.js / Docker) is a network bind", () => {
    expect(
      resolveBindHost({
        env: {
          HOSTNAME: "0.0.0.0",
          __NEXT_PRIVATE_ORIGIN: "http://localhost:3000",
        },
        argv: [],
      }),
    ).toEqual({ host: "0.0.0.0", kind: "network" });
    // A machine name in HOSTNAME (set by shells/containers) is ignored.
    expect(
      resolveBindHost({ env: { HOSTNAME: "my-box" }, argv: [] }).kind,
    ).toBe("unknown");
  });

  it("argv wins over the origin", () => {
    expect(
      resolveBindHost({
        env: { __NEXT_PRIVATE_ORIGIN: "http://127.0.0.1:3000" },
        argv: ["-H", "0.0.0.0"],
      }).kind,
    ).toBe("network");
  });
});

describe("adminKeyNotice", () => {
  it("is silent on loopback or when the key is set", () => {
    expect(
      adminKeyNotice({ host: "127.0.0.1", kind: "loopback" }, false),
    ).toBeNull();
    expect(
      adminKeyNotice({ host: "0.0.0.0", kind: "network" }, true),
    ).toBeNull();
    expect(adminKeyNotice({ host: null, kind: "unknown" }, true)).toBeNull();
  });

  it("shouts on a network bind", () => {
    const n = adminKeyNotice({ host: "0.0.0.0", kind: "network" }, false)!;
    expect(n.text).toContain("!".repeat(72));
    expect(n.text).toContain("listening on 0.0.0.0");
    expect(n.text).toContain("-H 127.0.0.1");
  });

  it("is one plain line when the bind is unknown", () => {
    const n = adminKeyNotice({ host: null, kind: "unknown" }, false)!;
    expect(n.text.split("\n")).toHaveLength(1);
    expect(n.text).not.toContain("!!!");
    expect(n.text).toContain("-H 127.0.0.1");
  });
});

describe("runStartupChecks log levels", () => {
  const saved = { ...process.env };
  const savedArgv = process.argv;
  let tmp: string;
  let warn: { mock: { calls: unknown[][] } };
  let info: { mock: { calls: unknown[][] } };

  beforeEach(() => {
    vi.resetModules();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adrift-startup-"));
    process.env.COMFY_ROOT = tmp; // exists, but no user/default/workflows
    process.env.COMFY_HTTP_URL = "http://127.0.0.1:9";
    delete process.env.ADMIN_API_KEY;
    delete process.env.__NEXT_PRIVATE_ORIGIN;
    process.argv = ["node", "test"];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...saved };
    process.argv = savedArgv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const run = async () => {
    const { runStartupChecks } = await import("@/lib/env");
    runStartupChecks();
    return warn.mock.calls.map((c) => String(c[0])).join("\n");
  };

  it("loopback dev server: no ADMIN warning, workflows folder is info", async () => {
    process.env.__NEXT_PRIVATE_ORIGIN = "http://127.0.0.1:3000";
    const warned = await run();
    expect(warned).not.toContain("ADMIN_API_KEY");
    expect(warned).not.toContain("workflows");
    expect(info.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "No saved ComfyUI workflows yet",
    );
  });

  it("network bind without a key: loud warning", async () => {
    process.argv = ["node", "next", "start", "-H", "0.0.0.0"];
    const warned = await run();
    expect(warned).toContain("authentication is OFF");
  });

  it("key set: silent even on a network bind", async () => {
    process.argv = ["node", "next", "start", "-H", "0.0.0.0"];
    process.env.ADMIN_API_KEY = "test-key";
    const warned = await run();
    expect(warned).not.toContain("ADMIN_API_KEY");
  });
});

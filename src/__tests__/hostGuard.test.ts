/**
 * DNS-rebinding guard: with ADMIN_API_KEY unset, requests whose Host header
 * is not loopback (or listed in CJ_ALLOWED_HOSTS) are rejected. LAN IPs and
 * .local names need ADMIN_API_KEY.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hostnameOf, isTrustedDevHost } from "@/lib/hostGuard";

describe("hostnameOf", () => {
  it("strips the port and trailing dot, keeps IPv6 brackets", () => {
    expect(hostnameOf("LocalHost:3000")).toBe("localhost");
    expect(hostnameOf("example.com.:3000")).toBe("example.com");
    expect(hostnameOf("[::1]:3000")).toBe("[::1]");
    expect(hostnameOf("203.0.113.7")).toBe("203.0.113.7");
  });
});

describe("isTrustedDevHost", () => {
  it.each([
    "localhost:3000",
    "localhost",
    "app.localhost:3000",
    "127.0.0.1:3000",
    "127.0.0.2",
    "[::1]:3000",
  ])("trusts %s", (host) => {
    expect(isTrustedDevHost(host, "")).toBe(true);
  });

  it.each([
    "attacker.example:3000",
    "rebind.example.com",
    "127.0.0.1.attacker.example:3000",
    "localhost.attacker.example:3000",
    "999.1.1.1:3000",
    "local:3000",
    "0.0.0.0:3000",
    "203.0.113.7:3000",
    "192.168.1.20:3000",
    "10.0.0.5",
    "[fe80::1]:3000",
    "studio-mac.local:3000",
    "",
  ])("rejects %s", (host) => {
    expect(isTrustedDevHost(host, "")).toBe(false);
  });

  it("rejects a missing Host", () => {
    expect(isTrustedDevHost(null, "")).toBe(false);
  });

  it("honours CJ_ALLOWED_HOSTS entries and the * escape hatch", () => {
    expect(
      isTrustedDevHost("box.tailnet.example:3000", "box.tailnet.example"),
    ).toBe(true);
    expect(
      isTrustedDevHost(
        "BOX.tailnet.example",
        "other.example, box.tailnet.example",
      ),
    ).toBe(true);
    expect(isTrustedDevHost("attacker.example", "box.tailnet.example")).toBe(
      false,
    );
    expect(isTrustedDevHost("attacker.example", "*")).toBe(true);
  });
});

describe("requireAdmin dev mode (no ADMIN_API_KEY)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load() {
    vi.stubEnv("ADMIN_API_KEY", "");
    vi.stubEnv("CJ_ALLOWED_HOSTS", "");
    vi.resetModules();
    return import("@/lib/auth");
  }

  it("rejects a rebound foreign Host (403) even with a matching Origin", async () => {
    const { requireAdmin } = await load();
    const res = requireAdmin(
      new NextRequest(
        "http://attacker.example:3000/api/comfy/manager/install",
        {
          method: "POST",
          headers: {
            host: "attacker.example:3000",
            origin: "http://attacker.example:3000",
          },
        },
      ),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(403);
  });

  it("rejects foreign Host on GETs too", async () => {
    const { requireAdmin } = await load();
    const res = requireAdmin(
      new NextRequest("http://attacker.example:3000/api/jobs/recent", {
        headers: { host: "attacker.example:3000" },
      }),
    );
    expect(res.ok).toBe(false);
  });

  it("allows loopback hosts only", async () => {
    const { requireAdmin } = await load();
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      const res = requireAdmin(
        new NextRequest(`http://${host}/api/jobs/recent`, {
          headers: { host },
        }),
      );
      expect(res.ok, host).toBe(true);
    }
  });

  it("rejects a LAN IP or .local Host without a key (403)", async () => {
    const { requireAdmin } = await load();
    for (const host of ["192.168.1.20:3000", "studio-mac.local:3000"]) {
      const res = requireAdmin(
        new NextRequest(`http://${host}/api/jobs/recent`, {
          headers: { host },
        }),
      );
      expect(res.ok, host).toBe(false);
      if (!res.ok) expect(res.response.status).toBe(403);
    }
  });

  it("falls back to the request URL host when no Host header is present", async () => {
    const { requireAdmin } = await load();
    expect(requireAdmin(new NextRequest("http://localhost/api/x")).ok).toBe(
      true,
    );
  });

  it("does not apply when ADMIN_API_KEY is set (credentials decide)", async () => {
    vi.stubEnv("ADMIN_API_KEY", "k".repeat(32));
    vi.resetModules();
    const { requireAdmin } = await import("@/lib/auth");
    const res = requireAdmin(
      new NextRequest("http://cj.example.org/api/x", {
        headers: {
          host: "cj.example.org",
          authorization: `Bearer ${"k".repeat(32)}`,
        },
      }),
    );
    expect(res.ok).toBe(true);
  });
});

/**
 * lib/net/safeFetch + addressPolicy: SSRF guard for user-supplied URLs.
 * No external network: a local server is reached only through `allowHosts`
 * (exact host:port) and public names go through an injected resolver.
 */
import http from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isBlockedAddress, isBlockedHostname } from "@/lib/net/addressPolicy";
import {
  checkFetchUrl,
  safeFetchBytes,
  SafeFetchError,
} from "@/lib/net/safeFetch";

describe("addressPolicy", () => {
  it.each([
    "127.0.0.1",
    "127.9.9.9",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.234",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "[::1]",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
  ])("allows public %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  it("blocks local-only names without DNS", () => {
    for (const h of [
      "localhost",
      "a.localhost",
      "nas.local",
      "metadata.google.internal",
      "x.home.arpa",
    ]) {
      expect(isBlockedHostname(h)).toBe(true);
    }
    expect(isBlockedHostname("example.com")).toBe(false);
  });
});

describe("checkFetchUrl", () => {
  it("rejects loopback, metadata and private literals", () => {
    for (const u of [
      "http://127.0.0.1/x.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/a.png",
      "http://[::1]:8188/view",
      "http://2130706433/", // decimal 127.0.0.1, normalised by the URL parser
      "http://0x7f.1/",
    ]) {
      expect(() => checkFetchUrl(u), u).toThrow(SafeFetchError);
    }
  });

  it("rejects non-http schemes and embedded credentials", () => {
    expect(() => checkFetchUrl("file:///etc/passwd")).toThrow(/http/);
    expect(() => checkFetchUrl("https://user:pw@example.com/a.png")).toThrow(
      /credentials/,
    );
  });

  it("lets the exact configured backend host through, not its neighbours", () => {
    expect(
      checkFetchUrl("http://127.0.0.1:8188/view?x=1", ["http://127.0.0.1:8188"])
        .host,
    ).toBe("127.0.0.1:8188");
    expect(() =>
      checkFetchUrl("http://127.0.0.1:3000/api", ["http://127.0.0.1:8188"]),
    ).toThrow(SafeFetchError);
  });
});

describe("safeFetchBytes", () => {
  let server: http.Server;
  let base = "";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from([1, 2, 3]));
      } else if (req.url === "/to-metadata") {
        res.writeHead(302, {
          location: "http://169.254.169.254/latest/meta-data/",
        });
        res.end();
      } else if (req.url === "/to-private") {
        res.writeHead(301, { location: "http://10.0.0.1/secret" });
        res.end();
      } else if (req.url === "/to-nip") {
        res.writeHead(302, { location: "http://127.0.0.1.nip.io/" });
        res.end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else if (req.url === "/big") {
        res.writeHead(200);
        res.write(Buffer.alloc(4096));
        res.end(Buffer.alloc(4096));
      } else if (req.url === "/stall") {
        res.writeHead(200);
        res.write("x"); // then never finish
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });

  it("refuses 127.0.0.1 / 169.254.169.254 / 10.x without a network call", async () => {
    for (const u of [
      `${base}/ok`,
      "http://169.254.169.254/",
      "http://10.1.1.1/a.png",
    ]) {
      await expect(safeFetchBytes(u), u).rejects.toMatchObject({
        code: "blocked",
      });
    }
  });

  it("fetches from an explicitly trusted backend", async () => {
    const r = await safeFetchBytes(`${base}/ok`, { allowHosts: [base] });
    expect([...r.bytes]).toEqual([1, 2, 3]);
    expect(r.contentType).toBe("image/png");
  });

  it("re-checks redirects: trusted host → metadata / private / nip.io is blocked", async () => {
    const resolve = async (h: string) =>
      h === "127.0.0.1.nip.io" ? [{ address: "127.0.0.1", family: 4 }] : [];
    for (const p of ["/to-metadata", "/to-private", "/to-nip"]) {
      await expect(
        safeFetchBytes(`${base}${p}`, { allowHosts: [base], resolve }),
        p,
      ).rejects.toMatchObject({
        code: "blocked",
      });
    }
  });

  it("blocks a public-looking name that resolves to a private address (nip.io / rebinding)", async () => {
    const resolve = async () => [{ address: "192.168.1.234", family: 4 }];
    await expect(
      safeFetchBytes("http://192.168.1.234.nip.io/a.png", { resolve }),
    ).rejects.toMatchObject({
      code: "blocked",
    });
    const mixed = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    await expect(
      safeFetchBytes("http://rebind.example/a.png", { resolve: mixed }),
    ).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("caps redirects, size and idle time", async () => {
    await expect(
      safeFetchBytes(`${base}/loop`, { allowHosts: [base] }),
    ).rejects.toMatchObject({
      code: "too_many_redirects",
    });
    await expect(
      safeFetchBytes(`${base}/big`, { allowHosts: [base], maxBytes: 5000 }),
    ).rejects.toMatchObject({
      code: "too_large",
    });
    await expect(
      safeFetchBytes(`${base}/stall`, {
        allowHosts: [base],
        idleTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("reports HTTP errors", async () => {
    await expect(
      safeFetchBytes(`${base}/missing`, { allowHosts: [base] }),
    ).rejects.toMatchObject({
      code: "http_error",
      status: 404,
    });
  });
});

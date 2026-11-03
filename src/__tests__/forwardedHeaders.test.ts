/**
 * B4: client-sent X-Forwarded-For / X-Real-IP must not reach the loopback
 * checks unless TRUST_PROXY is set.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "events";
import type { IncomingMessage } from "http";
import {
  installForwardedHeaderGuard,
  sanitizeForwardedHeaders,
} from "@/lib/net/forwardedHeaders";

function fakeReq(remote: string, headers: Record<string, string>): IncomingMessage {
  const raw: string[] = [];
  for (const [k, v] of Object.entries(headers)) raw.push(k, v);
  return {
    socket: { remoteAddress: remote },
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    rawHeaders: raw,
  } as unknown as IncomingMessage;
}

describe("sanitizeForwardedHeaders", () => {
  it("replaces a forged X-Forwarded-For with the socket address and drops X-Real-IP", () => {
    const req = fakeReq("10.0.0.9", {
      Host: "localhost:3000",
      "X-Forwarded-For": "127.0.0.1",
      "X-Real-IP": "127.0.0.1",
    });
    sanitizeForwardedHeaders(req);
    expect(req.headers["x-forwarded-for"]).toBe("10.0.0.9");
    expect(req.headers["x-real-ip"]).toBeUndefined();
    expect(req.rawHeaders).toEqual(["Host", "localhost:3000", "X-Forwarded-For", "10.0.0.9"]);
  });
});

describe("installForwardedHeaderGuard", () => {
  it("sanitizes request/upgrade events once installed, idempotently", () => {
    class S extends EventEmitter {}
    expect(installForwardedHeaderGuard([S.prototype as never], {})).toBe(true);
    installForwardedHeaderGuard([S.prototype as never], {});
    const server = new S();
    const seen: string[] = [];
    server.on("request", (r: IncomingMessage) => seen.push(String(r.headers["x-forwarded-for"])));
    server.emit("request", fakeReq("10.0.0.9", { "X-Forwarded-For": "127.0.0.1" }));
    expect(seen).toEqual(["10.0.0.9"]);
  });

  it("is a no-op with TRUST_PROXY=1", () => {
    class S extends EventEmitter {}
    const before = S.prototype.emit;
    expect(installForwardedHeaderGuard([S.prototype as never], { TRUST_PROXY: "1" })).toBe(false);
    expect(S.prototype.emit).toBe(before);
  });
});

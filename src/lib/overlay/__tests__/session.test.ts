import { describe, expect, it } from "vitest";
import { createOverlayInboundGuard, resolveParentOrigin } from "../session";
import { buildCjMessage, HOST_MSG, OVERLAY_MSG } from "../protocol";

const HOST = "http://127.0.0.1:8188";
const parent = { name: "parent-window" };

const config = (nonce: string) =>
  buildCjMessage(
    HOST_MSG.CONFIG,
    {
      comfyUrl: HOST,
      wsUrl: "ws://127.0.0.1:8188",
      clientId: "cj_overlay_x",
      mode: "overlay",
      nonce,
    },
    nonce,
  );

const visibility = (nonce?: string) =>
  buildCjMessage(HOST_MSG.VISIBILITY, { visible: false }, nonce);

describe("createOverlayInboundGuard", () => {
  it("rejects messages whose source is not the parent window", () => {
    const guard = createOverlayInboundGuard({
      expectedSource: parent,
      parentOrigin: HOST,
    });
    expect(
      guard.accept({ data: visibility(), origin: HOST, source: { other: 1 } }),
    ).toEqual({ ok: false, reason: "source" });
    expect(
      guard.accept({ data: visibility(), origin: HOST, source: null }),
    ).toEqual({ ok: false, reason: "source" });
  });

  it("rejects a known parent origin mismatch", () => {
    const guard = createOverlayInboundGuard({
      expectedSource: parent,
      parentOrigin: HOST,
    });
    expect(
      guard.accept({
        data: visibility(),
        origin: "https://evil.example",
        source: parent,
      }),
    ).toEqual({ ok: false, reason: "origin" });
  });

  it("locks to the first accepted origin when the parent origin is unknown", () => {
    const guard = createOverlayInboundGuard({ expectedSource: parent });
    expect(guard.origin).toBe("");
    expect(
      guard.accept({ data: visibility(), origin: HOST, source: parent }).ok,
    ).toBe(true);
    expect(guard.origin).toBe(HOST);
    expect(
      guard.accept({
        data: visibility(),
        origin: "http://other:1",
        source: parent,
      }),
    ).toEqual({ ok: false, reason: "origin" });
  });

  it("does not lock the origin on malformed or foreign messages", () => {
    const guard = createOverlayInboundGuard({ expectedSource: parent });
    expect(
      guard.accept({
        data: { type: "cj:visibility", payload: { visible: "yes" } },
        origin: "http://first:1",
        source: parent,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
    expect(
      guard.accept({ data: "hello", origin: "http://first:1", source: parent }),
    ).toEqual({ ok: false, reason: "not-cj" });
    expect(guard.origin).toBe("");
  });

  it("rejects overlay→host message types echoed back at the overlay", () => {
    const guard = createOverlayInboundGuard({
      expectedSource: parent,
      parentOrigin: HOST,
    });
    const queue = buildCjMessage(OVERLAY_MSG.QUEUE, { prompt: {} });
    expect(guard.accept({ data: queue, origin: HOST, source: parent })).toEqual(
      {
        ok: false,
        reason: "direction",
      },
    );
    const ack = buildCjMessage(OVERLAY_MSG.ACK, {
      ackType: "cj:queue",
      accepted: true,
      promptId: "p1",
    });
    const decision = guard.accept({ data: ack, origin: HOST, source: parent });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect((decision.message.payload as { promptId?: string }).promptId).toBe(
        "p1",
      );
    }
  });

  it("enforces the session nonce after cj:config and flags new sessions", () => {
    const guard = createOverlayInboundGuard({
      expectedSource: parent,
      parentOrigin: HOST,
    });
    // Before the handshake any nonce (or none) is accepted.
    expect(
      guard.accept({ data: visibility(), origin: HOST, source: parent }).ok,
    ).toBe(true);

    const first = guard.accept({
      data: config("cj_sn_aaa"),
      origin: HOST,
      source: parent,
    });
    expect(first).toMatchObject({ ok: true, newSession: true });
    expect(guard.sessionNonce).toBe("cj_sn_aaa");

    expect(
      guard.accept({
        data: visibility("cj_sn_aaa"),
        origin: HOST,
        source: parent,
      }).ok,
    ).toBe(true);
    expect(
      guard.accept({ data: visibility(), origin: HOST, source: parent }),
    ).toEqual({ ok: false, reason: "nonce" });
    expect(
      guard.accept({
        data: visibility("cj_sn_old"),
        origin: HOST,
        source: parent,
      }),
    ).toEqual({ ok: false, reason: "nonce" });

    // Same config again is not a new session; a new nonce is.
    expect(
      guard.accept({ data: config("cj_sn_aaa"), origin: HOST, source: parent }),
    ).toMatchObject({ ok: true, newSession: false });
    expect(
      guard.accept({ data: config("cj_sn_bbb"), origin: HOST, source: parent }),
    ).toMatchObject({ ok: true, newSession: true });
    expect(
      guard.accept({
        data: visibility("cj_sn_aaa"),
        origin: HOST,
        source: parent,
      }),
    ).toEqual({ ok: false, reason: "nonce" });
  });
});

describe("resolveParentOrigin", () => {
  it("prefers a readable same-origin parent location", () => {
    expect(
      resolveParentOrigin({ parent: { location: { origin: HOST } } }),
    ).toBe(HOST);
  });

  it("falls back to ancestorOrigins when the parent is cross-origin", () => {
    const parentWin = {
      get location(): { origin: string } {
        throw new DOMException("Blocked", "SecurityError");
      },
    };
    expect(
      resolveParentOrigin({
        parent: parentWin,
        location: { ancestorOrigins: [HOST] },
        document: { referrer: "http://ignored:1/" },
      }),
    ).toBe(HOST);
  });

  it("falls back to the referrer origin, then to empty", () => {
    expect(
      resolveParentOrigin({
        location: { ancestorOrigins: [] },
        document: { referrer: "http://127.0.0.1:8188/?workflow=x" },
      }),
    ).toBe(HOST);
    expect(resolveParentOrigin({ document: { referrer: "" } })).toBe("");
    expect(
      resolveParentOrigin({ location: { ancestorOrigins: ["null"] } }),
    ).toBe("");
  });
});

/**
 * Tests for the Adrift Overlay Bridge Protocol
 * ===================================================
 *
 * These tests validate the protocol module is:
 *   1. Explicit about message shapes (Zod schemas catch bad payloads)
 *   2. Inert — no IO, no DOM, no iframe creation
 *   3. Origin-strict — no wildcard trust
 *   4. Internally consistent — FSM transitions are valid
 *   5. Nonce/session-safe — replay protection helpers work correctly
 *   6. Version-negotiation-correct — version range logic is sound
 *   7. State-surface-complete — HostBridgeState tracks all needed fields
 *   8. Event-log-structured — BridgeEvent type produces audit trail entries
 */

import { describe, it, expect } from "vitest";
import {
  CJ_PROTOCOL_VERSION,
  CJ_MIN_SUPPORTED_VERSION,
  CJ_MAX_SUPPORTED_VERSION,
  HOST_MSG,
  OVERLAY_MSG,
  ALL_KNOWN_MESSAGE_TYPES,
  ConfigPayloadSchema,
  HelloPayloadSchema,
  ReadyPayloadSchema,
  RunPayloadSchema,
  InterruptPayloadSchema,
  AckPayloadSchema,
  ProgressPayloadSchema,
  StatusPayloadSchema,
  ImagesPayloadSchema,
  ErrorPayloadSchema,
  CjEnvelopeSchema,
  messageDirection,
  messageRole,
  parseCjMessage,
  buildCjMessage,
  validateOrigin,
  deriveSameOrigin,
  generateNonce,
  validateNonce,
  isNonceFormat,
  negotiateVersion,
  createBridgeEvent,
  createInitialHostBridgeState,
  pushHostBridgeError,
  MAX_RECENT_ERRORS,
  transitionBridge,
  type BridgeState,
  type HostBridgeState,
  type BridgeEvent,
  type VersionNegotiationResult,
} from "../protocol";

// ── Constants ────────────────────────────────────────────────────────

describe("CJ_PROTOCOL_VERSION", () => {
  it("is a positive integer", () => {
    expect(CJ_PROTOCOL_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(CJ_PROTOCOL_VERSION)).toBe(true);
  });
});

describe("CJ_MIN_SUPPORTED_VERSION", () => {
  it("is a positive integer", () => {
    expect(CJ_MIN_SUPPORTED_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(CJ_MIN_SUPPORTED_VERSION)).toBe(true);
  });

  it("is less than or equal to CJ_PROTOCOL_VERSION", () => {
    expect(CJ_MIN_SUPPORTED_VERSION).toBeLessThanOrEqual(CJ_PROTOCOL_VERSION);
  });
});

describe("CJ_MAX_SUPPORTED_VERSION", () => {
  it("is a positive integer", () => {
    expect(CJ_MAX_SUPPORTED_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(CJ_MAX_SUPPORTED_VERSION)).toBe(true);
  });

  it("is greater than or equal to CJ_MIN_SUPPORTED_VERSION", () => {
    expect(CJ_MAX_SUPPORTED_VERSION).toBeGreaterThanOrEqual(
      CJ_MIN_SUPPORTED_VERSION,
    );
  });
});

// ── Message type constants ───────────────────────────────────────────

describe("HOST_MSG", () => {
  it("has all host→overlay message types", () => {
    expect(HOST_MSG.CONFIG).toBe("cj:config");
    expect(HOST_MSG.PROGRESS).toBe("cj:progress");
    expect(HOST_MSG.STATUS).toBe("cj:status");
    expect(HOST_MSG.IMAGES).toBe("cj:images");
    expect(HOST_MSG.ERROR).toBe("cj:error");
  });

  it("has stable values (no accidental refactor)", () => {
    const values = Object.values(HOST_MSG);
    expect(values.length).toBeGreaterThanOrEqual(5);
    values.forEach((v) => expect(v.startsWith("cj:")).toBe(true));
  });
});

describe("OVERLAY_MSG", () => {
  it("has all overlay→host message types", () => {
    expect(OVERLAY_MSG.HELLO).toBe("cj:hello");
    expect(OVERLAY_MSG.READY).toBe("cj:ready");
    expect(OVERLAY_MSG.RUN).toBe("cj:run");
    expect(OVERLAY_MSG.INTERRUPT).toBe("cj:interrupt");
    expect(OVERLAY_MSG.ACK).toBe("cj:ack");
  });

  it("has stable values", () => {
    const values = Object.values(OVERLAY_MSG);
    expect(values.length).toBeGreaterThanOrEqual(5);
    values.forEach((v) => expect(v.startsWith("cj:")).toBe(true));
  });
});

describe("ALL_KNOWN_MESSAGE_TYPES", () => {
  it("contains all HOST_MSG values", () => {
    Object.values(HOST_MSG).forEach((v) => {
      expect(ALL_KNOWN_MESSAGE_TYPES.has(v)).toBe(true);
    });
  });

  it("contains all OVERLAY_MSG values", () => {
    Object.values(OVERLAY_MSG).forEach((v) => {
      expect(ALL_KNOWN_MESSAGE_TYPES.has(v)).toBe(true);
    });
  });

  it("has all host + overlay types", () => {
    const expected =
      Object.values(HOST_MSG).length + Object.values(OVERLAY_MSG).length;
    expect(ALL_KNOWN_MESSAGE_TYPES.size).toBe(expected);
  });

  it("does not contain arbitrary strings", () => {
    expect(ALL_KNOWN_MESSAGE_TYPES.has("cj:bogus")).toBe(false);
    expect(ALL_KNOWN_MESSAGE_TYPES.has("")).toBe(false);
    expect(ALL_KNOWN_MESSAGE_TYPES.has("hello")).toBe(false);
  });
});

// ── Direction helper ──────────────────────────────────────────────────

describe("messageDirection", () => {
  it("identifies host→overlay messages", () => {
    expect(messageDirection("cj:config")).toBe("host→overlay");
    expect(messageDirection("cj:progress")).toBe("host→overlay");
  });

  it("identifies overlay→host messages", () => {
    expect(messageDirection("cj:hello")).toBe("overlay→host");
    expect(messageDirection("cj:run")).toBe("overlay→host");
  });

  it("returns unknown for unrecognized types", () => {
    expect(messageDirection("cj:unknown")).toBe("unknown");
    expect(messageDirection("whatever")).toBe("unknown");
  });
});

// ── Role helper ───────────────────────────────────────────────────────

describe("messageRole", () => {
  it("returns 'host' for host→overlay types", () => {
    expect(messageRole("cj:config")).toBe("host");
    expect(messageRole("cj:progress")).toBe("host");
    expect(messageRole("cj:status")).toBe("host");
    expect(messageRole("cj:images")).toBe("host");
    expect(messageRole("cj:error")).toBe("host");
  });

  it("returns 'overlay' for overlay→host types", () => {
    expect(messageRole("cj:hello")).toBe("overlay");
    expect(messageRole("cj:ready")).toBe("overlay");
    expect(messageRole("cj:run")).toBe("overlay");
    expect(messageRole("cj:interrupt")).toBe("overlay");
    expect(messageRole("cj:ack")).toBe("overlay");
  });

  it("returns 'unknown' for unrecognized types", () => {
    expect(messageRole("cj:unknown")).toBe("unknown");
    expect(messageRole("not-a-type")).toBe("unknown");
    expect(messageRole("config")).toBe("unknown");
  });
});

// ── Payload schemas ───────────────────────────────────────────────────

describe("ConfigPayloadSchema", () => {
  const validConfig = {
    comfyUrl: "http://localhost:8188",
    wsUrl: "ws://localhost:8188",
    clientId: "abc123",
    mode: "overlay" as const,
  };

  it("accepts valid config", () => {
    expect(ConfigPayloadSchema.parse(validConfig)).toEqual(
      expect.objectContaining({ comfyUrl: "http://localhost:8188" }),
    );
  });

  it("accepts config with version", () => {
    expect(
      ConfigPayloadSchema.parse({ ...validConfig, version: 1 }),
    ).toBeDefined();
  });

  it("accepts config with nonce", () => {
    expect(
      ConfigPayloadSchema.parse({
        ...validConfig,
        nonce: "cj_sn_abc123def456",
      }),
    ).toBeDefined();
  });

  it("rejects missing comfyUrl", () => {
    expect(() =>
      ConfigPayloadSchema.parse({ ...validConfig, comfyUrl: undefined }),
    ).toThrow();
  });

  it("rejects invalid URL for comfyUrl", () => {
    expect(() =>
      ConfigPayloadSchema.parse({ ...validConfig, comfyUrl: "not-a-url" }),
    ).toThrow();
  });

  it("rejects wrong mode", () => {
    expect(() =>
      ConfigPayloadSchema.parse({ ...validConfig, mode: "standalone" }),
    ).toThrow();
  });

  it("rejects empty clientId", () => {
    expect(() =>
      ConfigPayloadSchema.parse({ ...validConfig, clientId: "" }),
    ).toThrow();
  });
});

describe("HelloPayloadSchema", () => {
  it("accepts valid hello", () => {
    expect(
      HelloPayloadSchema.parse({ name: "adrift", version: 1 }),
    ).toBeDefined();
  });

  it("accepts hello with nonce", () => {
    expect(
      HelloPayloadSchema.parse({
        name: "adrift",
        version: 1,
        nonce: "cj_sn_abc123",
      }),
    ).toBeDefined();
  });

  it("still accepts the pre-rename name from older bridges", () => {
    expect(
      HelloPayloadSchema.parse({ name: "comfyjourney", version: 1 }), // legacy-name
    ).toEqual({ name: "comfyjourney", version: 1 }); // legacy-name
  });

  it("rejects wrong name", () => {
    expect(() =>
      HelloPayloadSchema.parse({ name: "other", version: 1 }),
    ).toThrow();
  });

  it("rejects missing version", () => {
    expect(() => HelloPayloadSchema.parse({ name: "adrift" })).toThrow();
  });

  it("rejects zero version", () => {
    expect(() =>
      HelloPayloadSchema.parse({ name: "adrift", version: 0 }),
    ).toThrow();
  });

  it("rejects negative version", () => {
    expect(() =>
      HelloPayloadSchema.parse({ name: "adrift", version: -1 }),
    ).toThrow();
  });
});

describe("AckPayloadSchema", () => {
  it("accepts valid ack with required fields", () => {
    expect(
      AckPayloadSchema.parse({ ackType: "cj:config", accepted: true }),
    ).toBeDefined();
  });

  it("accepts ack with error detail", () => {
    expect(
      AckPayloadSchema.parse({
        ackType: "cj:config",
        accepted: false,
        error: "bad payload",
      }),
    ).toBeDefined();
  });

  it("accepts ack with nonce", () => {
    expect(
      AckPayloadSchema.parse({
        ackType: "cj:config",
        accepted: true,
        nonce: "cj_sn_abc123",
      }),
    ).toBeDefined();
  });

  it("rejects ack without ackType", () => {
    expect(() => AckPayloadSchema.parse({ accepted: true })).toThrow();
  });

  it("rejects ack with empty ackType", () => {
    expect(() =>
      AckPayloadSchema.parse({ ackType: "", accepted: true }),
    ).toThrow();
  });

  it("rejects ack without accepted field", () => {
    expect(() => AckPayloadSchema.parse({ ackType: "cj:config" })).toThrow();
  });
});

describe("RunPayloadSchema", () => {
  it("accepts valid run payload", () => {
    expect(
      RunPayloadSchema.parse({ workflow: { nodes: [] }, clientId: "c1" }),
    ).toBeDefined();
  });

  it("accepts run payload with optional promptText", () => {
    expect(
      RunPayloadSchema.parse({
        workflow: {},
        clientId: "c1",
        promptText: "a cat --sref 42",
      }),
    ).toBeDefined();
  });

  it("rejects missing clientId", () => {
    expect(() => RunPayloadSchema.parse({ workflow: {} })).toThrow();
  });
});

describe("ImagesPayloadSchema", () => {
  it("accepts valid images payload", () => {
    const data = {
      promptId: "p1",
      images: [
        { filename: "out.png", type: "output" as const },
        { filename: "in.png", subfolder: "sub", type: "input" as const },
      ],
    };
    expect(ImagesPayloadSchema.parse(data)).toBeDefined();
  });

  it("rejects invalid image type", () => {
    expect(() =>
      ImagesPayloadSchema.parse({
        promptId: "p1",
        images: [{ filename: "a.png", type: "invalid" }],
      }),
    ).toThrow();
  });

  it("rejects empty promptId", () => {
    expect(() =>
      ImagesPayloadSchema.parse({
        promptId: "",
        images: [],
      }),
    ).toThrow();
  });
});

describe("ErrorPayloadSchema", () => {
  it("accepts valid error payload", () => {
    expect(
      ErrorPayloadSchema.parse({
        code: "E001",
        message: "Something went wrong",
      }),
    ).toBeDefined();
  });

  it("accepts error with detail", () => {
    expect(
      ErrorPayloadSchema.parse({
        code: "E001",
        message: "Bad",
        detail: { stack: "..." },
      }),
    ).toBeDefined();
  });

  it("rejects empty code", () => {
    expect(() =>
      ErrorPayloadSchema.parse({ code: "", message: "Bad" }),
    ).toThrow();
  });

  it("rejects empty message", () => {
    expect(() =>
      ErrorPayloadSchema.parse({ code: "E001", message: "" }),
    ).toThrow();
  });
});

// ── Envelope schema ──────────────────────────────────────────────────

describe("CjEnvelopeSchema", () => {
  it("accepts valid envelope", () => {
    expect(
      CjEnvelopeSchema.parse({
        type: "cj:hello",
        payload: { name: "adrift", version: 1 },
      }),
    ).toBeDefined();
  });

  it("accepts envelope with version", () => {
    expect(
      CjEnvelopeSchema.parse({
        type: "cj:config",
        payload: {},
        version: 1,
      }),
    ).toBeDefined();
  });

  it("accepts envelope with nonce", () => {
    expect(
      CjEnvelopeSchema.parse({
        type: "cj:hello",
        payload: { name: "adrift", version: 1 },
        nonce: "cj_sn_abc123def456789012",
      }),
    ).toBeDefined();
  });

  it("accepts envelope with nonce in payload but not envelope", () => {
    // nonce on envelope is for routing/correlation; separate from payload nonce
    expect(
      CjEnvelopeSchema.parse({
        type: "cj:ack",
        payload: { ackType: "cj:config", accepted: true },
      }),
    ).toBeDefined();
  });

  it("rejects envelope without cj: prefix", () => {
    expect(() =>
      CjEnvelopeSchema.parse({
        type: "other:message",
        payload: {},
      }),
    ).toThrow();
  });

  it("rejects envelope without type", () => {
    expect(() => CjEnvelopeSchema.parse({ payload: {} })).toThrow();
  });
});

// ── parseCjMessage ───────────────────────────────────────────────────

describe("parseCjMessage", () => {
  it("parses a valid cj:hello message", () => {
    const result = parseCjMessage({
      type: "cj:hello",
      payload: { name: "adrift", version: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.type).toBe("cj:hello");
      expect(result.payload).toEqual({ name: "adrift", version: 1 });
    }
  });

  it("parses a valid cj:config message", () => {
    const result = parseCjMessage({
      type: "cj:config",
      payload: {
        comfyUrl: "http://localhost:8188",
        wsUrl: "ws://localhost:8188",
        clientId: "c1",
        mode: "overlay",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.type).toBe("cj:config");
    }
  });

  it("extracts nonce from envelope", () => {
    const result = parseCjMessage({
      type: "cj:hello",
      payload: { name: "adrift", version: 1 },
      nonce: "cj_sn_abc123",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nonce).toBe("cj_sn_abc123");
    }
  });

  it("returns undefined nonce when not present", () => {
    const result = parseCjMessage({
      type: "cj:hello",
      payload: { name: "adrift", version: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nonce).toBeUndefined();
    }
  });

  it("rejects unknown message type", () => {
    const result = parseCjMessage({
      type: "cj:unknown",
      payload: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rawType).toBe("cj:unknown");
    }
  });

  it("rejects invalid payload for known type", () => {
    const result = parseCjMessage({
      type: "cj:config",
      payload: {
        /* missing required fields */
      },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects completely malformed input", () => {
    const result = parseCjMessage("not an object");
    expect(result.ok).toBe(false);
  });

  it("rejects input without cj: prefix type", () => {
    const result = parseCjMessage({
      type: "other:message",
      payload: {},
    });
    expect(result.ok).toBe(false);
  });

  it("parses all host→overlay types correctly", () => {
    const configResult = parseCjMessage({
      type: "cj:config",
      payload: {
        comfyUrl: "http://localhost:8188",
        wsUrl: "ws://localhost:8188",
        clientId: "c1",
        mode: "overlay",
      },
    });
    expect(configResult.ok).toBe(true);

    const progressResult = parseCjMessage({
      type: "cj:progress",
      payload: { promptId: "p1", value: 5, max: 10 },
    });
    expect(progressResult.ok).toBe(true);

    const statusResult = parseCjMessage({
      type: "cj:status",
      payload: { queueRemaining: 3 },
    });
    expect(statusResult.ok).toBe(true);

    const imagesResult = parseCjMessage({
      type: "cj:images",
      payload: {
        promptId: "p1",
        images: [{ filename: "a.png", type: "output" }],
      },
    });
    expect(imagesResult.ok).toBe(true);

    const errorResult = parseCjMessage({
      type: "cj:error",
      payload: { code: "E001", message: "Bad" },
    });
    expect(errorResult.ok).toBe(true);
  });

  it("parses all overlay→host types correctly", () => {
    const helloResult = parseCjMessage({
      type: "cj:hello",
      payload: { name: "adrift", version: 1 },
    });
    expect(helloResult.ok).toBe(true);

    const readyResult = parseCjMessage({
      type: "cj:ready",
      payload: { timestamp: 1234567890 },
    });
    expect(readyResult.ok).toBe(true);

    const runResult = parseCjMessage({
      type: "cj:run",
      payload: { workflow: {}, clientId: "c1" },
    });
    expect(runResult.ok).toBe(true);

    const interruptResult = parseCjMessage({
      type: "cj:interrupt",
      payload: {},
    });
    expect(interruptResult.ok).toBe(true);

    const ackResult = parseCjMessage({
      type: "cj:ack",
      payload: { ackType: "cj:config", accepted: true },
    });
    expect(ackResult.ok).toBe(true);
  });
});

// ── buildCjMessage ───────────────────────────────────────────────────

describe("buildCjMessage", () => {
  it("builds a valid cj:hello envelope", () => {
    const msg = buildCjMessage("cj:hello", {
      name: "adrift",
      version: 1,
    });
    expect(msg.type).toBe("cj:hello");
    expect(msg.version).toBe(CJ_PROTOCOL_VERSION);
    expect(msg.payload).toEqual({ name: "adrift", version: 1 });
  });

  it("builds a valid cj:config envelope", () => {
    const msg = buildCjMessage("cj:config", {
      comfyUrl: "http://localhost:8188",
      wsUrl: "ws://localhost:8188",
      clientId: "c1",
      mode: "overlay",
    });
    expect(msg.type).toBe("cj:config");
    expect(msg.version).toBe(CJ_PROTOCOL_VERSION);
  });

  it("builds envelope with nonce", () => {
    const msg = buildCjMessage(
      "cj:hello",
      {
        name: "adrift",
        version: 1,
      },
      "cj_sn_abc123",
    );
    expect(msg.nonce).toBe("cj_sn_abc123");
  });

  it("omits nonce when not provided", () => {
    const msg = buildCjMessage("cj:interrupt", {});
    expect(msg.nonce).toBeUndefined();
  });

  it("throws on invalid payload", () => {
    expect(() =>
      buildCjMessage("cj:config", {
        /* empty */
      }),
    ).toThrow();
  });

  it("throws on unknown type", () => {
    // @ts-expect-error — intentionally passing unknown type
    expect(() => buildCjMessage("cj:bogus", {})).toThrow();
  });

  it("round-trips through parseCjMessage", () => {
    const msg = buildCjMessage("cj:interrupt", {});
    const parsed = parseCjMessage(msg);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.type).toBe("cj:interrupt");
    }
  });

  it("round-trips through parseCjMessage with nonce", () => {
    const msg = buildCjMessage(
      "cj:hello",
      {
        name: "adrift",
        version: 1,
      },
      "cj_sn_roundtrip_test_nonce",
    );
    const parsed = parseCjMessage(msg);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.type).toBe("cj:hello");
      expect(parsed.nonce).toBe("cj_sn_roundtrip_test_nonce");
    }
  });
});

// ── Origin validation ────────────────────────────────────────────────

describe("validateOrigin", () => {
  it("rejects all origins with empty allow list", () => {
    const result = validateOrigin("http://localhost:8188", []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("No allowed origins");
    }
  });

  it("accepts an origin in the allow list", () => {
    const result = validateOrigin("http://localhost:8188", [
      "http://localhost:8188",
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects an origin not in the allow list", () => {
    const result = validateOrigin("http://evil.com", ["http://localhost:8188"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("not in allowed list");
    }
  });

  it("does no substring matching (exact only)", () => {
    const result = validateOrigin("http://localhost:8188.evil.com", [
      "http://localhost:8188",
    ]);
    expect(result.ok).toBe(false);
  });

  it("accepts any origin in a multi-entry allow list", () => {
    const allowList = ["http://localhost:8188", "https://adrift.local"];
    expect(validateOrigin("http://localhost:8188", allowList).ok).toBe(true);
    expect(validateOrigin("https://adrift.local", allowList).ok).toBe(
      true,
    );
    expect(validateOrigin("http://evil.com", allowList).ok).toBe(false);
  });

  it("rejects ports that differ", () => {
    expect(
      validateOrigin("http://localhost:3000", ["http://localhost:8188"]).ok,
    ).toBe(false);
  });

  it("rejects scheme changes", () => {
    expect(
      validateOrigin("https://localhost:8188", ["http://localhost:8188"]).ok,
    ).toBe(false);
  });
});

describe("deriveSameOrigin", () => {
  it("extracts origin from a URL", () => {
    expect(deriveSameOrigin("http://localhost:8188")).toBe(
      "http://localhost:8188",
    );
  });

  it("includes port", () => {
    expect(deriveSameOrigin("https://example.com:443/path")).toBe(
      "https://example.com",
    );
  });

  it("returns empty string for invalid URL", () => {
    expect(deriveSameOrigin("not-a-url")).toBe("");
  });

  it("handles URLs without explicit port", () => {
    expect(deriveSameOrigin("https://example.com/path")).toBe(
      "https://example.com",
    );
  });
});

// ── Nonce / session helpers ───────────────────────────────────────────

describe("generateNonce", () => {
  it("generates a nonce with the cj_sn_ prefix", () => {
    const nonce = generateNonce();
    expect(nonce.startsWith("cj_sn_")).toBe(true);
  });

  it("generates a nonce of adequate length", () => {
    const nonce = generateNonce();
    // cj_sn_ (6) + 24 hex chars = 30 minimum
    expect(nonce.length).toBeGreaterThanOrEqual(30);
  });

  it("uses the injected RNG when provided", () => {
    const rng = () => "abcdef0123456789abcdef01";
    const nonce = generateNonce(rng);
    expect(nonce).toBe("cj_sn_abcdef0123456789abcdef01");
  });

  it("generates different nonces on successive calls (probabilistic)", () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 10; i++) {
      nonces.add(generateNonce());
    }
    // 10 nonces should be unique (extremely likely with crypto.randomUUID)
    expect(nonces.size).toBeGreaterThan(1);
  });
});

describe("isNonceFormat", () => {
  it("accepts valid nonce format", () => {
    expect(isNonceFormat("cj_sn_abc123")).toBe(true);
  });

  it("accepts full-length nonce", () => {
    expect(isNonceFormat("cj_sn_abcdef0123456789abcdef01")).toBe(true);
  });

  it("rejects strings without prefix", () => {
    expect(isNonceFormat("abc123")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isNonceFormat("")).toBe(false);
  });

  it("rejects too-short string (prefix only)", () => {
    expect(isNonceFormat("cj_sn_")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isNonceFormat(123 as any)).toBe(false);
  });
});

describe("validateNonce", () => {
  it("accepts matching nonces", () => {
    const result = validateNonce("cj_sn_abc123", "cj_sn_abc123");
    expect(result.ok).toBe(true);
  });

  it("rejects mismatched nonces", () => {
    const result = validateNonce("cj_sn_abc123", "cj_sn_xyz789");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("mismatch");
    }
  });

  it("rejects when expected nonce is undefined (no session)", () => {
    const result = validateNonce("cj_sn_abc123", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("No session nonce");
    }
  });

  it("rejects when received nonce is undefined (missing nonce)", () => {
    const result = validateNonce(undefined, "cj_sn_abc123");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("missing nonce");
    }
  });

  it("rejects when both are undefined", () => {
    const result = validateNonce(undefined, undefined);
    expect(result.ok).toBe(false);
  });

  it("returns a reason that does not leak the full expected nonce", () => {
    const result = validateNonce(
      "cj_sn_wrong1234567890abcdef",
      "cj_sn_correct1234567890abcdef",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Should not contain the full expected nonce
      expect(result.reason).not.toContain("cj_sn_correct1234567890abcdef");
    }
  });
});

// ── Version negotiation ───────────────────────────────────────────────

describe("negotiateVersion", () => {
  it("accepts version at minimum supported", () => {
    const result = negotiateVersion(CJ_MIN_SUPPORTED_VERSION);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.negotiatedVersion).toBe(CJ_MIN_SUPPORTED_VERSION);
    }
  });

  it("accepts version within supported range", () => {
    const result = negotiateVersion(CJ_MAX_SUPPORTED_VERSION);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.negotiatedVersion).toBe(CJ_MAX_SUPPORTED_VERSION);
    }
  });

  it("rejects version below minimum", () => {
    const result = negotiateVersion(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("below minimum");
      expect(result.theirVersion).toBe(0);
      expect(result.minVersion).toBe(CJ_MIN_SUPPORTED_VERSION);
      expect(result.maxVersion).toBe(CJ_MAX_SUPPORTED_VERSION);
    }
  });

  it("rejects negative versions", () => {
    const result = negotiateVersion(-1);
    expect(result.ok).toBe(false);
  });

  it("negotiates down when overlay version exceeds host max", () => {
    // Simulate a future overlay that speaks v5, host only supports v1
    const result = negotiateVersion(5, 1, 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.negotiatedVersion).toBe(1);
    }
  });

  it("use exact version when within range", () => {
    const result = negotiateVersion(1, 1, 3);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.negotiatedVersion).toBe(1);
    }
  });

  it("negotiates to min(their, max) when their version exceeds max", () => {
    const result = negotiateVersion(3, 1, 2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.negotiatedVersion).toBe(2);
    }
  });

  it("returns diagnostic info on failure", () => {
    const result = negotiateVersion(0, 1, 2);
    if (!result.ok) {
      expect(result.theirVersion).toBe(0);
      expect(result.minVersion).toBe(1);
      expect(result.maxVersion).toBe(2);
    }
  });
});

// ── Structured event logging ───────────────────────────────────────────

describe("createBridgeEvent", () => {
  it("creates an event with required fields", () => {
    const event = createBridgeEvent({ description: "Test event" });
    expect(event.description).toBe("Test event");
    expect(event.timestamp).toBeTruthy();
    expect(event.level).toBe("info");
    expect(event.direction).toBe("internal");
  });

  it("uses provided level and direction", () => {
    const event = createBridgeEvent({
      level: "warn",
      direction: "inbound",
      description: "Warning event",
    });
    expect(event.level).toBe("warn");
    expect(event.direction).toBe("inbound");
  });

  it("includes optional fields when provided", () => {
    const event = createBridgeEvent({
      level: "error",
      direction: "outbound",
      sessionId: "cj_sn_abc123",
      messageType: "cj:hello",
      description: "Hello received",
      data: { version: 1 },
      phase: "configured",
      nonce: "cj_sn_abc123",
    });
    expect(event.sessionId).toBe("cj_sn_abc123");
    expect(event.messageType).toBe("cj:hello");
    expect(event.data).toEqual({ version: 1 });
    expect(event.phase).toBe("configured");
    expect(event.nonce).toBe("cj_sn_abc123");
  });

  it("omits optional fields when not provided", () => {
    const event = createBridgeEvent({ description: "Minimal" });
    expect(event.sessionId).toBeUndefined();
    expect(event.messageType).toBeUndefined();
    expect(event.data).toBeUndefined();
    expect(event.phase).toBeUndefined();
    expect(event.nonce).toBeUndefined();
  });

  it("defaults direction to internal", () => {
    const event = createBridgeEvent({ description: "Defaults" });
    expect(event.direction).toBe("internal");
  });

  it("defaults level to info", () => {
    const event = createBridgeEvent({ description: "Defaults" });
    expect(event.level).toBe("info");
  });

  it("produces ISO 8601 timestamps", () => {
    const event = createBridgeEvent({ description: "Timestamps" });
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("all log levels are valid", () => {
    const levels: Array<"debug" | "info" | "warn" | "error"> = [
      "debug",
      "info",
      "warn",
      "error",
    ];
    for (const level of levels) {
      const event = createBridgeEvent({ level, description: "test" });
      expect(event.level).toBe(level);
    }
  });
});

// ── Host bridge state surface ───────────────────────────────────────────

describe("createInitialHostBridgeState", () => {
  it("creates state with default idle FSM", () => {
    const state = createInitialHostBridgeState();
    expect(state.fsm.phase).toBe("idle");
  });

  it("creates state with empty recentErrors", () => {
    const state = createInitialHostBridgeState();
    expect(state.recentErrors).toEqual([]);
  });

  it("creates state with overlayConnected false", () => {
    const state = createInitialHostBridgeState();
    expect(state.overlayConnected).toBe(false);
  });

  it("creates state with undefined session fields", () => {
    const state = createInitialHostBridgeState();
    expect(state.sessionNonce).toBeUndefined();
    expect(state.clientId).toBeUndefined();
    expect(state.negotiatedVersion).toBeUndefined();
    expect(state.config).toBeUndefined();
  });

  it("accepts custom allowed origins", () => {
    const origins = ["http://localhost:8188", "https://example.com"];
    const state = createInitialHostBridgeState(origins);
    expect(state.allowedOrigins).toEqual(origins);
  });

  it("defaults to empty allowed origins", () => {
    const state = createInitialHostBridgeState();
    expect(state.allowedOrigins).toEqual([]);
  });
});

describe("pushHostBridgeError", () => {
  it("appends an error to recentErrors", () => {
    const state = createInitialHostBridgeState();
    const updated = pushHostBridgeError(state, "something broke");
    expect(updated.recentErrors).toHaveLength(1);
    expect(updated.recentErrors[0].message).toBe("something broke");
    expect(updated.recentErrors[0].timestamp).toBeTruthy();
  });

  it("does not mutate the original state", () => {
    const state = createInitialHostBridgeState();
    pushHostBridgeError(state, "error");
    expect(state.recentErrors).toHaveLength(0);
  });

  it("preserves other fields", () => {
    const state = createInitialHostBridgeState(["http://localhost:8188"]);
    state.fsm = { phase: "configured", clientId: "c1" };
    state.sessionNonce = "cj_sn_test";

    const updated = pushHostBridgeError(state, "error");
    expect(updated.fsm).toEqual({ phase: "configured", clientId: "c1" });
    expect(updated.sessionNonce).toBe("cj_sn_test");
    expect(updated.allowedOrigins).toEqual(["http://localhost:8188"]);
  });

  it("uses provided timestamp", () => {
    const state = createInitialHostBridgeState();
    const ts = "2026-01-01T00:00:00.000Z";
    const updated = pushHostBridgeError(state, "error", ts);
    expect(updated.recentErrors[0].timestamp).toBe(ts);
  });

  it("caps at MAX_RECENT_ERRORS", () => {
    let state = createInitialHostBridgeState();
    for (let i = 0; i < MAX_RECENT_ERRORS + 5; i++) {
      state = pushHostBridgeError(state, `error ${i}`);
    }
    expect(state.recentErrors).toHaveLength(MAX_RECENT_ERRORS);
    // Should keep the most recent errors
    expect(state.recentErrors[0].message).toBe(`error 5`);
    expect(state.recentErrors[MAX_RECENT_ERRORS - 1].message).toBe(
      `error ${MAX_RECENT_ERRORS + 4}`,
    );
  });

  it("allows chaining multiple errors", () => {
    let state = createInitialHostBridgeState();
    state = pushHostBridgeError(state, "err1");
    state = pushHostBridgeError(state, "err2");
    state = pushHostBridgeError(state, "err3");
    expect(state.recentErrors).toHaveLength(3);
    expect(state.recentErrors.map((e) => e.message)).toEqual([
      "err1",
      "err2",
      "err3",
    ]);
  });
});

// ── Bridge state machine ──────────────────────────────────────────────

describe("transitionBridge", () => {
  it("starts in idle state", () => {
    const initial: BridgeState = { phase: "idle" };
    expect(initial.phase).toBe("idle");
  });

  it("transitions idle → hello-sent", () => {
    const result = transitionBridge({ phase: "idle" }, "send-hello");
    expect(result.phase).toBe("hello-sent");
  });

  it("transitions hello-sent → configured on valid config", () => {
    const configPayload = {
      comfyUrl: "http://localhost:8188",
      wsUrl: "ws://localhost:8188",
      clientId: "c1",
      mode: "overlay" as const,
    };
    const result = transitionBridge(
      { phase: "hello-sent" },
      "recv-config",
      configPayload,
    );
    expect(result.phase).toBe("configured");
    if (result.phase === "configured") {
      expect(result.clientId).toBe("c1");
    }
  });

  it("transitions configured → ready", () => {
    const result = transitionBridge(
      { phase: "configured", clientId: "c1" },
      "recv-ready",
    );
    expect(result.phase).toBe("ready");
  });

  it("transitions ready → configured (re-config)", () => {
    const configPayload = {
      comfyUrl: "http://localhost:9999",
      wsUrl: "ws://localhost:9999",
      clientId: "c2",
      mode: "overlay" as const,
    };
    const result = transitionBridge(
      { phase: "ready", clientId: "c1" },
      "recv-config",
      configPayload,
    );
    expect(result.phase).toBe("configured");
    if (result.phase === "configured") {
      expect(result.clientId).toBe("c2");
    }
  });

  it("transitions any state → error on recv-error", () => {
    const result = transitionBridge(
      { phase: "hello-sent" },
      "recv-error",
      "Connection refused",
    );
    expect(result.phase).toBe("error");
    if (result.phase === "error") {
      expect(result.error).toBe("Connection refused");
    }
  });

  it("transitions error → idle on reset", () => {
    const result = transitionBridge(
      { phase: "error", error: "boom", previousPhase: "configured" },
      "reset",
    );
    expect(result.phase).toBe("idle");
  });

  it("rejects invalid transitions (idle → configured)", () => {
    const result = transitionBridge({ phase: "idle" }, "recv-config", {
      comfyUrl: "http://x",
      wsUrl: "ws://x",
      clientId: "c",
      mode: "overlay" as const,
    });
    // Should go to error state since idle→configured is not a valid transition
    expect(result.phase).toBe("error");
  });

  it("rejects invalid transitions (idle → ready)", () => {
    const result = transitionBridge({ phase: "idle" }, "recv-ready");
    expect(result.phase).toBe("error");
  });

  it("rejects invalid config payload in transition", () => {
    const result = transitionBridge({ phase: "hello-sent" }, "recv-config", {
      /* missing fields */
    });
    expect(result.phase).toBe("error");
    if (result.phase === "error") {
      expect(result.error).toContain("Invalid config");
    }
  });

  it("full handshake flow: idle → hello-sent → configured → ready", () => {
    let state: BridgeState = { phase: "idle" };

    state = transitionBridge(state, "send-hello");
    expect(state.phase).toBe("hello-sent");

    state = transitionBridge(state, "recv-config", {
      comfyUrl: "http://localhost:8188",
      wsUrl: "ws://localhost:8188",
      clientId: "test-client",
      mode: "overlay",
    });
    expect(state.phase).toBe("configured");

    state = transitionBridge(state, "recv-ready");
    expect(state.phase).toBe("ready");
  });

  it("full handshake with re-config flow", () => {
    let state: BridgeState = { phase: "idle" };

    state = transitionBridge(state, "send-hello");
    state = transitionBridge(state, "recv-config", {
      comfyUrl: "http://localhost:8188",
      wsUrl: "ws://localhost:8188",
      clientId: "c1",
      mode: "overlay",
    });
    state = transitionBridge(state, "recv-ready");
    expect(state.phase).toBe("ready");

    // Re-config
    state = transitionBridge(state, "recv-config", {
      comfyUrl: "http://localhost:9999",
      wsUrl: "ws://localhost:9999",
      clientId: "c2",
      mode: "overlay",
    });
    expect(state.phase).toBe("configured");

    state = transitionBridge(state, "recv-ready");
    expect(state.phase).toBe("ready");
  });

  it("error recovery flow: idle → hello-sent → error → idle → hello-sent", () => {
    let state: BridgeState = { phase: "idle" };

    state = transitionBridge(state, "send-hello");
    state = transitionBridge(state, "recv-error", "Connection failed");
    expect(state.phase).toBe("error");

    state = transitionBridge(state, "reset");
    expect(state.phase).toBe("idle");

    state = transitionBridge(state, "send-hello");
    expect(state.phase).toBe("hello-sent");
  });

  it("records previousPhase on error", () => {
    const result = transitionBridge(
      { phase: "configured", clientId: "c1" },
      "recv-error",
      "timeout",
    );
    expect(result.phase).toBe("error");
    if (result.phase === "error") {
      expect(result.previousPhase).toBe("configured");
      expect(result.error).toBe("timeout");
    }
  });

  it("config with nonce passes through", () => {
    const configWithNonce = {
      comfyUrl: "http://localhost:8188",
      wsUrl: "ws://localhost:8188",
      clientId: "c1",
      mode: "overlay" as const,
      nonce: "cj_sn_test_nonce_1234567890",
    };
    const result = transitionBridge(
      { phase: "hello-sent" },
      "recv-config",
      configWithNonce,
    );
    expect(result.phase).toBe("configured");
  });
});

// ── cj:load-workflow message type ─────────────────────────────────────

describe("cj:load-workflow", () => {
  it("builds a valid cj:load-workflow envelope", () => {
    const workflow = { "1": { class_type: "KSampler", inputs: {} } };
    const msg = buildCjMessage(OVERLAY_MSG.LOAD_WORKFLOW, { workflow });
    expect(msg.type).toBe("cj:load-workflow");
    expect(msg.version).toBe(CJ_PROTOCOL_VERSION);
    expect((msg.payload as { workflow: unknown }).workflow).toEqual(workflow);
  });

  it("parses a valid cj:load-workflow message", () => {
    const workflow = { nodes: [{ type: "KSampler" }] };
    const result = parseCjMessage({
      type: "cj:load-workflow",
      payload: { workflow },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.type).toBe("cj:load-workflow");
      expect((result.payload as { workflow: unknown }).workflow).toEqual(
        workflow,
      );
    }
  });

  it("round-trips through build and parse", () => {
    const workflow = { "1": { class_type: "CLIPTextEncode", inputs: {} } };
    const msg = buildCjMessage(OVERLAY_MSG.LOAD_WORKFLOW, { workflow });
    const parsed = parseCjMessage(msg);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.type).toBe("cj:load-workflow");
    }
  });

  it("is classified as overlay→host direction", () => {
    expect(messageDirection("cj:load-workflow")).toBe("overlay→host");
    expect(messageRole("cj:load-workflow")).toBe("overlay");
  });

  it("is present in ALL_KNOWN_MESSAGE_TYPES", () => {
    expect(ALL_KNOWN_MESSAGE_TYPES.has("cj:load-workflow")).toBe(true);
  });

  it("builds with nonce", () => {
    const msg = buildCjMessage(
      OVERLAY_MSG.LOAD_WORKFLOW,
      { workflow: {} },
      "cj_sn_loadwf_nonce",
    );
    expect(msg.nonce).toBe("cj_sn_loadwf_nonce");
  });
});

// ── cj:drag-image message type ───────────────────────────────────────

describe("cj:drag-image", () => {
  it("builds a valid cj:drag-image envelope with filename only", () => {
    const msg = buildCjMessage(OVERLAY_MSG.DRAG_IMAGE, {
      filename: "output_00001.png",
    });
    expect(msg.type).toBe("cj:drag-image");
    expect((msg.payload as { filename: string }).filename).toBe(
      "output_00001.png",
    );
  });

  it("builds with all optional fields", () => {
    const msg = buildCjMessage(OVERLAY_MSG.DRAG_IMAGE, {
      filename: "img.png",
      subfolder: "batch_01",
      type: "output",
    });
    const payload = msg.payload as {
      filename: string;
      subfolder: string;
      type: string;
    };
    expect(payload.filename).toBe("img.png");
    expect(payload.subfolder).toBe("batch_01");
    expect(payload.type).toBe("output");
  });

  it("parses a valid cj:drag-image message", () => {
    const result = parseCjMessage({
      type: "cj:drag-image",
      payload: { filename: "test.png", type: "input" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.type).toBe("cj:drag-image");
      expect((result.payload as { filename: string }).filename).toBe(
        "test.png",
      );
    }
  });

  it("rejects empty filename", () => {
    const result = parseCjMessage({
      type: "cj:drag-image",
      payload: { filename: "" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects missing filename", () => {
    const result = parseCjMessage({
      type: "cj:drag-image",
      payload: {},
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid type enum", () => {
    const result = parseCjMessage({
      type: "cj:drag-image",
      payload: { filename: "a.png", type: "invalid" },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts all valid type values", () => {
    for (const t of ["output", "input", "temp"]) {
      const result = parseCjMessage({
        type: "cj:drag-image",
        payload: { filename: "a.png", type: t },
      });
      expect(result.ok, `type "${t}" should be valid`).toBe(true);
    }
  });

  it("round-trips through build and parse", () => {
    const msg = buildCjMessage(OVERLAY_MSG.DRAG_IMAGE, {
      filename: "round.png",
      subfolder: "sub",
      type: "temp",
    });
    const parsed = parseCjMessage(msg);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.type).toBe("cj:drag-image");
    }
  });

  it("is classified as overlay→host direction", () => {
    expect(messageDirection("cj:drag-image")).toBe("overlay→host");
    expect(messageRole("cj:drag-image")).toBe("overlay");
  });

  it("is present in ALL_KNOWN_MESSAGE_TYPES", () => {
    expect(ALL_KNOWN_MESSAGE_TYPES.has("cj:drag-image")).toBe(true);
  });
});

// ── cj:toggle (ad-hoc, non-protocol) ────────────────────────────────

describe("cj:toggle", () => {
  it("is not a registered protocol message type (sent ad-hoc)", () => {
    // cj:toggle is used in useOverlayMode.requestHideOverlay but
    // is NOT in the protocol's TYPE_TO_PAYLOAD_SCHEMA — it's a
    // lightweight message sent directly via postMessage without
    // schema validation. Verify it's not in the known set.
    expect(ALL_KNOWN_MESSAGE_TYPES.has("cj:toggle")).toBe(false);
  });

  it("parseCjMessage rejects it as unknown type", () => {
    const result = parseCjMessage({
      type: "cj:toggle",
      payload: { visible: false },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rawType).toBe("cj:toggle");
    }
  });
});

// ── Inertness guarantee ───────────────────────────────────────────────

describe("Inertness guarantee", () => {
  it("protocol module has no DOM dependencies", () => {
    // If we can import and use it without a DOM, it's inert
    const msg = buildCjMessage("cj:interrupt", {});
    expect(msg.type).toBe("cj:interrupt");
  });

  it("protocol module has no network dependencies", () => {
    // parseCjMessage works with plain data, no fetch/XHR
    const result = parseCjMessage({
      type: "cj:progress",
      payload: { promptId: "p1", value: 5, max: 10 },
    });
    expect(result.ok).toBe(true);
  });

  it("origin validation is purely functional", () => {
    // No side effects, no global state
    const r1 = validateOrigin("http://a.com", ["http://a.com"]);
    const r2 = validateOrigin("http://b.com", ["http://a.com"]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
  });

  it("nonce generation with injected RNG is deterministic", () => {
    // Using injected RNG makes it testable without globals
    const rng = () => "deadbeef01234567";
    const n1 = generateNonce(rng);
    const n2 = generateNonce(rng);
    expect(n1).toBe(n2);
    expect(n1).toBe("cj_sn_deadbeef01234567");
  });

  it("version negotiation is purely functional", () => {
    // Same inputs → same outputs, no side effects
    const r1 = negotiateVersion(1);
    const r2 = negotiateVersion(1);
    expect(r1).toEqual(r2);
  });

  it("host bridge state creation is purely functional", () => {
    const s1 = createInitialHostBridgeState();
    const s2 = createInitialHostBridgeState();
    expect(s1).toEqual(s2);
  });

  it("bridge event creation is purely functional", () => {
    // These would be identical except for timestamps
    const e1 = createBridgeEvent({ description: "test" });
    const e2 = createBridgeEvent({ description: "test" });
    expect(e1.description).toBe(e2.description);
    expect(e1.level).toBe(e2.level);
    expect(e1.direction).toBe(e2.direction);
  });
});

// ── Protocol consistency ───────────────────────────────────────────────

describe("Protocol consistency", () => {
  it("CjEnvelopeSchema accepts all known message types", () => {
    const allTypes = [...ALL_KNOWN_MESSAGE_TYPES];
    for (const type of allTypes) {
      const result = CjEnvelopeSchema.safeParse({
        type,
        payload: {},
      });
      // Envelope validation should pass (type has cj: prefix)
      expect(result.success, `Envelope should accept type "${type}"`).toBe(
        true,
      );
    }
  });

  it("buildCjMessage and parseCjMessage round-trip for all types", () => {
    const testPayloads: Record<string, unknown> = {
      "cj:config": {
        comfyUrl: "http://localhost:8188",
        wsUrl: "ws://localhost:8188",
        clientId: "c1",
        mode: "overlay",
      },
      "cj:progress": { promptId: "p1", value: 5, max: 10 },
      "cj:status": { queueRemaining: 3 },
      "cj:images": {
        promptId: "p1",
        images: [{ filename: "a.png", type: "output" }],
      },
      "cj:error": { code: "E001", message: "Bad" },
      "cj:hello": { name: "adrift", version: 1 },
      "cj:ready": { timestamp: 1234567890 },
      "cj:run": { workflow: {}, clientId: "c1" },
      "cj:interrupt": {},
      "cj:ack": { ackType: "cj:config", accepted: true },
      "cj:load-workflow": {
        workflow: { "1": { class_type: "KSampler", inputs: {} } },
      },
      "cj:drag-image": { filename: "test.png" },
    };

    for (const [type, payload] of Object.entries(testPayloads)) {
      const msg = buildCjMessage(type as any, payload);
      const parsed = parseCjMessage(msg);
      expect(parsed.ok, `Round-trip failed for type "${type}"`).toBe(true);
      if (parsed.ok) {
        expect(parsed.type, `Type should round-trip for "${type}"`).toBe(type);
      }
    }
  });
});

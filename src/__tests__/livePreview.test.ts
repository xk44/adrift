/**
 * ComfyUI binary WS preview decoding (server.py encode_bytes / send_image /
 * send_image_with_metadata) and the throttled object-URL registry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BinaryEventType,
  CLIENT_FEATURE_FLAGS_MESSAGE,
  LivePreviewStore,
  decodeComfyBinaryFrame,
  type DecodedPreview,
} from "@/lib/comfy/livePreview";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5]);

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

/** struct.pack(">I", 1) + struct.pack(">I", type_num) + image */
function legacyFrame(typeNum: number, image: Uint8Array): ArrayBuffer {
  return new Uint8Array([...u32(1), ...u32(typeNum), ...image]).buffer;
}

/** struct.pack(">I", 4) + struct.pack(">I", len) + json + image */
function metaFrame(meta: unknown, image: Uint8Array, lenOverride?: number) {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  return new Uint8Array([
    ...u32(4),
    ...u32(lenOverride ?? json.length),
    ...json,
    ...image,
  ]).buffer;
}

describe("decodeComfyBinaryFrame", () => {
  it("decodes legacy PREVIEW_IMAGE JPEG and PNG", () => {
    const jpeg = decodeComfyBinaryFrame(legacyFrame(1, JPEG))!;
    expect(jpeg).toMatchObject({ event: 1, mime: "image/jpeg" });
    expect(jpeg.promptId).toBeUndefined();
    expect([...jpeg.image]).toEqual([...JPEG]);
    const png = decodeComfyBinaryFrame(legacyFrame(2, PNG))!;
    expect(png.mime).toBe("image/png");
    expect([...png.image]).toEqual([...PNG]);
  });

  it("decodes PREVIEW_IMAGE_WITH_METADATA with prompt and node ids", () => {
    const frame = metaFrame(
      {
        node_id: "7",
        prompt_id: "p-1",
        display_node_id: "7",
        parent_node_id: null,
        real_node_id: "7",
        image_type: "image/png",
      },
      PNG,
    );
    const out = decodeComfyBinaryFrame(frame)!;
    expect(out).toMatchObject({
      event: 4,
      mime: "image/png",
      promptId: "p-1",
      nodeId: "7",
      displayNodeId: "7",
    });
    expect([...out.image]).toEqual([...PNG]);
  });

  it("accepts a typed-array view at an offset", () => {
    const raw = new Uint8Array([9, 9, ...new Uint8Array(legacyFrame(1, JPEG))]);
    const out = decodeComfyBinaryFrame(raw.subarray(2))!;
    expect([...out.image]).toEqual([...JPEG]);
  });

  it("returns null for non-preview, truncated or malformed frames", () => {
    expect(decodeComfyBinaryFrame(new ArrayBuffer(4))).toBeNull();
    expect(decodeComfyBinaryFrame(legacyFrame(1, new Uint8Array()))).toBeNull();
    // TEXT (3) and UNENCODED (2, never on the wire) are not previews
    expect(
      decodeComfyBinaryFrame(
        new Uint8Array([...u32(BinaryEventType.TEXT), ...u32(1), 55, 104, 105])
          .buffer,
      ),
    ).toBeNull();
    // metadata length past the end
    expect(decodeComfyBinaryFrame(metaFrame({}, PNG, 9999))).toBeNull();
    // metadata not JSON
    expect(
      decodeComfyBinaryFrame(
        new Uint8Array([...u32(4), ...u32(3), 120, 121, 122, ...PNG]).buffer,
      ),
    ).toBeNull();
    // metadata but no image
    expect(
      decodeComfyBinaryFrame(metaFrame({ prompt_id: "x" }, new Uint8Array())),
    ).toBeNull();
  });

  it("defaults unknown image types to JPEG", () => {
    expect(decodeComfyBinaryFrame(metaFrame({}, JPEG))!.mime).toBe(
      "image/jpeg",
    );
  });

  it("builds the feature_flags handshake ComfyUI expects", () => {
    expect(JSON.parse(CLIENT_FEATURE_FLAGS_MESSAGE)).toEqual({
      type: "feature_flags",
      data: { supports_preview_metadata: true },
    });
  });
});

describe("LivePreviewStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(minIntervalMs = 100, maxEntries = 16) {
    vi.useFakeTimers();
    let n = 0;
    const revoked: string[] = [];
    const store = new LivePreviewStore({
      minIntervalMs,
      maxEntries,
      now: () => Date.now(),
      createUrl: () => `blob:${n++}`,
      revokeUrl: (u) => revoked.push(u),
    });
    const notify = vi.fn();
    store.subscribe(notify);
    const frame = (nodeId = "7"): DecodedPreview => ({
      event: 4,
      mime: "image/jpeg",
      nodeId,
      image: JPEG,
    });
    return { store, revoked, notify, frame };
  }

  it("commits the first frame immediately and throttles the rest (latest wins)", () => {
    const { store, revoked, notify, frame } = setup();
    store.push("p", frame("a"));
    expect(store.get("p")).toMatchObject({ url: "blob:0", nodeId: "a" });
    store.push("p", frame("b"));
    store.push("p", frame("c"));
    expect(store.get("p")?.url).toBe("blob:0");
    vi.advanceTimersByTime(100);
    expect(store.get("p")).toMatchObject({ url: "blob:1", nodeId: "c" });
    expect(revoked).toEqual(["blob:0"]);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("clear() revokes the URL and cancels a throttled frame", () => {
    const { store, revoked, frame } = setup();
    store.push("p", frame());
    store.push("p", frame());
    store.clear("p");
    vi.advanceTimersByTime(500);
    expect(store.get("p")).toBeUndefined();
    expect(revoked).toEqual(["blob:0"]);
  });

  it("evicts and revokes the oldest prompt beyond maxEntries", () => {
    const { store, revoked, frame } = setup(0, 2);
    store.push("a", frame());
    store.push("b", frame());
    store.push("c", frame());
    expect(store.get("a")).toBeUndefined();
    expect(store.get("c")?.url).toBe("blob:2");
    expect(revoked).toEqual(["blob:0"]);
  });

  it("clearAll() revokes everything", () => {
    const { store, revoked, frame } = setup(0);
    store.push("a", frame());
    store.push("b", frame());
    store.clearAll();
    expect(revoked.sort()).toEqual(["blob:0", "blob:1"]);
  });
});

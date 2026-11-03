/**
 * Tests for the overlay Tools bridge messages (graph images + API workflow
 * insert) appended to the overlay protocol.
 */

import { describe, it, expect } from "vitest";
import {
  HOST_MSG,
  OVERLAY_MSG,
  ALL_KNOWN_MESSAGE_TYPES,
  MAX_INSERT_NODES,
  MAX_GRAPH_IMAGES,
  GraphImageRefSchema,
  GraphImagePayloadSchema,
  RequestGraphImagePayloadSchema,
  ApiWorkflowSchema,
  InsertApiWorkflowPayloadSchema,
  GraphInsertedPayloadSchema,
  isApiLink,
  formatGraphImageRef,
  parseGraphImageWidgetValue,
  graphImageProxyUrl,
  messageDirection,
  parseCjMessage,
  buildCjMessage,
} from "../protocol";

const WF = {
  "1": {
    class_type: "LoadImage",
    inputs: { image: "photo.png [input]" },
    _meta: { title: "Source" },
  },
  "2": {
    class_type: "SaveImage",
    inputs: { images: ["1", 0], filename_prefix: "tool" },
  },
};

describe("tools bridge message types", () => {
  it("are registered with the right direction", () => {
    expect(messageDirection(HOST_MSG.GRAPH_IMAGE)).toBe("host→overlay");
    expect(messageDirection(HOST_MSG.GRAPH_INSERTED)).toBe("host→overlay");
    expect(messageDirection(OVERLAY_MSG.REQUEST_GRAPH_IMAGE)).toBe(
      "overlay→host",
    );
    expect(messageDirection(OVERLAY_MSG.INSERT_API_WORKFLOW)).toBe(
      "overlay→host",
    );
    for (const t of [
      "cj:graph-image",
      "cj:graph-inserted",
      "cj:request-graph-image",
      "cj:insert-api-workflow",
    ]) {
      expect(ALL_KNOWN_MESSAGE_TYPES.has(t)).toBe(true);
    }
  });
});

describe("GraphImageRefSchema", () => {
  it("accepts a plain output ref", () => {
    expect(
      GraphImageRefSchema.safeParse({
        filename: "ComfyUI_00001_.png",
        subfolder: "",
        type: "output",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["../secret.png", "sub", "output"],
    ["a/b.png", "", "output"],
    ["a\\b.png", "", "output"],
    ["..", "", "output"],
    ["ok.png", "../up", "output"],
    ["ok.png", "a/../../b", "output"],
    ["ok.png", "a\\b", "output"],
    ["bad\nname.png", "", "output"],
    ["ok.png", "", "models"],
  ])("rejects %s / %s / %s", (filename, subfolder, type) => {
    expect(
      GraphImageRefSchema.safeParse({ filename, subfolder, type }).success,
    ).toBe(false);
  });
});

describe("GraphImagePayloadSchema", () => {
  it("accepts a selection push and a none reply", () => {
    expect(
      GraphImagePayloadSchema.safeParse({
        nodeId: 9,
        nodeType: "SaveImage",
        nodeTitle: "Save Image",
        source: "selection",
        images: [{ filename: "a.png", subfolder: "x", type: "output" }],
      }).success,
    ).toBe(true);
    expect(
      GraphImagePayloadSchema.safeParse({
        requestId: "r1",
        nodeId: -1,
        nodeType: "",
        nodeTitle: "",
        source: "none",
        images: [],
      }).success,
    ).toBe(true);
  });

  it("caps the image count", () => {
    const images = Array.from({ length: MAX_GRAPH_IMAGES + 1 }, (_, i) => ({
      filename: `${i}.png`,
      type: "output" as const,
    }));
    expect(
      GraphImagePayloadSchema.safeParse({
        nodeId: 1,
        nodeType: "PreviewImage",
        nodeTitle: "p",
        source: "node",
        images,
      }).success,
    ).toBe(false);
  });
});

describe("RequestGraphImagePayloadSchema", () => {
  it("accepts empty and specific requests, rejects negative ids", () => {
    expect(RequestGraphImagePayloadSchema.safeParse({}).success).toBe(true);
    expect(
      RequestGraphImagePayloadSchema.safeParse({ requestId: "a", nodeId: 3 })
        .success,
    ).toBe(true);
    expect(
      RequestGraphImagePayloadSchema.safeParse({ nodeId: -1 }).success,
    ).toBe(false);
    expect(
      RequestGraphImagePayloadSchema.safeParse({ requestId: "" }).success,
    ).toBe(false);
  });
});

describe("isApiLink", () => {
  it("recognises [id, slot] pairs only", () => {
    expect(isApiLink(["1", 0])).toBe(true);
    expect(isApiLink([4, 2])).toBe(true);
    expect(isApiLink(["1", -1])).toBe(false);
    expect(isApiLink(["1", 0.5])).toBe(false);
    expect(isApiLink(["1", 0, 1])).toBe(false);
    expect(isApiLink("1")).toBe(false);
    expect(isApiLink([1, 2, 3].slice(0, 1))).toBe(false);
  });
});

describe("ApiWorkflowSchema", () => {
  it("accepts a linked workflow", () => {
    expect(ApiWorkflowSchema.safeParse(WF).success).toBe(true);
  });

  it("rejects empty workflows", () => {
    expect(ApiWorkflowSchema.safeParse({}).success).toBe(false);
  });

  it("rejects links to missing nodes", () => {
    const r = ApiWorkflowSchema.safeParse({
      "2": { class_type: "SaveImage", inputs: { images: ["7", 0] } },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toContain('"7"');
    }
  });

  it("rejects nodes without class_type", () => {
    expect(ApiWorkflowSchema.safeParse({ "1": { inputs: {} } }).success).toBe(
      false,
    );
  });

  it("rejects workflows above the node cap", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_INSERT_NODES; i++) {
      big[String(i)] = { class_type: "Note", inputs: {} };
    }
    expect(ApiWorkflowSchema.safeParse(big).success).toBe(false);
  });
});

describe("InsertApiWorkflowPayloadSchema", () => {
  it("defaults mode to insert", () => {
    const r = InsertApiWorkflowPayloadSchema.parse({ workflow: WF });
    expect(r.mode).toBe("insert");
  });

  it("rejects unknown modes", () => {
    expect(
      InsertApiWorkflowPayloadSchema.safeParse({ workflow: WF, mode: "merge" })
        .success,
    ).toBe(false);
  });
});

describe("GraphInsertedPayloadSchema", () => {
  it("accepts success and failure reports", () => {
    expect(
      GraphInsertedPayloadSchema.safeParse({
        requestId: "x",
        ok: true,
        mode: "insert",
        nodeIds: [12, 13],
        warnings: [],
      }).success,
    ).toBe(true);
    expect(
      GraphInsertedPayloadSchema.safeParse({
        ok: false,
        mode: "replace",
        nodeIds: [],
        warnings: [],
        error: "app.loadApiJson is not available",
      }).success,
    ).toBe(true);
  });
});

describe("envelope round trips", () => {
  it("builds and parses an insert request", () => {
    const msg = buildCjMessage(OVERLAY_MSG.INSERT_API_WORKFLOW, {
      workflow: WF,
      requestId: "abc",
      title: "Restore",
    });
    const parsed = parseCjMessage(msg);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.type).toBe("cj:insert-api-workflow");
      expect((parsed.payload as { mode: string }).mode).toBe("insert");
    }
  });

  it("refuses to build an insert with a dangling link", () => {
    expect(() =>
      buildCjMessage(OVERLAY_MSG.INSERT_API_WORKFLOW, {
        workflow: { "1": { class_type: "X", inputs: { a: ["9", 0] } } },
      }),
    ).toThrow();
  });

  it("rejects a graph-image message with a traversal filename", () => {
    const parsed = parseCjMessage({
      type: HOST_MSG.GRAPH_IMAGE,
      version: 1,
      payload: {
        nodeId: 1,
        nodeType: "SaveImage",
        nodeTitle: "s",
        source: "node",
        images: [{ filename: "../../etc/passwd", type: "output" }],
      },
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("graph image ref helpers", () => {
  it("formats annotated refs", () => {
    expect(
      formatGraphImageRef({
        filename: "a.png",
        subfolder: "x/y/",
        type: "output",
      }),
    ).toBe("x/y/a.png [output]");
    expect(formatGraphImageRef({ filename: "a.png", type: "input" })).toBe(
      "a.png [input]",
    );
  });

  it("parses LoadImage widget values", () => {
    expect(parseGraphImageWidgetValue("photo.png")).toEqual({
      filename: "photo.png",
      subfolder: "",
      type: "input",
    });
    expect(parseGraphImageWidgetValue("sub/dir/p.png [output]")).toEqual({
      filename: "p.png",
      subfolder: "sub/dir",
      type: "output",
    });
    expect(parseGraphImageWidgetValue("p.png", "temp")?.type).toBe("temp");
  });

  it("rejects unusable widget values", () => {
    expect(parseGraphImageWidgetValue(42)).toBeNull();
    expect(parseGraphImageWidgetValue("")).toBeNull();
    expect(parseGraphImageWidgetValue("../x.png")).toBeNull();
    expect(parseGraphImageWidgetValue("dir/")).toBeNull();
  });

  it("round-trips format -> parse", () => {
    const ref = { filename: "z.webp", subfolder: "a", type: "temp" as const };
    expect(parseGraphImageWidgetValue(formatGraphImageRef(ref))).toEqual(ref);
  });

  it("builds same-origin proxy URLs", () => {
    const url = graphImageProxyUrl({
      filename: "a b.png",
      subfolder: "s",
      type: "output",
    });
    expect(url.startsWith("/api/comfy/image?")).toBe(true);
    const q = new URLSearchParams(url.split("?")[1]);
    expect(q.get("filename")).toBe("a b.png");
    expect(q.get("subfolder")).toBe("s");
    expect(q.get("type")).toBe("output");
  });
});

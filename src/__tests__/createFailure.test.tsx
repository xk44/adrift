/**
 * Create's failed submits -> RunFailure with Create's next step ("Open
 * setup" / node manager); raw node references stay in Details.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/comfy-errors/prompt-errors.json";
import {
  classifyCreateException,
  classifyCreateResponse,
} from "@/lib/create/createFailure";
import { editFailureMessage } from "@/lib/ui/editErrors";
import { CreateFailureNotice } from "@/components/setup/CreateFailureNotice";
import { RunFailureNotice } from "@/components/tools/RunFailureNotice";

describe("classifyCreateResponse", () => {
  it("no checkpoint configured -> missing model + Open checklist", () => {
    const f = classifyCreateResponse(
      {
        ok: false,
        code: "no_checkpoint",
        error: "No checkpoint is configured. Set COMFY_DEFAULT_CHECKPOINT ...",
      },
      500,
    );
    expect(f.kind).toBe("missing_model");
    expect(f.action).toBe("setup");
    expect(f.setup).toBe(true);
    expect(f.message).toContain("first-run checklist");
  });

  it("ComfyUI /prompt body (missing checkpoint) -> missing model, file named", () => {
    const f = classifyCreateResponse(
      {
        ok: false,
        error: "Failed to queue any jobs",
        details: ["Job 0: ComfyUI rejected the prompt (#4)"],
        code: "comfy_rejected",
        comfy: fixtures.missing_checkpoint,
      },
      500,
    );
    expect(f.kind).toBe("missing_model");
    expect(f.action).toBe("setup");
    expect(f.message).toContain("lumen_v2.safetensors");
    expect(f.message).not.toContain("Set up this tool");
    expect(f.message).not.toMatch(/#\d/);
  });

  it("missing node -> node manager", () => {
    const f = classifyCreateResponse(
      {
        ok: false,
        error: "Failed to queue any jobs",
        comfy: fixtures.missing_node_type,
      },
      500,
    );
    expect(f.kind).toBe("missing_node");
    expect(f.action).toBe("nodes");
    expect(f.message).toContain("node manager");
    expect(f.message).not.toContain("Set up this tool");
  });

  it("job line says ComfyUI is down -> unreachable + Open checklist", () => {
    const f = classifyCreateResponse(
      {
        ok: false,
        error: "Failed to queue any jobs",
        details: ["Job 0: fetch failed", "Job 1: fetch failed"],
      },
      500,
    );
    expect(f.kind).toBe("comfy_unreachable");
    expect(f.action).toBe("setup");
    expect(f.startComfy).toBe(false);
  });

  it("server error from a ComfyAPIError code", () => {
    const f = classifyCreateResponse(
      {
        ok: false,
        error: "Server error: Cannot connect to ComfyUI",
        code: "comfy_unreachable",
      },
      500,
    );
    expect(f.kind).toBe("comfy_unreachable");
  });

  it("unknown errors with raw node ids move them to Details", () => {
    const f = classifyCreateResponse(
      {
        ok: false,
        error: "Failed to queue any jobs",
        details: ["Job 0: KSampler (#3) exploded"],
      },
      500,
    );
    expect(f.kind).toBe("unknown");
    expect(f.message).not.toMatch(/#\d/);
    expect(f.detail).toContain("KSampler (#3) exploded");
  });

  it("plain unknown errors keep their text", () => {
    const f = classifyCreateResponse(
      { ok: false, error: "Prompt is too long" },
      400,
    );
    expect(f.kind).toBe("unknown");
    expect(f.message).toBe("Prompt is too long");
    expect(f.action).toBeNull();
  });

  it("browser network failure -> Adrift server not answering", () => {
    expect(classifyCreateException("Failed to fetch").kind).toBe(
      "app_unreachable",
    );
  });
});

describe("CreateFailureNotice", () => {
  it("renders Open checklist + dismiss for setup failures", () => {
    const html = renderToStaticMarkup(
      <CreateFailureNotice
        failure={classifyCreateResponse(
          { ok: false, code: "no_checkpoint" },
          500,
        )}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("create-failure-open-setup");
    expect(html).toContain("Open checklist");
    expect(html).toContain("Dismiss");
  });

  it("missing node offers Setup > Node packs, not the checklist", () => {
    const html = renderToStaticMarkup(
      <CreateFailureNotice
        failure={classifyCreateResponse(
          { ok: false, comfy: fixtures.missing_node_type },
          500,
        )}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("Open node packs");
    expect(html).not.toContain("create-failure-open-setup");
  });

  it("RunFailureNotice without actions is unchanged (no empty button row)", () => {
    const html = renderToStaticMarkup(
      <RunFailureNotice
        failure={classifyCreateResponse({ ok: false, error: "x" }, 400)}
      />,
    );
    expect(html).not.toContain("flex-wrap");
  });
});

describe("editFailureMessage", () => {
  it("explains common causes in plain words", () => {
    expect(editFailureMessage("fetch failed")).toContain(
      "ComfyUI isn't running",
    );
    expect(editFailureMessage(new Error("Failed to fetch"))).toContain(
      "Adrift's server isn't answering",
    );
    expect(editFailureMessage("CUDA out of memory")).toContain("GPU memory");
    expect(editFailureMessage(undefined)).toBe(
      "The edit didn't start. Try again.",
    );
  });

  it("clips long raw errors", () => {
    const msg = editFailureMessage("x".repeat(500));
    expect(msg.length).toBeLessThan(200);
    expect(msg.endsWith("…")).toBe(true);
  });
});

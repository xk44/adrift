/**
 * Runner error states: ComfyUI failure payloads -> one human sentence + next
 * step. Fixtures are hand-written from ComfyUI's documented /prompt error
 * format (nothing is POSTed; fetch is stubbed).
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "./fixtures/comfy-errors/prompt-errors.json";

vi.mock("@/lib/env", () => ({
  env: { COMFY_HTTP_URL: "http://127.0.0.1:8188" },
}));
vi.mock("@/lib/comfy/objectInfoCache", () => ({
  assertPromptValid: vi.fn().mockResolvedValue(undefined),
  getObjectInfoCached: vi.fn().mockResolvedValue(null), // model-variant fallback: no-op
  applyOptionalNodeBypass: vi.fn(async (prompt: unknown) => ({
    prompt,
    bypassed: [],
  })),
}));

import {
  classifyJobError,
  classifyRunError,
  failureFromExecutionError,
  failureFromProblems,
  parseComfyPromptError,
} from "@/lib/comfy/runFailure";
import {
  ComfyAPIError,
  comfyErrorDetails,
  queuePrompt,
} from "@/lib/comfy/http";
import { ToolApiError } from "@/lib/tools/runTool";
import { RunFailureNotice } from "@/components/tools/RunFailureNotice";
import type { Workflow } from "@/types";

const titles = {
  "4": "Base model",
  "10": "Reference",
  "21": "Relight LoRA",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseComfyPromptError", () => {
  it("missing_node_type names the node class and points to setup", () => {
    const f = parseComfyPromptError(fixtures.missing_node_type)!;
    expect(f.kind).toBe("missing_node");
    expect(f.nodeClass).toBe("Krea2EditConditioning");
    expect(f.message).toContain('"Krea2EditConditioning"');
    expect(f.message).toContain("Set up this tool");
    expect(f.setup).toBe(true);
    expect(f.startComfy).toBe(false);
  });

  it("legacy 'does not exist' wording is still a missing node", () => {
    const f = parseComfyPromptError(fixtures.legacy_missing_node)!;
    expect(f.kind).toBe("missing_node");
    expect(f.nodeClass).toBe("VHS_VideoCombine");
  });

  it("value_not_in_list on ckpt_name is a missing model file", () => {
    const f = parseComfyPromptError(fixtures.missing_checkpoint, titles)!;
    expect(f.kind).toBe("missing_model");
    expect(f.modelFile).toBe("lumen_v2.safetensors");
    expect(f.message).toBe(
      'ComfyUI can\'t find the model file "lumen_v2.safetensors" for Base model (CheckpointLoaderSimple). Open "Set up this tool" for the download link and folder, then run again.',
    );
    expect(f.setup).toBe(true);
    expect(f.detail).toContain("CheckpointLoaderSimple #4: Value not in list");
  });

  it("reads the file from details when extra_info is absent", () => {
    const f = parseComfyPromptError(fixtures.missing_lora_no_extra, titles)!;
    expect(f.kind).toBe("missing_model");
    expect(f.modelFile).toBe("edit_tools/relight_v1.safetensors");
    expect(f.message).toContain("Relight LoRA (LoraLoaderModelOnly)");
  });

  it("LoadImage invalid file is a missing input, not a model", () => {
    const f = parseComfyPromptError(fixtures.missing_input_image, titles)!;
    expect(f.kind).toBe("missing_input_file");
    expect(f.message).toContain('"cj_ref_mara01.png"');
    expect(f.setup).toBe(false);
    expect(f.retryable).toBe(true);
  });

  it("a bad sampler value is not mistaken for a missing model", () => {
    const f = parseComfyPromptError(fixtures.bad_sampler_value)!;
    expect(f.kind).toBe("invalid_workflow");
    expect(f.message).toBe('KSampler input "sampler_name": Value not in list.');
    expect(f.retryable).toBe(false);
    expect(f.detail).toContain("Value 200 bigger than max of 100: cfg");
  });

  it("required_input_missing names node and input", () => {
    const f = parseComfyPromptError(fixtures.required_input_missing)!;
    expect(f.kind).toBe("invalid_workflow");
    expect(f.message).toBe('VAEDecode input "vae": Required input is missing.');
  });

  it("prompt_no_outputs explains itself", () => {
    const f = parseComfyPromptError(fixtures.no_outputs)!;
    expect(f.kind).toBe("invalid_workflow");
    expect(f.message).toMatch(/no output node/);
  });

  it("returns null for non-ComfyUI bodies", () => {
    expect(parseComfyPromptError(null)).toBeNull();
    expect(parseComfyPromptError("nope")).toBeNull();
    expect(parseComfyPromptError({ ok: false })).toBeNull();
  });
});

describe("execution failures", () => {
  it("OOM from a WS execution_error", () => {
    const f = failureFromExecutionError(fixtures.ws_execution_error_oom.data, {
      "3": "Main sampler",
    });
    expect(f.kind).toBe("out_of_memory");
    expect(f.title).toBe("Out of GPU memory");
    expect(
      f.message.startsWith("Main sampler (KSampler) ran out of memory."),
    ).toBe(true);
    expect(f.retryable).toBe(true);
  });

  it("FileNotFoundError at load time is a missing model", () => {
    const f = failureFromExecutionError(
      fixtures.ws_execution_error_missing_file.data,
    );
    expect(f.kind).toBe("missing_model");
    expect(f.modelFile).toBe("models/diffusion_models/pip_unet.gguf");
  });

  it("InterruptProcessingException reads as interrupted", () => {
    const f = failureFromExecutionError(
      fixtures.ws_execution_error_interrupted.data,
    );
    expect(f.kind).toBe("interrupted");
    expect(f.message.toLowerCase()).not.toContain("fail");
  });

  it("classifies job.error strings built by describeExecutionError", () => {
    expect(
      classifyJobError(
        "Main Sampler (#3) failed: CUDA out of memory. Tried to allocate 2.00 GiB [torch.OutOfMemoryError]",
      ),
    ).toMatchObject({ kind: "out_of_memory" });
    expect(
      classifyJobError("KSampler (#3) failed: MPS backend out of memory"),
    ).toMatchObject({ kind: "out_of_memory" });
    expect(classifyJobError("Processing interrupted")).toMatchObject({
      kind: "interrupted",
    });
    expect(classifyJobError("Run timed out after 600 s")).toMatchObject({
      kind: "timeout",
    });
    expect(classifyJobError("")).toMatchObject({ kind: "unknown" });
    const other = classifyJobError("VAE Decode (#8) failed: shape mismatch");
    expect(other.kind).toBe("unknown");
    expect(other.message).toBe("VAE Decode (#8) failed: shape mismatch");
  });
});

describe("Adrift pre-submit problems (422)", () => {
  it("unknown_class_type -> missing node", () => {
    const f = failureFromProblems([
      {
        kind: "unknown_class_type",
        nodeId: "12",
        nodeTitle: "Edit conditioning",
        classType: "Krea2EditConditioning",
        message:
          'Node class "Krea2EditConditioning" is not installed in ComfyUI (missing custom node?)',
      },
    ])!;
    expect(f.kind).toBe("missing_node");
    expect(f.nodeClass).toBe("Krea2EditConditioning");
  });

  it("invalid_combo_value on a loader -> missing model", () => {
    const f = failureFromProblems([
      {
        kind: "invalid_combo_value",
        nodeId: "40",
        nodeTitle: "Load UNet",
        classType: "UNETLoader",
        input: "unet_name",
        message:
          'Value "pip_unet.gguf" is not an available option for "unet_name" (no options available; is the file installed?)',
      },
    ])!;
    expect(f.kind).toBe("missing_model");
    expect(f.modelFile).toBe("pip_unet.gguf");
    expect(f.message).toContain("Load UNet (UNETLoader)");
  });

  it("ignores non-problem arrays", () => {
    expect(failureFromProblems([{ nope: 1 }])).toBeNull();
    expect(failureFromProblems(undefined)).toBeNull();
  });
});

describe("classifyRunError (API envelope)", () => {
  it("unreachable via details.code", () => {
    const f = classifyRunError({
      message:
        "Cannot connect to ComfyUI at http://127.0.0.1:8188. Is it running?",
      status: 500,
      code: "comfy_unreachable",
    });
    expect(f.kind).toBe("comfy_unreachable");
    expect(f.startComfy).toBe(true);
    expect(f.retryable).toBe(true);
  });

  it("unreachable from a bare upload 502 ('fetch failed')", () => {
    expect(
      classifyRunError({ message: "fetch failed", status: 502 }).kind,
    ).toBe("comfy_unreachable");
  });

  it("browser network error = Adrift server down, not ComfyUI", () => {
    const f = classifyRunError({ message: "Failed to fetch" });
    expect(f.kind).toBe("app_unreachable");
    expect(f.startComfy).toBe(false);
  });

  it("timeout via code and via 504", () => {
    expect(classifyRunError({ message: "x", code: "comfy_timeout" }).kind).toBe(
      "timeout",
    );
    expect(classifyRunError({ message: "Gateway", status: 504 }).kind).toBe(
      "timeout",
    );
  });

  it("ComfyUI body in details.comfy wins over the flat message", () => {
    const f = classifyRunError({
      message:
        "Prompt outputs failed validation\nCheckpointLoaderSimple (#4): ...",
      status: 502,
      details: { code: "comfy_rejected", comfy: fixtures.missing_checkpoint },
    });
    expect(f.kind).toBe("missing_model");
    expect(f.modelFile).toBe("lumen_v2.safetensors");
  });

  it("422 details.problems", () => {
    const f = classifyRunError({
      message: "Workflow failed validation: ...",
      status: 422,
      details: {
        problems: [
          {
            kind: "unknown_class_type",
            nodeId: "1",
            nodeTitle: "X",
            classType: "CJ_Missing",
            message: "not installed",
          },
        ],
      },
    });
    expect(f.kind).toBe("missing_node");
  });

  it("tool route availability codes point at setup", () => {
    const nodes = classifyRunError({
      message:
        "Relight needs ComfyUI custom nodes that are not installed: Krea2EditConditioning, Krea2Refiner (install comfyui-krea2edit)",
      status: 409,
      code: "nodes_missing",
    });
    expect(nodes.kind).toBe("missing_node");
    expect(nodes.nodeClass).toBe("Krea2EditConditioning");
    expect(nodes.setup).toBe(true);
    const lora = classifyRunError({
      message: "LoRA not installed: edit_tools/relight_v1.safetensors",
      status: 409,
      code: "lora_missing",
    });
    expect(lora.kind).toBe("missing_model");
    expect(lora.modelFile).toBe("edit_tools/relight_v1.safetensors");
  });

  it("unknown errors keep the server's message", () => {
    const f = classifyRunError({ message: "Rate limit exceeded", status: 429 });
    expect(f.kind).toBe("unknown");
    expect(f.message).toBe("Rate limit exceeded");
  });

  it("ToolApiError carries the envelope details", () => {
    const e = new ToolApiError("x", 502, "comfy_rejected", {
      code: "comfy_rejected",
    });
    expect(e.details).toEqual({ code: "comfy_rejected" });
  });
});

describe("queuePrompt attaches failure codes (fetch stubbed)", () => {
  const WF = {
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "lumen_v2.safetensors" },
    },
  } as unknown as Workflow;

  async function caught(): Promise<ComfyAPIError> {
    try {
      await queuePrompt(WF, "c1");
    } catch (e) {
      return e as ComfyAPIError;
    }
    throw new Error("expected a rejection");
  }

  it("400 with ComfyUI body -> comfy_rejected + body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(fixtures.missing_checkpoint), {
          status: 400,
        }),
      ),
    );
    const err = await caught();
    expect(err).toBeInstanceOf(ComfyAPIError);
    const details = comfyErrorDetails(err);
    expect(details.code).toBe("comfy_rejected");
    expect(classifyRunError({ message: err.message, details }).kind).toBe(
      "missing_model",
    );
  });

  it("connection refused -> comfy_unreachable (message unchanged)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );
    const err = await caught();
    expect(err.message).toBe(
      "Cannot connect to ComfyUI at http://127.0.0.1:8188. Is it running?",
    );
    expect(comfyErrorDetails(err)).toEqual({ code: "comfy_unreachable" });
  });

  it("AbortSignal timeout -> comfy_timeout (504)", async () => {
    const timeout = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));
    const err = await caught();
    expect(err.statusCode).toBe(504);
    expect(comfyErrorDetails(err)).toEqual({ code: "comfy_timeout" });
  });
});

describe("RunFailureNotice", () => {
  const card = { key: "action:relight", id: "relight", title: "Relight" };

  it("unreachable: retry + start-ComfyUI help, no setup button", () => {
    const html = renderToStaticMarkup(
      <RunFailureNotice
        failure={classifyRunError({ message: "fetch failed", status: 502 })}
        card={card}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain('data-kind="comfy_unreachable"');
    expect(html).toContain("run-failure-retry");
    expect(html).toContain("How to start ComfyUI");
    expect(html).toContain("--enable-cors-header");
    expect(html).not.toContain("setup-tool-");
  });

  it("missing model: setup drawer button", () => {
    const html = renderToStaticMarkup(
      <RunFailureNotice
        failure={parseComfyPromptError(fixtures.missing_checkpoint)!}
        card={card}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("setup-tool-action:relight");
    expect(html).toContain("Set up this tool");
    expect(html).not.toContain("How to start ComfyUI");
  });

  it("non-retryable failures hide the retry button", () => {
    const html = renderToStaticMarkup(
      <RunFailureNotice
        failure={parseComfyPromptError(fixtures.bad_sampler_value)!}
        onRetry={() => {}}
      />,
    );
    expect(html).not.toContain("run-failure-retry");
  });
});

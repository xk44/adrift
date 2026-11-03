import { describe, it, expect } from "vitest";
import {
  describeExecutionError,
  describeExecutionInterrupted,
  extractNodeTitles,
  formatNodeErrors,
} from "@/lib/comfy/errorMessages";
import {
  getPromptTitles,
  rememberPromptTitles,
} from "@/lib/comfy/promptTitles";

const prompt = {
  "4": { class_type: "KSampler", inputs: {}, _meta: { title: "Main Sampler" } },
  "7": { class_type: "VAEDecode", inputs: {} },
};

describe("comfy error messages", () => {
  it("extracts titles, falling back to class_type", () => {
    expect(extractNodeTitles(prompt)).toEqual({
      "4": "Main Sampler",
      "7": "VAEDecode",
    });
  });

  it("execution_error shows title, message and exception type", () => {
    const r = describeExecutionError(
      {
        node_id: "4",
        node_type: "KSampler",
        exception_message: "CUDA out of memory",
        exception_type: "torch.OutOfMemoryError",
      },
      extractNodeTitles(prompt),
    );
    expect(r.state).toBe("error");
    expect(r.message).toBe(
      "Main Sampler (#4) failed: CUDA out of memory [torch.OutOfMemoryError]",
    );
  });

  it("execution_error falls back to node_type without titles", () => {
    const r = describeExecutionError({
      node_id: 4,
      node_type: "KSampler",
      exception_message: "boom",
    });
    expect(r.message).toBe("KSampler (#4) failed: boom");
  });

  it("execution_interrupted reads as cancelled, not failed", () => {
    const r = describeExecutionInterrupted(
      { node_id: "4" },
      extractNodeTitles(prompt),
    );
    expect(r.state).toBe("cancelled");
    expect(r.message).toBe("Cancelled at Main Sampler (#4)");
    expect(r.message.toLowerCase()).not.toContain("fail");
    expect(describeExecutionInterrupted({}).message).toBe("Cancelled");
  });

  it("maps POST /prompt node_errors to titles", () => {
    const text = formatNodeErrors(
      {
        "4": {
          class_type: "KSampler",
          errors: [
            {
              type: "value_not_in_list",
              message: "Value not in list",
              details: "sampler_name: 'x' not in [...]",
            },
          ],
        },
        "9": { class_type: "Mystery", errors: [] },
      },
      extractNodeTitles(prompt),
    );
    expect(text).toContain(
      "Main Sampler (#4): Value not in list (sampler_name: 'x' not in [...])",
    );
    expect(text).toContain("Mystery (#9): invalid");
  });

  it("registry remembers titles by prompt id", () => {
    rememberPromptTitles("pid-1", prompt);
    expect(getPromptTitles("pid-1")?.["4"]).toBe("Main Sampler");
    expect(getPromptTitles("nope")).toBeUndefined();
  });
});

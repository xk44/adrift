/**
 * Runtime enum enrichment for arbitrary/custom ComfyUI nodes.
 */

import { describe, expect, it } from "vitest";
import {
  enrichEnumOptions,
  getRuntimeEnumOptions,
  type ControlSchema,
  type ModelInventory,
} from "@/lib/oj/workflowControlSchema";
import {
  extractEnumOptionsInventory,
  type ObjectInfoResponse,
} from "@/lib/oj/localInventory";

function enumControl(overrides: Partial<ControlSchema> = {}): ControlSchema {
  return {
    key: "9.faceid_mode",
    nodeId: "9",
    inputKey: "faceid_mode",
    classType: "IPAdapterApplyFaceID",
    kind: "enum",
    label: "Faceid Mode",
    group: "IP-Adapter",
    defaultValue: "orthogonal",
    options: ["orthogonal", "concat"],
    visible: true,
    order: 510,
    ...overrides,
  };
}

describe("extractEnumOptionsInventory", () => {
  it("extracts required and optional enum lists from ComfyUI object_info", () => {
    const objectInfo: ObjectInfoResponse = {
      IPAdapterApplyFaceID: {
        input: {
          required: {
            faceid_mode: [["orthogonal", "concat", "vit_h"], {}],
            weight: ["FLOAT", { default: 1 }],
          },
          optional: {
            combine_embeds: [["average", "concat"], {}],
          },
        },
      },
    };

    expect(extractEnumOptionsInventory(objectInfo)).toEqual({
      IPAdapterApplyFaceID: {
        faceid_mode: ["orthogonal", "concat", "vit_h"],
        combine_embeds: ["average", "concat"],
      },
    });
  });

  it("ignores non-string enum values and non-list specs", () => {
    const objectInfo: ObjectInfoResponse = {
      WeirdCustomNode: {
        input: {
          required: {
            mixed: [["safe", 42, "other"], {}],
            scalar: ["STRING", {}],
          },
        },
      },
    };

    expect(extractEnumOptionsInventory(objectInfo)).toEqual({
      WeirdCustomNode: {
        mixed: ["safe", "other"],
      },
    });
  });
});

describe("runtime enum enrichment", () => {
  it("uses live class_type/input enum options before static fallbacks", () => {
    const control = enumControl();
    const inventory: ModelInventory = {
      enumOptions: {
        IPAdapterApplyFaceID: {
          faceid_mode: ["orthogonal", "concat", "vit_h"],
        },
      },
    };

    expect(getRuntimeEnumOptions(control, inventory)).toEqual([
      "orthogonal",
      "concat",
      "vit_h",
    ]);
    expect(enrichEnumOptions(control, inventory)).toEqual([
      "orthogonal",
      "concat",
      "vit_h",
    ]);
  });

  it("preserves static fallback options when live options are unavailable", () => {
    const control = enumControl();
    expect(enrichEnumOptions(control, {})).toEqual(["orthogonal", "concat"]);
  });

  it("keeps static extras after live options for offline-compatible fallback", () => {
    const control = enumControl({ options: ["orthogonal", "concat", "legacy"] });
    const inventory: ModelInventory = {
      enumOptions: {
        IPAdapterApplyFaceID: {
          faceid_mode: ["orthogonal", "vit_h"],
        },
      },
    };

    expect(enrichEnumOptions(control, inventory)).toEqual([
      "orthogonal",
      "vit_h",
      "concat",
      "legacy",
    ]);
  });

  it("still merges sampler and scheduler inventory when generic enum map is absent", () => {
    const sampler = enumControl({
      key: "4.sampler_name",
      inputKey: "sampler_name",
      classType: "KSampler",
      group: "Sampling",
      defaultValue: "euler",
      options: ["euler"],
    });

    expect(enrichEnumOptions(sampler, { samplers: ["euler", "dpmpp_2m"] })).toEqual([
      "euler",
      "dpmpp_2m",
    ]);
  });
});

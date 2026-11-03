/**
 * Workflow Graph Validation Tests
 *
 * Validates every public/workflows/*.json for:
 *   - Valid JSON / expected shape
 *   - No dangling node references
 *   - Required output/sampler/encoder nodes by workflow kind
 *   - Registry/template/action parity
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKFLOWS_DIR = path.join(process.cwd(), "public/workflows");
const REGISTRY_PATH = path.join(process.cwd(), "src/lib/oj/registry.json");

type NodeEntry = {
  class_type: string;
  inputs?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

type WorkflowGraph = Record<string, NodeEntry>;

function loadWorkflow(filename: string): WorkflowGraph {
  const raw = fs.readFileSync(path.join(WORKFLOWS_DIR, filename), "utf-8");
  return JSON.parse(raw) as WorkflowGraph;
}

function workflowFiles(): string[] {
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

function classTypes(graph: WorkflowGraph): string[] {
  return Object.values(graph).map((n) => n.class_type);
}

function hasAny(types: string[], candidates: string[]): boolean {
  return candidates.some((c) => types.includes(c));
}

// ---------------------------------------------------------------------------
// Output node sets
// ---------------------------------------------------------------------------

const OUTPUT_NODES = [
  "SaveImage",
  "PreviewImage",
  "VHS_VideoCombine",
  // native video save path (ComfyUI 0.24+), used by the LTXV/Wan workflows
  "SaveVideo",
  "SaveWEBM",
  "SaveAudioMP3",
  "SaveGLB",
  "SaveAudio",
];

const SAMPLER_NODES = [
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
  "StableAudioSampler",
  "TripoSRSampler",
  // Remote API partner nodes sample server-side
  "Krea2ImageNode",
];

// ---------------------------------------------------------------------------
// Per-file tests: valid JSON + shape
// ---------------------------------------------------------------------------

describe("workflow files – valid JSON and shape", () => {
  it.each(workflowFiles())("%s parses as a non-empty object", (filename) => {
    const graph = loadWorkflow(filename);
    expect(typeof graph).toBe("object");
    expect(graph).not.toBeNull();
    expect(Object.keys(graph).length).toBeGreaterThan(0);
  });

  it.each(workflowFiles())(
    "%s every node has class_type (string) and inputs (object)",
    (filename) => {
      const graph = loadWorkflow(filename);
      for (const [nodeId, node] of Object.entries(graph)) {
        expect(
          typeof node.class_type,
          `node ${nodeId} missing class_type`,
        ).toBe("string");
        expect(
          node.class_type.length,
          `node ${nodeId} class_type is empty`,
        ).toBeGreaterThan(0);
        if (node.inputs !== undefined) {
          expect(
            typeof node.inputs,
            `node ${nodeId} inputs must be object`,
          ).toBe("object");
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Per-file tests: no dangling node references
// ---------------------------------------------------------------------------

describe("workflow files – no dangling node references", () => {
  it.each(workflowFiles())(
    "%s all [nodeId, outputIndex] refs point to existing nodes",
    (filename) => {
      const graph = loadWorkflow(filename);
      const nodeIds = new Set(Object.keys(graph));

      for (const [nodeId, node] of Object.entries(graph)) {
        if (!node.inputs) continue;
        for (const [inputKey, value] of Object.entries(node.inputs)) {
          // ComfyUI node link format: [sourceNodeId, outputIndex]
          if (
            Array.isArray(value) &&
            value.length === 2 &&
            typeof value[0] === "string" &&
            typeof value[1] === "number"
          ) {
            const [refId] = value as [string, number];
            expect(
              nodeIds.has(refId),
              `node "${nodeId}" input "${inputKey}" references missing node "${refId}"`,
            ).toBe(true);
          }
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Per-file tests: required class_types by workflow kind
// ---------------------------------------------------------------------------

describe("workflow files – required output nodes", () => {
  it.each(workflowFiles())(
    "%s has at least one recognised output node",
    (filename) => {
      const graph = loadWorkflow(filename);
      const types = classTypes(graph);
      expect(
        hasAny(types, OUTPUT_NODES),
        `expected one of [${OUTPUT_NODES.join(", ")}], found: [${types.join(", ")}]`,
      ).toBe(true);
    },
  );
});

describe("workflow files – sampler node present for generative workflows", () => {
  // Upscale workflows use deterministic models, not samplers — exclude them.
  const NON_SAMPLER_PREFIXES = ["upscale"];

  const generativeFiles = workflowFiles().filter(
    (f) => !NON_SAMPLER_PREFIXES.some((p) => f.startsWith(p)),
  );

  it.each(generativeFiles)("%s has at least one sampler node", (filename) => {
    const graph = loadWorkflow(filename);
    const types = classTypes(graph);
    expect(
      hasAny(types, SAMPLER_NODES),
      `expected one of [${SAMPLER_NODES.join(", ")}], found: [${types.join(", ")}]`,
    ).toBe(true);
  });
});

describe("workflow files – text-encoder present for text-capable workflows", () => {
  // Workflows that take a text prompt must have CLIPTextEncode (or equivalent).
  // Pure image-passthrough / upscale / i23d (image → 3D model) are excluded.
  const TEXT_ENCODER_EXCLUDED = [
    "upscale",
    "upscale_subtle",
    "upscale_creative",
    "i23d",
  ];

  const textFiles = workflowFiles().filter(
    (f) =>
      !TEXT_ENCODER_EXCLUDED.some(
        (ex) => f === `${ex}.json` || f.startsWith(`${ex}_`),
      ),
  );

  it.each(textFiles)("%s has CLIPTextEncode", (filename) => {
    const graph = loadWorkflow(filename);
    const types = classTypes(graph);
    expect(
      types.includes("CLIPTextEncode"),
      `expected CLIPTextEncode, found: [${types.join(", ")}]`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Registry parity tests
// ---------------------------------------------------------------------------

describe("registry parity", () => {
  // Load once; all sub-tests share this
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8")) as {
    templates: Record<string, { file: string; kind: string }>;
    actions: Record<string, { template: string }>;
  };

  const templateEntries = Object.entries(registry.templates);
  const actionEntries = Object.entries(registry.actions);

  it.each(templateEntries)(
    "template '%s' → file exists in public/workflows/",
    (templateKey, def) => {
      const filePath = path.join(WORKFLOWS_DIR, def.file);
      expect(
        fs.existsSync(filePath),
        `template "${templateKey}" references missing file "${def.file}"`,
      ).toBe(true);
    },
  );

  it.each(actionEntries)(
    "action '%s' → template exists in registry",
    (actionKey, def) => {
      expect(
        registry.templates[def.template],
        `action "${actionKey}" references missing template "${def.template}"`,
      ).toBeDefined();
    },
  );
});

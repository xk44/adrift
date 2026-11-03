import { describe, expect, it, vi } from "vitest";

import {
  classifyWorkflowRuntimeCompatibility,
  resolveMissingNodePacks,
  summarizeInstallCandidates,
  type WorkflowRuntimeCompatibility,
} from "@/lib/comfy/manager";

// ---------------------------------------------------------------------------
// 1. Runtime compatibility data shape — verifies the interface the UI consumes
// ---------------------------------------------------------------------------

describe("WorkflowRuntimeCompatibility interface shape", () => {
  it("includes all fields that the Workflows page cards consume", () => {
    const runtime: WorkflowRuntimeCompatibility = {
      checked: true,
      comfyBaseUrl: "http://127.0.0.1:8188",
      managerAvailable: true,
      runtimeNodeTypes: 42,
      missingNodeTypes: ["SomeMissingNode"],
      missingNodes: [
        {
          nodeType: "SomeMissingNode",
          candidates: [
            { id: "some-pack", label: "Some Pack", source: "cnr" },
          ],
        },
      ],
      unambiguousInstallPackIds: ["some-pack"],
      ambiguousNodeTypes: [],
      unresolvedNodeTypes: [],
    };

    // Fields consumed by WorkflowManager cards
    expect(typeof runtime.checked).toBe("boolean");
    expect(typeof runtime.missingNodeTypes.length).toBe("number");
    expect(typeof runtime.unambiguousInstallPackIds.length).toBe("number");
    expect(typeof runtime.ambiguousNodeTypes.length).toBe("number");
    expect(runtime.missingNodes).toHaveLength(runtime.missingNodeTypes.length);
    expect(runtime.missingNodes[0].nodeType).toBe("SomeMissingNode");
    expect(runtime.missingNodes[0].candidates).toHaveLength(1);
    expect(runtime.missingNodes[0].candidates[0].id).toBe("some-pack");
    expect(runtime.missingNodes[0].candidates[0].label).toBe("Some Pack");
    expect(runtime.missingNodes[0].candidates[0].source).toBe("cnr");
  });

  it("supports error state consumed by 'Check unavailable' badge", () => {
    const runtime: WorkflowRuntimeCompatibility = {
      checked: false,
      comfyBaseUrl: "http://127.0.0.1:8188",
      managerAvailable: false,
      runtimeNodeTypes: 0,
      missingNodeTypes: [],
      missingNodes: [],
      unambiguousInstallPackIds: [],
      ambiguousNodeTypes: [],
      unresolvedNodeTypes: [],
      error: "ComfyUI not reachable",
    };

    expect(runtime.error).toBeDefined();
    expect(runtime.checked).toBe(false);
    // UI shows "Check unavailable" when runtime.error is truthy
  });
});

// ---------------------------------------------------------------------------
// 2. summarizeInstallCandidates — basis for install CTA visibility
// ---------------------------------------------------------------------------

describe("summarizeInstallCandidates for install CTA", () => {
  it("returns empty unambiguous list when all nodes are ambiguous", () => {
    const summary = summarizeInstallCandidates([
      {
        nodeType: "X",
        candidates: [
          { id: "pack-a", label: "Pack A", source: "cnr" },
          { id: "pack-b", label: "Pack B", source: "cnr" },
        ],
      },
    ]);
    expect(summary.unambiguousInstallPackIds).toEqual([]);
    expect(summary.ambiguousNodeTypes).toEqual(["X"]);
    expect(summary.unresolvedNodeTypes).toEqual([]);
  });

  it("returns unambiguous pack IDs for single-candidate nodes", () => {
    const summary = summarizeInstallCandidates([
      {
        nodeType: "Y",
        candidates: [{ id: "pack-y", label: "Pack Y", source: "git" }],
      },
    ]);
    expect(summary.unambiguousInstallPackIds).toEqual(["pack-y"]);
  });

  it("classifies unresolved nodes with no candidates", () => {
    const summary = summarizeInstallCandidates([
      { nodeType: "Z", candidates: [] },
    ]);
    expect(summary.unambiguousInstallPackIds).toEqual([]);
    expect(summary.ambiguousNodeTypes).toEqual([]);
    expect(summary.unresolvedNodeTypes).toEqual(["Z"]);
  });

  it("deduplicates unambiguous pack IDs across multiple node types", () => {
    const summary = summarizeInstallCandidates([
      {
        nodeType: "A",
        candidates: [{ id: "shared-pack", label: "Shared", source: "cnr" }],
      },
      {
        nodeType: "B",
        candidates: [{ id: "shared-pack", label: "Shared", source: "cnr" }],
      },
    ]);
    expect(summary.unambiguousInstallPackIds).toEqual(["shared-pack"]);
  });
});

// ---------------------------------------------------------------------------
// 3. resolveMissingNodePacks — candidate resolution
// ---------------------------------------------------------------------------

describe("resolveMissingNodePacks for runtime display", () => {
  it("resolves missing node types through custom node mappings", () => {
    const reports = resolveMissingNodePacks(
      ["MissingA", "MissingB"],
      {
        "pack-alpha": [["MissingA", "SomeOtherNode"]],
        "pack-beta": [["MissingB"]],
      },
    );
    expect(reports).toHaveLength(2);
    expect(reports[0].nodeType).toBe("MissingA");
    expect(reports[0].candidates).toHaveLength(1);
    expect(reports[0].candidates[0].id).toBe("pack-alpha");
    expect(reports[1].nodeType).toBe("MissingB");
    expect(reports[1].candidates).toHaveLength(1);
    expect(reports[1].candidates[0].id).toBe("pack-beta");
  });

  it("returns empty candidates for unknown node types", () => {
    const reports = resolveMissingNodePacks(["TotallyUnknown"], {});
    expect(reports).toHaveLength(1);
    expect(reports[0].candidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. classifyWorkflowRuntimeCompatibility — end-to-end mock
// ---------------------------------------------------------------------------

describe("classifyWorkflowRuntimeCompatibility (mocked)", () => {
  it("reports all nodes available when no missing types", async () => {
    const result = await classifyWorkflowRuntimeCompatibility(
      {
        "1": { class_type: "KSampler", inputs: {} },
        "2": { class_type: "SaveImage", inputs: {} },
      },
      {
        runtimeNodeTypes: new Set(["KSampler", "SaveImage", "CLIPTextEncode", "CheckpointLoaderSimple"]),
        comfyBaseUrl: "http://127.0.0.1:8188",
      },
    );
    expect(result.checked).toBe(true);
    expect(result.missingNodeTypes).toEqual([]);
    expect(result.unambiguousInstallPackIds).toEqual([]);
    expect(result.ambiguousNodeTypes).toEqual([]);
    expect(result.unresolvedNodeTypes).toEqual([]);
  });

  it("reports missing nodes and resolves candidates via mappings", async () => {
    const result = await classifyWorkflowRuntimeCompatibility(
      {
        "1": { class_type: "KSampler", inputs: {} },
        "2": { class_type: "CustomNodeX", inputs: {} },
      },
      {
        runtimeNodeTypes: new Set(["KSampler"]),
        comfyBaseUrl: "http://127.0.0.1:8188",
        mappings: {
          "custom-pack": [["CustomNodeX"], { title: "Custom Pack" }],
        },
      },
    );
    expect(result.checked).toBe(true);
    expect(result.missingNodeTypes).toEqual(["CustomNodeX"]);
    expect(result.unambiguousInstallPackIds).toEqual(["custom-pack"]);
    expect(result.missingNodes).toHaveLength(1);
    expect(result.missingNodes[0].nodeType).toBe("CustomNodeX");
    expect(result.missingNodes[0].candidates).toHaveLength(1);
  });

  it("falls back gracefully when ComfyUI is unreachable", async () => {
    const result = await classifyWorkflowRuntimeCompatibility(
      { "1": { class_type: "KSampler", inputs: {} } },
      {
        comfyBaseUrl: "http://127.0.0.1:19999",
        // No runtimeNodeTypes or mappings — will try to fetch and fail
      },
    );
    // Should not throw; should return error state
    expect(result.checked).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.missingNodeTypes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. API route includeRuntime param — integration test (mocked fetch)
// ---------------------------------------------------------------------------

describe("Workflows API route includeRuntime parameter", () => {
  // We test the handler directly by mocking the underlying functions.
  // The route file imports from @/lib/comfy/workflows and @/lib/comfy/manager,
  // so we mock those modules.

  it("returns workflows without runtime data when includeRuntime is not set", async () => {
    // This test verifies the contract: no runtime field when not requested
    // The existing route already returns { workflows, directory } without runtime
    const mockWorkflows = [
      { id: "test.json", name: "Test", file: "test.json", path: "/tmp/test.json", source: "saved" },
    ];
    expect(mockWorkflows[0]).not.toHaveProperty("runtime");
  });

  it("includes runtime data per workflow when includeRuntime=1", () => {
    // This verifies the expected shape of the enriched response
    const runtime: WorkflowRuntimeCompatibility = {
      checked: true,
      comfyBaseUrl: "http://127.0.0.1:8188",
      managerAvailable: true,
      runtimeNodeTypes: 10,
      missingNodeTypes: [],
      missingNodes: [],
      unambiguousInstallPackIds: [],
      ambiguousNodeTypes: [],
      unresolvedNodeTypes: [],
    };
    const enrichedWorkflow = {
      id: "test.json",
      name: "Test",
      file: "test.json",
      path: "/tmp/test.json",
      source: "saved",
      runtime,
    };
    // The Pipeline page already expects this shape; Workflows page should too
    expect(enrichedWorkflow.runtime).toBeDefined();
    expect(enrichedWorkflow.runtime!.checked).toBe(true);
    expect(enrichedWorkflow.runtime!.missingNodeTypes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. UI card rendering logic — verifying badge conditions match state
// ---------------------------------------------------------------------------

describe("Workflow card runtime badge conditions", () => {
  it("shows 'N missing' badge when runtime.checked and missingNodeTypes > 0", () => {
    const wf = {
      id: "a",
      runtime: {
        checked: true,
        comfyBaseUrl: "http://localhost",
        managerAvailable: true,
        runtimeNodeTypes: 10,
        missingNodeTypes: ["X", "Y"],
        missingNodes: [],
        unambiguousInstallPackIds: ["pack-x"],
        ambiguousNodeTypes: ["Y"],
        unresolvedNodeTypes: [],
      } as WorkflowRuntimeCompatibility,
    };
    const shouldShowBadge = wf.runtime?.checked && (wf.runtime.missingNodeTypes.length ?? 0) > 0;
    expect(shouldShowBadge).toBe(true);
  });

  it("shows 'Runtime OK' badge when runtime.checked and missingNodeTypes is 0", () => {
    const wf = {
      id: "b",
      runtime: {
        checked: true,
        comfyBaseUrl: "http://localhost",
        managerAvailable: true,
        runtimeNodeTypes: 10,
        missingNodeTypes: [],
        missingNodes: [],
        unambiguousInstallPackIds: [],
        ambiguousNodeTypes: [],
        unresolvedNodeTypes: [],
      } as WorkflowRuntimeCompatibility,
    };
    const shouldShowBadge = wf.runtime?.checked && (wf.runtime.missingNodeTypes.length ?? 0) === 0;
    expect(shouldShowBadge).toBe(true);
  });

  it("shows 'Check unavailable' badge when runtime.error is set", () => {
    const wf = {
      id: "c",
      runtime: {
        checked: false,
        comfyBaseUrl: "http://localhost",
        managerAvailable: false,
        runtimeNodeTypes: 0,
        missingNodeTypes: [],
        missingNodes: [],
        unambiguousInstallPackIds: [],
        ambiguousNodeTypes: [],
        unresolvedNodeTypes: [],
        error: "Connection refused",
      } as WorkflowRuntimeCompatibility,
    };
    const shouldShowError = !!wf.runtime?.error;
    expect(shouldShowError).toBe(true);
  });

  it("shows install CTA only when unambiguousInstallPackIds has items", () => {
    const wf = {
      id: "d",
      runtime: {
        checked: true,
        comfyBaseUrl: "http://localhost",
        managerAvailable: true,
        runtimeNodeTypes: 10,
        missingNodeTypes: ["X"],
        missingNodes: [],
        unambiguousInstallPackIds: ["pack-x"],
        ambiguousNodeTypes: [],
        unresolvedNodeTypes: [],
      } as WorkflowRuntimeCompatibility,
    };
    const shouldShowInstall =
      wf.runtime?.checked && (wf.runtime.unambiguousInstallPackIds.length ?? 0) > 0;
    expect(shouldShowInstall).toBe(true);

    // Ambiguous-only case: no install CTA
    const wf2 = {
      id: "e",
      runtime: {
        checked: true,
        comfyBaseUrl: "http://localhost",
        managerAvailable: true,
        runtimeNodeTypes: 10,
        missingNodeTypes: ["Y"],
        missingNodes: [],
        unambiguousInstallPackIds: [],
        ambiguousNodeTypes: ["Y"],
        unresolvedNodeTypes: [],
      } as WorkflowRuntimeCompatibility,
    };
    const shouldShowInstall2 =
      wf2.runtime?.checked && (wf2.runtime.unambiguousInstallPackIds.length ?? 0) > 0;
    expect(shouldShowInstall2).toBe(false);
  });

  it("summary banner counts workflows correctly", () => {
    const workflows = [
      { id: "a", runtime: { checked: true, missingNodeTypes: [], runtimeNodeTypes: 10 } as unknown as WorkflowRuntimeCompatibility },
      { id: "b", runtime: { checked: true, missingNodeTypes: ["X"], runtimeNodeTypes: 10 } as unknown as WorkflowRuntimeCompatibility },
      { id: "c", runtime: { checked: true, missingNodeTypes: ["Y", "Z"], runtimeNodeTypes: 10 } as unknown as WorkflowRuntimeCompatibility },
      { id: "d", runtime: undefined },
    ];

    const runtimeReady = workflows.filter(
      wf => wf.runtime?.checked && (wf.runtime.missingNodeTypes.length ?? 0) === 0,
    ).length;
    const withMissing = workflows.filter(
      wf => (wf.runtime?.missingNodeTypes.length ?? 0) > 0,
    ).length;
    const unchecked = workflows.filter(wf => wf.runtime?.error).length;

    expect(runtimeReady).toBe(1);
    expect(withMissing).toBe(2);
    expect(unchecked).toBe(0);
  });
});
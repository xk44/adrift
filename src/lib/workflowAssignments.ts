export interface WorkflowAssignment {
  workflowPath: string;
  workflowName?: string | null;
}

export interface WorkflowAssignmentSlot {
  id: string;
  label: string;
  description: string;
  fallback: string;
  legacyActionId?: string;
  recommendedKind?:
    | "t2i"
    | "i2i"
    | "upscale"
    | "inpaint"
    | "outpaint"
    | "t2v"
    | "i2v"
    | "t23d"
    | "i23d"
    | "t2a";
}

export interface WorkflowAssignmentGroup {
  id: string;
  label: string;
  eyebrow: string;
  description: string;
  slots: WorkflowAssignmentSlot[];
}

export const ACTION_ASSIGNMENT_GROUPS: WorkflowAssignmentGroup[] = [
  {
    id: "create",
    label: "Promptbar",
    eyebrow: "Create lane",
    description:
      "Routes the main imagine button without removing the quick workflow picker.",
    slots: [
      {
        id: "promptbar.imagine",
        label: "Promptbar Imagine",
        description: "The main prompt submit button in Create.",
        fallback: "Selected workflow → app default → built-in text-to-image",
        recommendedKind: "t2i",
      },
    ],
  },
  {
    id: "editor",
    label: "Edit / canvas",
    eyebrow: "Inpaint",
    description: "The workflow used when the editor submits a painted mask.",
    slots: [
      {
        id: "edit.inpaint",
        label: "Edit / Inpaint",
        description: "Editor prompt submit with source image and mask data.",
        fallback: "Built-in inpaint workflow",
        legacyActionId: "edit",
        recommendedKind: "inpaint",
      },
    ],
  },
  {
    id: "single-image",
    label: "Single-image actions",
    eyebrow: "Bottom-right action rail",
    description:
      "Assignments for the action buttons on the image detail / lightbox view and gallery action pills.",
    slots: [
      {
        id: "single.vary_subtle",
        label: "Vary Subtle",
        description: "Low-denoise image-to-image variation.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "vary_subtle",
        recommendedKind: "i2i",
      },
      {
        id: "single.vary_strong",
        label: "Vary Strong",
        description: "Higher-denoise image-to-image variation.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "vary_strong",
        recommendedKind: "i2i",
      },
      {
        id: "single.upscale_subtle",
        label: "Upscale Subtle",
        description: "Conservative upscale/refine action.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "upscale_subtle",
        recommendedKind: "upscale",
      },
      {
        id: "single.upscale_creative",
        label: "Upscale Creative",
        description: "Creative upscale/refine action.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "upscale_creative",
        recommendedKind: "upscale",
      },
      {
        id: "single.remix_subtle",
        label: "Remix Subtle",
        description: "Prompt-aware low-denoise remix.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "remix_subtle",
        recommendedKind: "i2i",
      },
      {
        id: "single.remix_strong",
        label: "Remix Strong",
        description: "Prompt-aware stronger remix.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "remix_strong",
        recommendedKind: "i2i",
      },
      {
        id: "single.pan_up",
        label: "Pan Up",
        description: "Outpaint upward from the selected image.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "pan_up",
        recommendedKind: "outpaint",
      },
      {
        id: "single.pan_down",
        label: "Pan Down",
        description: "Outpaint downward from the selected image.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "pan_down",
        recommendedKind: "outpaint",
      },
      {
        id: "single.pan_left",
        label: "Pan Left",
        description: "Outpaint left from the selected image.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "pan_left",
        recommendedKind: "outpaint",
      },
      {
        id: "single.pan_right",
        label: "Pan Right",
        description: "Outpaint right from the selected image.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "pan_right",
        recommendedKind: "outpaint",
      },
      {
        id: "single.zoom_out_1_5x",
        label: "Zoom Out 1.5×",
        description: "Outpaint around the image at 1.5× zoom.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "zoom_1_5x",
        recommendedKind: "outpaint",
      },
      {
        id: "single.zoom_out_2x",
        label: "Zoom Out 2×",
        description: "Outpaint around the image at 2× zoom.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "zoom_2x",
        recommendedKind: "outpaint",
      },
    ],
  },
  {
    id: "media-expand",
    label: "Media expansion",
    eyebrow: "Video · 3D · Audio",
    description:
      "Workflows for turning images into video or 3D models. These power the Animate and Make 3D buttons in the image viewer.",
    slots: [
      {
        id: "expand.animate_low",
        label: "Animate – Low Motion",
        description:
          "Convert a still image to a short video with subtle motion.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "animate_low",
        recommendedKind: "i2v",
      },
      {
        id: "expand.animate_high",
        label: "Animate – High Motion",
        description: "Convert a still image to a video with stronger motion.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "animate_high",
        recommendedKind: "i2v",
      },
      {
        id: "expand.make_3d",
        label: "Create 3D Model",
        description:
          "Generate a 3D mesh (GLB) from a selected image with TRELLIS.2.",
        fallback: "Built-in workflow for the active model",
        legacyActionId: "make_3d",
        recommendedKind: "i23d",
      },
      {
        id: "expand.text_to_audio",
        label: "Text to Audio",
        description:
          "Generate audio from a text prompt using Stable Audio or similar.",
        fallback:
          "Assigned workflow → Stable Audio 3 Medium (if installed) → Stable Audio 3 small SFX",
        recommendedKind: "t2a",
      },
    ],
  },
];

export const WORKFLOW_ASSIGNMENT_SLOTS = ACTION_ASSIGNMENT_GROUPS.flatMap(
  (group) => group.slots,
);

export const WORKFLOW_ASSIGNMENT_FALLBACKS = Object.fromEntries(
  WORKFLOW_ASSIGNMENT_SLOTS.map((slot) => [slot.id, slot.fallback]),
) as Record<string, string>;

export function normalizeWorkflowActionId(actionId: string): string {
  if (actionId === "zoom_out_1_5x") return "zoom_1_5x";
  if (actionId === "zoom_out_2x") return "zoom_2x";
  return actionId;
}

export function getSingleImageSlotId(actionId: string): string {
  return `single.${actionId}`;
}

export function getSlotById(
  slotId: string,
): WorkflowAssignmentSlot | undefined {
  return WORKFLOW_ASSIGNMENT_SLOTS.find((slot) => slot.id === slotId);
}

export function getSlotIdForAction(actionId: string): string {
  // If the actionId is already a full slot ID (contains a dot and matches a slot), return it directly.
  if (actionId.includes(".")) {
    const slot = getSlotById(actionId);
    if (slot) return actionId;
  }

  const exact = `single.${actionId}`;
  if (getSlotById(exact)) return exact;

  const normalized = normalizeWorkflowActionId(actionId);
  const normalizedSlot = WORKFLOW_ASSIGNMENT_SLOTS.find(
    (slot) => slot.legacyActionId === normalized,
  );
  return normalizedSlot?.id ?? exact;
}

/** Slots that fall back to the Create picker's selected/default workflow. */
export function slotInheritsSelectedWorkflow(slotId: string): boolean {
  return slotId.startsWith("promptbar.");
}

/**
 * Prompt flags whose server-side routing (video/3D/audio packs, controlnet,
 * style-reference graphs, model packs) is skipped whenever workflow_path is
 * set. A fixed t2i graph can't honour them, so they keep their own pipelines.
 */
export const DEDICATED_ROUTE_FLAGS = new Set([
  "--video",
  "--3d",
  "--audio",
  "--controlnet",
  "--cn",
  "--sref",
  "--sv",
  "--cref",
  "--model",
  "--niji",
]);

export function promptHasDedicatedRoute(prompt: string): boolean {
  return prompt
    .split(/\s+/)
    .some((token) => DEDICATED_ROUTE_FLAGS.has(token.toLowerCase()));
}

/**
 * Routing flags whose server pipeline an explicit slot assignment replaces:
 * `--audio` runs the graph assigned to "Text to Audio" when there is one.
 */
export const ROUTE_FLAG_SLOTS: Readonly<Record<string, string>> = {
  "--audio": "expand.text_to_audio",
};

/** Explicitly assigned graph for the prompt's routing flag, if any. */
export function routeSlotWorkflowPath(
  prompt: string,
  assignments: Record<string, WorkflowAssignment | undefined>,
): string | undefined {
  const tokens = prompt.split(/\s+/).map((t) => t.toLowerCase());
  for (const [flag, slotId] of Object.entries(ROUTE_FLAG_SLOTS)) {
    if (tokens.includes(flag)) return assignments[slotId]?.workflowPath || undefined;
  }
  return undefined;
}

/** workflow_path for an imagine request, or undefined to let the server route. */
export function imagineWorkflowPathForPrompt(
  workflowPath: string | null | undefined,
  prompt: string,
): string | undefined {
  if (!workflowPath) return undefined;
  return promptHasDedicatedRoute(prompt) ? undefined : workflowPath;
}

export function resolveWorkflowForAssignment({
  slotId,
  legacyActionId,
  assignments,
  legacyActionMap,
  selectedWorkflowPath,
  selectedWorkflowName,
  defaultWorkflowPath,
  defaultWorkflowName,
}: {
  slotId: string;
  legacyActionId?: string;
  assignments: Record<string, WorkflowAssignment | undefined>;
  legacyActionMap?: Record<string, WorkflowAssignment | undefined>;
  selectedWorkflowPath?: string | null;
  selectedWorkflowName?: string | null;
  defaultWorkflowPath?: string | null;
  defaultWorkflowName?: string | null;
}): WorkflowAssignment | undefined {
  const slot = getSlotById(slotId);
  const normalizedLegacy = legacyActionId
    ? normalizeWorkflowActionId(legacyActionId)
    : slot?.legacyActionId;

  const explicit = assignments[slotId];
  if (explicit?.workflowPath) return explicit;

  const legacy = normalizedLegacy
    ? legacyActionMap?.[normalizedLegacy]
    : undefined;
  if (legacy?.workflowPath) return legacy;

  // The selected/default workflow is a promptbar (t2i) choice. The server
  // treats any workflow_path as a top-priority override, so letting it leak
  // into image actions routes vary/upscale/pan/inpaint/animate through a
  // graph with no LoadImage ("I2I slot discovery failed") and bypasses the
  // action packs. Only promptbar slots inherit it.
  if (!slotInheritsSelectedWorkflow(slotId)) return undefined;

  if (selectedWorkflowPath) {
    return {
      workflowPath: selectedWorkflowPath,
      workflowName: selectedWorkflowName,
    };
  }

  if (defaultWorkflowPath) {
    return {
      workflowPath: defaultWorkflowPath,
      workflowName: defaultWorkflowName,
    };
  }

  return undefined;
}

export function getAssignmentLabel(
  slotId: string,
  assignments: Record<string, WorkflowAssignment | undefined>,
): string {
  const assignment = assignments[slotId];
  if (assignment?.workflowName) return assignment.workflowName;
  if (assignment?.workflowPath) return assignment.workflowPath;
  return WORKFLOW_ASSIGNMENT_FALLBACKS[slotId] ?? "Built-in routing";
}

/**
 * Resolve the workflow path for a given action by converting the action ID
 * to its slot-based assignment, then falling through the same resolution
 * chain as resolveWorkflowForAssignment.
 *
 * This is the primary entry point for UI consumers (Gallery, Lightbox, etc.)
 * that need to resolve an action's workflow without directly touching the
 * slot ID mapping.
 *
 * Resolution order:
 *   1. Explicit slot assignment (assignments[slotId])
 *   2. Legacy actionWorkflowMap[actionId].workflowPath
 *   3. selectedWorkflowPath (promptbar slots only)
 *   4. defaultWorkflowPath (promptbar slots only)
 *   5. undefined (caller should fall back to server-side pack/registry)
 */
export function resolveWorkflowForAction(actionId: string, opts: {
  assignments?: Record<string, WorkflowAssignment | undefined>;
  legacyActionMap?: Record<string, WorkflowAssignment | undefined>;
  selectedWorkflowPath?: string | null;
  selectedWorkflowName?: string | null;
  defaultWorkflowPath?: string | null;
  defaultWorkflowName?: string | null;
}): WorkflowAssignment | undefined {
  const slotId = getSlotIdForAction(actionId);
  return resolveWorkflowForAssignment({
    slotId,
    assignments: opts.assignments ?? {},
    legacyActionMap: opts.legacyActionMap,
    selectedWorkflowPath: opts.selectedWorkflowPath,
    selectedWorkflowName: opts.selectedWorkflowName,
    defaultWorkflowPath: opts.defaultWorkflowPath,
    defaultWorkflowName: opts.defaultWorkflowName,
  });
}

/**
 * Convert a UI actionWorkflowMap (keyed by raw action id like "vary_subtle")
 * into the slot-based assignments format. If the actionWorkflowMap uses keys
 * that match legacy action IDs, this remaps them to the canonical slot IDs.
 *
 * Merges any existing slot-based assignments with legacy map entries,
 * giving slot-based assignments priority when both exist for the same slot.
 */
export function mergeActionAndSlotAssignments(
  actionWorkflowMap: Record<string, { workflowPath: string; workflowName?: string | null }>,
  slotAssignments?: Record<string, WorkflowAssignment | undefined>,
): Record<string, WorkflowAssignment | undefined> {
  const merged: Record<string, WorkflowAssignment | undefined> = {
    ...(slotAssignments ?? {}),
  };

  // Convert each actionWorkflowMap entry into its canonical slot assignment.
  // Entries keyed by a real slot id (written by the Pipelines page) win over
  // legacy action-id entries for the same slot, whatever their insert order.
  const entries = Object.entries(actionWorkflowMap).sort(
    ([a], [b]) => Number(!getSlotById(a)) - Number(!getSlotById(b)),
  );
  for (const [actionId, entry] of entries) {
    if (!entry?.workflowPath) continue;
    const slotId = getSlotIdForAction(actionId);
    // Slot-based assignments take priority over legacy map entries
    if (!merged[slotId]?.workflowPath) {
      merged[slotId] = {
        workflowPath: entry.workflowPath,
        workflowName: entry.workflowName ?? null,
      };
    }
  }

  return merged;
}

/**
 * actionWorkflowMap keys that still route an action but have no row on the
 * Pipelines page (older per-action mappings, removed slots). Listed there so
 * they can be seen and cleared instead of applying invisibly.
 */
export function listUnslottedMappings(
  actionWorkflowMap: Record<string, { workflowPath: string; workflowName?: string | null } | undefined>,
): { key: string; workflowPath: string; workflowName: string | null }[] {
  return Object.entries(actionWorkflowMap)
    .filter(
      ([key, entry]) =>
        !!entry?.workflowPath && !getSlotById(getSlotIdForAction(key)),
    )
    .map(([key, entry]) => ({
      key,
      workflowPath: entry!.workflowPath,
      workflowName: entry!.workflowName ?? null,
    }));
}

/** Every actionWorkflowMap key that resolves to `slotId` (slot + legacy keys). */
export function mappingKeysForSlot(
  actionWorkflowMap: Record<string, unknown>,
  slotId: string,
): string[] {
  return Object.keys(actionWorkflowMap).filter(
    (key) => getSlotIdForAction(key) === slotId,
  );
}

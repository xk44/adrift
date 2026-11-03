/**
 * Auto-detail policy — content-aware parameterization of the adetailer
 * workflow (packs/krea2/adetailer.json).
 *
 * Probe: the source image is described by StyleVault's Qwen-VL captioner via
 * a structured instruction; the answer is parsed into an AutoDetailProbe.
 * Policy: deterministic mapping from probe → per-stage FaceDetailer
 * overrides ("<nodeId>.<input>" keys consumed by applyControlOverrides).
 *
 * Node ids are pinned to adetailer.json: 11 = face pass, 21 = hand pass.
 * A stage is "skipped" by making detection impossible (threshold 0.99 +
 * drop_size 8192) — FaceDetailer with zero detections is a pass-through, so
 * no graph surgery is needed.
 */

export const FACE_NODE = "11";
export const HAND_NODE = "21";

export interface AutoDetailProbe {
  people: number;
  shot: "closeup" | "medium" | "full" | "none";
  facesSharp: boolean;
  handsVisible: boolean;
  subject: string;
  style: "photo" | "illustration" | "painting" | "3d";
}

/** Instruction sent to the VL captioner (SV /caption/image `prompt` param). */
export const PROBE_INSTRUCTION = [
  "Analyze this image for a detail-enhancement pipeline.",
  "Answer with ONLY a JSON object, no prose, exactly these keys:",
  '{"people": <int>, "shot": "closeup"|"medium"|"full"|"none",',
  '"faces_sharp": <bool>, "hands_visible": <bool>,',
  '"subject": "<main subject, 3 words max>",',
  '"style": "photo"|"illustration"|"painting"|"3d"}',
  '"shot" is how large the nearest person appears: closeup (face fills much',
  "of the frame), medium (waist-up), full (whole body / person is small),",
  "none (no people).",
].join(" ");

/** Parse the captioner's reply; tolerate prose around the JSON. Null = unusable. */
export function parseProbeResponse(text: string): AutoDetailProbe | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const shot = String(raw.shot ?? "").toLowerCase();
  const style = String(raw.style ?? "").toLowerCase();
  const people = Number(raw.people);
  if (!["closeup", "medium", "full", "none"].includes(shot)) return null;
  return {
    people: Number.isFinite(people) ? Math.max(0, Math.round(people)) : 0,
    shot: shot as AutoDetailProbe["shot"],
    facesSharp: raw.faces_sharp === true || raw.faces_sharp === "true",
    handsVisible: raw.hands_visible === true || raw.hands_visible === "true",
    subject: String(raw.subject ?? "").slice(0, 80),
    style: (["photo", "illustration", "painting", "3d"].includes(style)
      ? style
      : "photo") as AutoDetailProbe["style"],
  };
}

const SKIP_STAGE = { bbox_threshold: 0.99, drop_size: 8192 };

/** Turbo-model guardrails: identity drifts above ~0.5, plastic below ~0.15. */
function clampDenoise(value: number): number {
  return Math.round(Math.max(0.15, Math.min(0.5, value)) * 100) / 100;
}

export interface AutoDetailPlan {
  /** applyControlOverrides-shaped map for adetailer.json */
  overrides: Record<string, unknown>;
  /** Human-readable decision trail, stored on the run for transparency. */
  summary: string;
  /** True when the whole-frame detail edit is a better tool than region work. */
  preferDetailEdit: boolean;
}

/**
 * Deterministic policy. `probe = null` (SV down / unparseable) falls back to
 * safe static defaults rather than blocking the action.
 */
export function buildAutoDetailPlan(
  probe: AutoDetailProbe | null,
): AutoDetailPlan {
  if (!probe) {
    return {
      overrides: {},
      summary: "probe unavailable — workflow defaults (face 0.38, hands 0.45)",
      preferDetailEdit: false,
    };
  }

  const notes: string[] = [
    `${probe.style}, shot=${probe.shot}, people=${probe.people}`,
  ];
  const overrides: Record<string, unknown> = {};

  if (probe.shot === "none") {
    // No people: YOLO face/hand passes are pointless; the edit LoRA is the
    // arbitrary-subject detailer.
    for (const [k, v] of Object.entries(SKIP_STAGE)) {
      overrides[`${FACE_NODE}.${k}`] = v;
      overrides[`${HAND_NODE}.${k}`] = v;
    }
    notes.push(
      `no people → whole-frame detail edit (subject: ${probe.subject})`,
    );
    return {
      overrides,
      summary: notes.join("; "),
      preferDetailEdit: true,
    };
  }

  // Face denoise by shot scale (smaller face in frame → regenerate more).
  let faceDenoise =
    probe.shot === "closeup" ? 0.3 : probe.shot === "medium" ? 0.38 : 0.45;
  let handDenoise = 0.45;

  if (probe.facesSharp) {
    faceDenoise -= 0.08;
    notes.push("faces already sharp → gentler face pass");
  }
  if (probe.style === "illustration" || probe.style === "painting") {
    faceDenoise -= 0.05;
    handDenoise -= 0.05;
    overrides[`${FACE_NODE}.feather`] = 12;
    overrides[`${HAND_NODE}.feather`] = 12;
    notes.push("stylized image → lower denoise, softer blend");
  }

  overrides[`${FACE_NODE}.denoise`] = clampDenoise(faceDenoise);

  if (probe.people >= 3) {
    // Crowds: refine prominent faces only; background dots drift badly.
    overrides[`${FACE_NODE}.bbox_threshold`] = 0.6;
    overrides[`${FACE_NODE}.drop_size`] = 24;
    notes.push("crowd → prominent faces only");
  }

  if (probe.handsVisible) {
    overrides[`${HAND_NODE}.denoise`] = clampDenoise(handDenoise);
  } else {
    for (const [k, v] of Object.entries(SKIP_STAGE)) {
      overrides[`${HAND_NODE}.${k}`] = v;
    }
    notes.push("no hands visible → hand pass skipped");
  }

  notes.push(
    `face ${overrides[`${FACE_NODE}.denoise`]}` +
      (probe.handsVisible
        ? `, hands ${overrides[`${HAND_NODE}.denoise`]}`
        : ""),
  );

  return { overrides, summary: notes.join("; "), preferDetailEdit: false };
}

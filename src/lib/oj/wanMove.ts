/**
 * "Trajectory motion" (packs/wan22/wan_move.json): Wan-Move 14B (Wan2.1 I2V
 * fine-tune) on core ComfyUI nodes, wired from the official
 * video_wanmove_480p template. Named presets (or a free drawing) are
 * turned into pixel track lists here and written as JSON into the string
 * node; WanMoveTracksFromCoords -> WanMoveTrackToVideo drags the image
 * content under each track's first point along its path.
 *
 * Tracks are a grid of points over a region (center by default, or a third
 * of the frame, or an explicit normalized box), moved by the preset's
 * displacement with ease-in-out timing. Points are clamped inside the frame.
 *
 * Free draw (params.draw, see ./wanMoveDraw.ts): user-drawn paths, each
 * moving a brushed / Smart-selected region (or a small cluster at the stroke
 * start), plus pins that hold points still. It replaces the named
 * trajectory + region when present.
 *
 * "fast" (default) = lightx2v I2V 480p distill LoRA, 6 steps CFG 1 (template);
 * "quality" drops the LoRA and samples 20 steps at CFG 6.
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  cloneWorkflow,
  comfyImageRefFromViewUrl,
  setNodeInput,
} from "./engine";
import { WAN_FPS, isQualityMode, wanDims, wanLength } from "./wanMotionPresets";
import { parseWanMoveDraw, wanMoveDrawTracks } from "./wanMoveDraw";

export const WAN_MOVE_ACTION = "wan_move";

export const WAN_MOVE_NODES = {
  photo: "1",
  unet: "2",
  lora: "3",
  shift: "4",
  pos: "6",
  neg: "7",
  coords: "11",
  tracks: "12",
  move: "13",
  sampler: "14",
  mux: "16",
} as const;
const N = WAN_MOVE_NODES;

const EXPECT: Record<string, string> = {
  [N.photo]: "LoadImage",
  [N.unet]: "UNETLoader",
  [N.lora]: "LoraLoaderModelOnly",
  [N.shift]: "ModelSamplingSD3",
  [N.pos]: "CLIPTextEncode",
  [N.neg]: "CLIPTextEncode",
  [N.coords]: "PrimitiveStringMultiline",
  [N.tracks]: "WanMoveTracksFromCoords",
  [N.move]: "WanMoveTrackToVideo",
  [N.sampler]: "KSampler",
  [N.mux]: "CreateVideo",
};

/** Normalized point (0-1 of width/height). */
type P = { x: number; y: number };

export interface WanMoveTrajectory {
  id: string;
  label: string;
  /** Motion prompt; {s} = subject. */
  prompt: string;
  /**
   * Position at time u (0..1, eased) of a point that starts at `p`, with `c`
   * the region center and `aspect` = width / height (for round rotation).
   */
  at: (p: P, c: P, u: number, aspect: number) => P;
}

const rotate = (p: P, c: P, a: number, aspect: number): P => {
  // Rotate in pixel-proportional space so circles stay round.
  const dx = (p.x - c.x) * aspect;
  const dy = p.y - c.y;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return {
    x: c.x + (dx * cos - dy * sin) / aspect,
    y: c.y + dx * sin + dy * cos,
  };
};

export const WAN_MOVE_TRAJECTORIES: WanMoveTrajectory[] = [
  {
    id: "slide_left",
    label: "Slide left",
    prompt: "{s} moves smoothly to the left across the frame.",
    at: (p, _c, u) => ({ x: p.x - 0.35 * u, y: p.y }),
  },
  {
    id: "slide_right",
    label: "Slide right",
    prompt: "{s} moves smoothly to the right across the frame.",
    at: (p, _c, u) => ({ x: p.x + 0.35 * u, y: p.y }),
  },
  {
    id: "arc_up",
    label: "Arc up",
    prompt: "{s} leaps up and to the right in a smooth arc.",
    // Quadratic bezier: up-right with a high control point.
    at: (p, _c, u) => ({
      x: p.x + 0.3 * u,
      y: p.y - 0.35 * (2 * u * (1 - u)) * 1.6 - 0.1 * u * u,
    }),
  },
  {
    id: "rise",
    label: "Rise up",
    prompt: "{s} rises straight up into the air.",
    at: (p, _c, u) => ({ x: p.x, y: p.y - 0.3 * u }),
  },
  {
    id: "drop",
    label: "Fall down",
    prompt: "{s} falls straight down.",
    at: (p, _c, u) => ({ x: p.x, y: p.y + 0.3 * u }),
  },
  {
    id: "swirl",
    label: "Swirl",
    prompt: "{s} spins around in a swirling circular motion.",
    at: (p, c, u, aspect) => rotate(p, c, Math.PI * 1.5 * u, aspect),
  },
  {
    id: "zoom_in",
    label: "Grow toward camera",
    prompt: "{s} moves toward the camera, growing larger in the frame.",
    at: (p, c, u) => ({
      x: c.x + (p.x - c.x) * (1 + 0.9 * u),
      y: c.y + (p.y - c.y) * (1 + 0.9 * u),
    }),
  },
  {
    id: "zoom_out",
    label: "Shrink away",
    prompt: "{s} moves away from the camera, getting smaller in the frame.",
    at: (p, c, u) => ({
      x: c.x + (p.x - c.x) * (1 - 0.5 * u),
      y: c.y + (p.y - c.y) * (1 - 0.5 * u),
    }),
  },
  {
    id: "apart",
    label: "Two points apart",
    prompt: "The two halves of {s} pull apart, moving away from each other.",
    at: (p, c, u) => ({ x: p.x + (p.x < c.x ? -0.22 : 0.22) * u, y: p.y }),
  },
  {
    id: "together",
    label: "Two points together",
    prompt: "{s} on both sides come together toward the middle.",
    at: (p, c, u) => ({ x: p.x + (c.x - p.x) * 0.8 * u, y: p.y }),
  },
];

export const DEFAULT_WAN_MOVE_TRAJECTORY = "slide_left";

export function getWanMoveTrajectory(id: unknown): WanMoveTrajectory {
  return (
    WAN_MOVE_TRAJECTORIES.find((t) => t.id === id) ??
    WAN_MOVE_TRAJECTORIES.find((t) => t.id === DEFAULT_WAN_MOVE_TRAJECTORY)!
  );
}

/** Region the tracks start in: [x0, y0, x1, y1], normalized. */
export const WAN_MOVE_REGIONS: Array<{
  id: string;
  label: string;
  box: [number, number, number, number];
}> = [
  { id: "center", label: "Center", box: [0.35, 0.3, 0.65, 0.7] },
  { id: "left", label: "Left side", box: [0.1, 0.3, 0.4, 0.7] },
  { id: "right", label: "Right side", box: [0.6, 0.3, 0.9, 0.7] },
  { id: "top", label: "Top", box: [0.3, 0.1, 0.7, 0.4] },
  { id: "bottom", label: "Bottom", box: [0.3, 0.6, 0.7, 0.9] },
];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Region box from an explicit `box` param (normalized), else a named region. */
export function wanMoveBox(
  region: unknown,
  box?: unknown,
): [number, number, number, number] {
  if (
    Array.isArray(box) &&
    box.length === 4 &&
    box.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    const [a, b, c, d] = box.map(clamp01) as number[];
    const x0 = Math.min(a, c);
    const x1 = Math.max(a, c);
    const y0 = Math.min(b, d);
    const y1 = Math.max(b, d);
    if (x1 - x0 >= 0.02 && y1 - y0 >= 0.02) return [x0, y0, x1, y1];
  }
  return (WAN_MOVE_REGIONS.find((r) => r.id === region) ?? WAN_MOVE_REGIONS[0])
    .box;
}

const GRID = 4;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Pixel tracks for `frames` frames at width x height: a GRID x GRID point
 * grid over `box`, each moved by the trajectory. Shape matches what
 * WanMoveTracksFromCoords parses: [[{x, y}, ...per frame], ...per track].
 */
export function wanMoveTracks(
  trajectory: WanMoveTrajectory,
  box: [number, number, number, number],
  width: number,
  height: number,
  frames: number,
): Array<Array<{ x: number; y: number }>> {
  const [x0, y0, x1, y1] = box;
  const c = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  const aspect = width / height;
  const tracks: Array<Array<{ x: number; y: number }>> = [];
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const p = {
        x: x0 + ((j + 0.5) / GRID) * (x1 - x0),
        y: y0 + ((i + 0.5) / GRID) * (y1 - y0),
      };
      const track: Array<{ x: number; y: number }> = [];
      for (let f = 0; f < frames; f++) {
        const u = ease(frames > 1 ? f / (frames - 1) : 0);
        const q = trajectory.at(p, c, u, aspect);
        track.push({
          x: Math.round(Math.min(width - 1, Math.max(0, q.x * width))),
          y: Math.round(Math.min(height - 1, Math.max(0, q.y * height))),
        });
      }
      tracks.push(track);
    }
  }
  return tracks;
}

/** Anchor grid pitch in pixels (6 latent cells) and the keep-out margin
 *  around moving content (fraction of width / height). */
export const WAN_MOVE_ANCHOR_SPACING = 48;
export const WAN_MOVE_ANCHOR_MARGIN = 0.12;

/**
 * Static background tracks. Without them Wan-Move tends to honour the
 * subject tracks with a camera pan: the whole frame slides along and the
 * subject never moves relative to the scene (measured: subject
 * band -216px, background -189px; with anchors background 0px, subject
 * -243px). A regular grid over the frame, minus every point inside a moving
 * group's per-frame bounding box grown by `margin`. The margin is generous
 * because the preset box is a guess at the subject: at 0.06 a fox wider than
 * the center box had its flank pinned and tore off; 0.12 kept it whole. `groups` = the tracks of
 * each rigidly moving thing (one group per preset / drawn path).
 */
export function wanMoveAnchorTracks(
  groups: Array<Array<Array<{ x: number; y: number }>>>,
  width: number,
  height: number,
  frames: number,
  spacing: number = WAN_MOVE_ANCHOR_SPACING,
  margin: number = WAN_MOVE_ANCHOR_MARGIN,
): Array<Array<{ x: number; y: number }>> {
  const mx = margin * width;
  const my = margin * height;
  const boxes: Array<[number, number, number, number]> = [];
  for (const g of groups) {
    const len = g[0]?.length ?? 0;
    for (let f = 0; f < len; f++) {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const t of g) {
        const p = t[f];
        if (!p) continue;
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y);
        y1 = Math.max(y1, p.y);
      }
      if (x0 <= x1) boxes.push([x0 - mx, y0 - my, x1 + mx, y1 + my]);
    }
  }
  const n = Math.max(1, frames);
  const out: Array<Array<{ x: number; y: number }>> = [];
  for (let y = spacing / 2; y < height; y += spacing) {
    for (let x = spacing / 2; x < width; x += spacing) {
      if (boxes.some(([a, b, c, d]) => x >= a && x <= c && y >= b && y <= d)) {
        continue;
      }
      const p = { x: Math.round(x), y: Math.round(y) };
      out.push(Array.from({ length: n }, () => ({ ...p })));
    }
  }
  return out;
}

export function wanMovePrompt(
  trajectory: WanMoveTrajectory,
  subject: unknown,
): string {
  const s =
    typeof subject === "string" && subject.trim()
      ? subject.trim().slice(0, 300)
      : "";
  const line = trajectory.prompt.replace(/\{s\}/g, s || "the subject");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** Motion prompt for a free drawing (the paths carry the actual motion). */
export function wanMoveDrawPrompt(subject: unknown, paths: number): string {
  const s =
    typeof subject === "string" && subject.trim()
      ? subject.trim().slice(0, 300)
      : "";
  const who = s ? s.charAt(0).toUpperCase() + s.slice(1) : "The subject";
  return paths > 1
    ? `${who} and the marked parts move smoothly along their paths; the rest of the scene stays natural.`
    : `${who} moves smoothly along its path; the rest of the scene stays natural.`;
}

/**
 * params: draw (free drawing, overrides trajectory/region), trajectory, region | box ([x0,y0,x1,y1] normalized), prompt
 * (subject), mode ("fast" | "quality"), duration ("5s" | "3s"), seed, anchor (false = no
 * static background tracks).
 */
export function buildWanMoveWorkflow(
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown> = {},
): { workflow: Workflow; slots: WorkflowSlots; seed: number } {
  const A = WAN_MOVE_ACTION;
  const workflow = cloneWorkflow(baseWorkflow);
  const photoRef = comfyImageRefFromViewUrl(
    sourceRun.jobs[sourceJobIndex]?.images?.[0],
  );
  if (!photoRef) throw new Error(`${A}: source run has no image`);
  for (const [id, cls] of Object.entries(EXPECT)) {
    if (workflow[id]?.class_type !== cls) {
      throw new Error(
        `${A}: workflow node ${id} should be ${cls} (graph out of sync)`,
      );
    }
  }

  const trajectory = getWanMoveTrajectory(params.trajectory);
  const dims = wanDims("480p", sourceRun.width, sourceRun.height);
  const frames = wanLength(params.duration);
  const draw = parseWanMoveDraw(params.draw);
  if (params.draw != null && !draw) {
    throw new Error(`${A}: the drawing has no usable path`);
  }
  const tracks = draw
    ? wanMoveDrawTracks(draw, dims.width, dims.height, frames)
    : wanMoveTracks(
        trajectory,
        wanMoveBox(params.region, params.box),
        dims.width,
        dims.height,
        frames,
      );
  // Pin the background unless asked not to. Drawn paths without a marked
  // region only move a small start cluster, so the object's real extent is
  // unknown and anchors could tear it: anchor only fully-seeded drawings.
  let groups: Array<typeof tracks> | null = null;
  if (!draw) groups = [tracks];
  else if (draw.paths.every((p) => p.seeds?.length)) {
    groups = [];
    let at = 0;
    for (const p of draw.paths) {
      groups.push(tracks.slice(at, at + p.seeds!.length));
      at += p.seeds!.length;
    }
  }
  if (groups && params.anchor !== false) {
    tracks.push(
      ...wanMoveAnchorTracks(groups, dims.width, dims.height, frames),
    );
  }

  setNodeInput(workflow, N.photo, "image", photoRef);
  setNodeInput(
    workflow,
    N.pos,
    "text",
    draw
      ? wanMoveDrawPrompt(params.prompt, draw.paths.length)
      : wanMovePrompt(trajectory, params.prompt),
  );
  setNodeInput(workflow, N.coords, "value", JSON.stringify(tracks));
  setNodeInput(workflow, N.move, "width", dims.width);
  setNodeInput(workflow, N.move, "height", dims.height);
  setNodeInput(workflow, N.move, "length", frames);
  setNodeInput(workflow, N.mux, "fps", WAN_FPS);

  const quality = isQualityMode(params.mode);
  if (quality) {
    setNodeInput(workflow, N.shift, "model", workflow[N.lora].inputs.model);
    delete workflow[N.lora];
  }
  const seed =
    typeof params.seed === "number" && Number.isFinite(params.seed)
      ? params.seed
      : Math.floor(Math.random() * 2 ** 32);
  setNodeInput(workflow, N.sampler, "seed", seed);
  setNodeInput(workflow, N.sampler, "steps", quality ? 20 : 6);
  setNodeInput(workflow, N.sampler, "cfg", quality ? 6 : 1);

  return {
    workflow,
    slots: {
      ksamplerId: N.sampler,
      posTextId: N.pos,
      posTextInputName: "text",
      negTextId: N.neg,
      latentDimsId: N.move,
      imageInputId: N.photo,
    },
    seed,
  };
}

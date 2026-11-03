/**
 * Open-weights camera move catalog: 100+ named, prompt-steered camera moves
 * for the Wan 2.2 (and LTX-2.5) text-steered video paths. No H3, no LoRA:
 * each move is a prompt fragment the base model follows on its own. Pure
 * data, no imports.
 *
 * Fragments use `{s}` for the subject and describe one continuous move in
 * plain cinematography language (direction + speed + what stays framed).
 * `seconds` is the recommended clip length: 3 for snaps / whips / crashes
 * that read best short, 5 for most moves, 8 for slow reveals and long
 * drone / orbit moves (the Wan path caps at 5 s; LTX-2.5 can run 8 s).
 * Names are this project's own wording, not any site's preset names.
 */

export type CameraMoveGroupId =
  | "push_pull"
  | "tracking"
  | "crane_jib"
  | "pan_tilt"
  | "orbit_arc"
  | "zoom_lens"
  | "handheld"
  | "aerial"
  | "pov_rig"
  | "speed_time"
  | "still_subtle";

export interface CameraMoveGroup {
  id: CameraMoveGroupId;
  label: string;
}

/** Picker order. */
export const CAMERA_MOVE_GROUPS: CameraMoveGroup[] = [
  { id: "push_pull", label: "Push & pull" },
  { id: "tracking", label: "Tracking & trucking" },
  { id: "crane_jib", label: "Crane & jib" },
  { id: "pan_tilt", label: "Pan, tilt & roll" },
  { id: "orbit_arc", label: "Orbit & arc" },
  { id: "zoom_lens", label: "Zoom & focus" },
  { id: "handheld", label: "Handheld" },
  { id: "aerial", label: "Drone & aerial" },
  { id: "pov_rig", label: "POV & rigs" },
  { id: "speed_time", label: "Speed & time" },
  { id: "still_subtle", label: "Still & subtle" },
];

export type CameraMoveSeconds = 3 | 5 | 8;

export interface CameraMove {
  /** Stable id (snake_case, unique in the catalog). */
  id: string;
  label: string;
  group: CameraMoveGroupId;
  /** Prompt fragment; `{s}` = subject. */
  prompt: string;
  /** Recommended clip length in seconds. */
  seconds: CameraMoveSeconds;
}

const g =
  (group: CameraMoveGroupId) =>
  (
    id: string,
    label: string,
    seconds: CameraMoveSeconds,
    prompt: string,
  ): CameraMove => ({ id, label, group, prompt, seconds });

const push = g("push_pull");
const track = g("tracking");
const crane = g("crane_jib");
const pan = g("pan_tilt");
const orbit = g("orbit_arc");
const zoom = g("zoom_lens");
const hand = g("handheld");
const air = g("aerial");
const pov = g("pov_rig");
const speed = g("speed_time");
const still = g("still_subtle");

export const CAMERA_MOVES: CameraMove[] = [
  // Push & pull
  push(
    "slow_push",
    "Slow push",
    5,
    "The camera dollies slowly and steadily forward toward {s} on a smooth track, the framing tightening from a medium shot to a close-up.",
  ),
  push(
    "creep_in",
    "Creeping push",
    8,
    "The camera creeps forward almost imperceptibly toward {s}, a slow tense dolly-in that gradually isolates {s} from the background.",
  ),
  push(
    "brisk_push",
    "Brisk push",
    3,
    "The camera dollies quickly forward toward {s}, a fast decisive push that ends tight on {s}.",
  ),
  push(
    "push_to_eyes",
    "Push to the eyes",
    5,
    "The camera pushes in steadily on the face of {s} until only the eyes fill the frame, an extreme close-up.",
  ),
  push(
    "push_low_up",
    "Low push, tilt up",
    5,
    "From a low angle the camera dollies forward toward {s} while tilting up, so {s} looms larger and more imposing.",
  ),
  push(
    "push_through_frame",
    "Push through foreground",
    5,
    "The camera dollies forward through a gap in the foreground, past out-of-focus leaves and edges, and settles on {s}.",
  ),
  push(
    "slow_pull",
    "Slow pull back",
    5,
    "The camera dollies slowly backward away from {s}, the framing widening from a close-up to a medium shot.",
  ),
  push(
    "pull_reveal",
    "Pull-back reveal",
    8,
    "The camera starts tight on {s} and dollies back in one long move, revealing the whole surrounding environment around {s}.",
  ),
  push(
    "pull_away_lonely",
    "Pull away, alone",
    8,
    "The camera slowly pulls away from {s} and keeps retreating, leaving {s} small and alone in a wide empty frame.",
  ),
  push(
    "brisk_pull",
    "Brisk pull out",
    3,
    "The camera dollies quickly backward away from {s}, a fast retreat that snaps the frame wide.",
  ),
  push(
    "push_then_hold",
    "Push and settle",
    5,
    "The camera dollies forward toward {s}, eases to a stop and holds steady on a clean close-up of {s}.",
  ),

  // Tracking & trucking
  track(
    "truck_left",
    "Side slide left",
    5,
    "The camera trucks sideways to the left on a smooth slider, keeping {s} in frame as the background slides past with parallax.",
  ),
  track(
    "truck_right",
    "Side slide right",
    5,
    "The camera trucks sideways to the right on a smooth slider, keeping {s} in frame as the background slides past with parallax.",
  ),
  track(
    "lead_track",
    "Lead track",
    5,
    "The camera moves backward ahead of {s} as {s} walks toward it, a steady leading tracking shot that keeps {s} centered.",
  ),
  track(
    "follow_behind",
    "Follow from behind",
    5,
    "The camera follows close behind {s} at shoulder height as {s} moves forward, tracking smoothly through the space.",
  ),
  track(
    "profile_track",
    "Profile track",
    5,
    "The camera tracks alongside {s} in profile, matching the pace of {s} as the background streams past.",
  ),
  track(
    "glide_rig",
    "Stabilized glide",
    5,
    "A smooth stabilized glide follows {s} through the scene, floating and weightless with no shake.",
  ),
  track(
    "low_track",
    "Ground-level track",
    5,
    "The camera skims along just above the ground beside {s}, a low tracking shot with the floor rushing past in the foreground.",
  ),
  track(
    "overtake",
    "Overtake pass",
    5,
    "The camera tracks from behind {s}, speeds up, passes alongside and ends ahead of {s} looking back at the face.",
  ),
  track(
    "parallax_pillars",
    "Parallax past pillars",
    5,
    "The camera slides sideways past foreground pillars and objects that wipe across the frame while {s} stays steady in the background.",
  ),
  track(
    "track_in_arc",
    "Curved track",
    5,
    "The camera tracks forward with {s} along a gentle curve, slowly swinging from the side of {s} to the front.",
  ),

  // Crane & jib
  crane(
    "jib_rise",
    "Jib rise",
    5,
    "The camera rises smoothly on a jib arm from eye level to high above {s}, ending on a high angle looking down.",
  ),
  crane(
    "jib_lower",
    "Jib lower",
    5,
    "The camera lowers smoothly on a jib arm from high above down to eye level with {s}.",
  ),
  crane(
    "crane_up_reveal",
    "Rising reveal",
    8,
    "The camera cranes up and back from {s}, rising high to reveal the full landscape and the scale of the place around {s}.",
  ),
  crane(
    "crane_down_arrive",
    "Descend to subject",
    8,
    "The camera starts high over the wide scene and cranes down and in, landing on a medium shot of {s}.",
  ),
  crane(
    "pedestal_up",
    "Straight rise",
    5,
    "The camera rises straight up vertically without tilting, {s} sliding down and out of the bottom of the frame.",
  ),
  crane(
    "pedestal_down",
    "Straight drop",
    5,
    "The camera lowers straight down vertically without tilting, {s} rising into frame from below.",
  ),
  crane(
    "crane_swing",
    "Jib swing",
    5,
    "The camera swings in a wide sideways arc on a crane arm over {s}, sweeping across the scene from left to right.",
  ),
  crane(
    "overhead_ascend",
    "Overhead ascend",
    8,
    "Looking straight down at {s} from directly above, the camera rises steadily so {s} shrinks into a small figure in the pattern of the ground.",
  ),
  crane(
    "boom_over_wall",
    "Rise over the wall",
    5,
    "The camera rises up from behind a wall or obstacle in the foreground, clearing it to reveal {s} beyond.",
  ),
  crane(
    "crane_tilt_down",
    "Crane down, tilt down",
    5,
    "The camera rises above {s} while tilting down, keeping {s} centered as the view becomes a steep top-down angle.",
  ),

  // Pan, tilt & roll
  pan(
    "pan_left_slow",
    "Slow pan left",
    5,
    "The camera stays in place and pans slowly to the left across the scene, ending on {s}.",
  ),
  pan(
    "pan_right_slow",
    "Slow pan right",
    5,
    "The camera stays in place and pans slowly to the right across the scene, ending on {s}.",
  ),
  pan(
    "whip_left",
    "Whip left",
    3,
    "The camera whips rapidly to the left in a blurred motion-smeared pan, snapping to a stop on {s}.",
  ),
  pan(
    "whip_right",
    "Whip right",
    3,
    "The camera whips rapidly to the right in a blurred motion-smeared pan, snapping to a stop on {s}.",
  ),
  pan(
    "tilt_up_reveal",
    "Tilt up reveal",
    5,
    "The camera starts on the ground at the feet of {s} and tilts slowly upward, revealing {s} from bottom to top.",
  ),
  pan(
    "tilt_down_reveal",
    "Tilt down reveal",
    5,
    "The camera starts on the sky above and tilts slowly downward to reveal {s} below.",
  ),
  pan(
    "follow_pan",
    "Follow pan",
    5,
    "The camera stays on a fixed tripod and pans smoothly to follow {s} as {s} moves across the frame.",
  ),
  pan(
    "survey_pan",
    "Survey pan",
    8,
    "A slow wide panoramic pan sweeps across the whole landscape, passing over {s} in the middle of the scene.",
  ),
  pan(
    "dutch_roll",
    "Lean into tilt",
    5,
    "The camera slowly rolls into a canted Dutch angle while framing {s}, the horizon tipping off level for unease.",
  ),
  pan(
    "barrel_roll",
    "Full barrel roll",
    5,
    "The camera rolls a full 360 degrees around its lens axis while facing {s}, the whole world turning upside down and back.",
  ),
  pan(
    "whip_tilt_up",
    "Whip tilt up",
    3,
    "The camera whips upward in a fast blurred tilt, snapping to a stop on {s} above.",
  ),

  // Orbit & arc
  orbit(
    "orbit_left_slow",
    "Slow orbit left",
    8,
    "The camera orbits slowly counterclockwise around {s}, keeping {s} centered as the background rotates behind.",
  ),
  orbit(
    "orbit_right_slow",
    "Slow orbit right",
    8,
    "The camera orbits slowly clockwise around {s}, keeping {s} centered as the background rotates behind.",
  ),
  orbit(
    "orbit_fast",
    "Fast orbit",
    5,
    "The camera circles quickly around {s} in a full fast orbit, the background streaking with motion blur while {s} stays sharp in the center.",
  ),
  orbit(
    "half_arc_left",
    "Half arc left",
    5,
    "The camera arcs halfway around {s} to the left, moving from a front view to a side profile of {s}.",
  ),
  orbit(
    "half_arc_right",
    "Half arc right",
    5,
    "The camera arcs halfway around {s} to the right, moving from a front view to a side profile of {s}.",
  ),
  orbit(
    "hero_orbit",
    "Low hero orbit",
    5,
    "From a low angle the camera circles around {s}, looking up so {s} stands tall and heroic against the sky.",
  ),
  orbit(
    "high_orbit",
    "High overhead orbit",
    8,
    "From high above the camera circles around {s}, looking down at a steep angle as the ground rotates below.",
  ),
  orbit(
    "spiral_rise",
    "Spiral up",
    8,
    "The camera spirals upward around {s}, circling and rising at the same time to end high above {s}.",
  ),
  orbit(
    "spiral_descend",
    "Spiral down",
    8,
    "The camera spirals downward around {s}, circling and descending from high above to eye level.",
  ),
  orbit(
    "orbit_push",
    "Orbit and close in",
    5,
    "The camera circles around {s} while pushing closer, ending on a tight close-up of {s} from the side.",
  ),
  orbit(
    "arc_reveal_face",
    "Arc to the face",
    5,
    "The camera starts behind {s} and arcs around the shoulder to reveal the face of {s}.",
  ),
  orbit(
    "pendulum_arc",
    "Pendulum arc",
    5,
    "The camera swings in a short arc around {s} to one side, then eases back the other way like a pendulum.",
  ),

  // Zoom & focus
  zoom(
    "snap_zoom_in",
    "Snap zoom in",
    3,
    "The camera snaps into a sudden fast zoom straight onto {s}, an abrupt punch-in.",
  ),
  zoom(
    "snap_zoom_out",
    "Snap zoom out",
    3,
    "The camera snaps into a sudden fast zoom out from {s}, the frame jumping wide in an instant.",
  ),
  zoom(
    "stutter_zoom",
    "Triple punch-in",
    3,
    "Three quick successive zoom jumps punch in closer and closer on {s}, each one a hard step.",
  ),
  zoom(
    "creep_zoom_in",
    "Long lens creep in",
    8,
    "A slow optical zoom-in on a long lens tightens on {s}, the background compressed and flat.",
  ),
  zoom(
    "creep_zoom_out",
    "Long lens creep out",
    8,
    "A slow optical zoom-out on a long lens widens from {s}, revealing more of the compressed background.",
  ),
  zoom(
    "vertigo_in",
    "Vertigo push",
    5,
    "The camera dollies in toward {s} while zooming out, so {s} stays the same size while the background stretches away, a disorienting vertigo effect.",
  ),
  zoom(
    "vertigo_out",
    "Vertigo pull",
    5,
    "The camera dollies away from {s} while zooming in, so {s} stays the same size while the background swells closer, a disorienting vertigo effect.",
  ),
  zoom(
    "rack_to_back",
    "Focus to background",
    5,
    "The camera holds still as the focus racks from {s} in the foreground to the background, {s} melting into soft blur.",
  ),
  zoom(
    "rack_to_front",
    "Focus to foreground",
    5,
    "The camera holds still as the focus racks from the blurry background onto {s} in the foreground, {s} snapping sharp.",
  ),
  zoom(
    "blur_to_sharp",
    "Out of the blur",
    5,
    "The shot opens completely out of focus and slowly pulls into sharp focus on {s}.",
  ),
  zoom(
    "zoom_push_combo",
    "Zoom and drift",
    5,
    "The camera slowly zooms in on {s} while drifting gently sideways, a layered cinematic move.",
  ),
  zoom(
    "shallow_rack_pair",
    "Rack between two",
    5,
    "The focus shifts from an object in the foreground to {s} behind it, then settles on {s} with a shallow depth of field.",
  ),

  // Handheld
  hand(
    "handheld_subtle",
    "Light handheld",
    5,
    "Gentle handheld camera on {s}, a subtle natural sway and breathing in the frame.",
  ),
  hand(
    "handheld_doc",
    "Documentary handheld",
    5,
    "Observational documentary handheld camera following {s}, small reframes and natural bumps as the operator keeps up.",
  ),
  hand(
    "run_and_gun",
    "Run and gun",
    5,
    "Energetic handheld camera running after {s}, bouncing with each step and quickly reframing to keep {s} in shot.",
  ),
  hand(
    "panic_cam",
    "Panic cam",
    3,
    "Frantic violently shaking handheld camera on {s}, jerky whip reframes and motion blur like a chaotic emergency.",
  ),
  hand(
    "over_shoulder",
    "Over-the-shoulder follow",
    5,
    "Handheld over-the-shoulder shot behind {s}, the shoulder of {s} soft in the foreground as the camera follows.",
  ),
  hand(
    "selfie_vlog",
    "Arm's-length selfie",
    5,
    "Arm's-length selfie phone camera held by {s}, bobbing slightly as {s} talks and walks.",
  ),
  hand(
    "body_mount",
    "Chest rig",
    5,
    "A camera rigged to the body of {s} faces {s} at a fixed distance, {s} stays locked in the center while the world behind lurches and sways.",
  ),
  hand(
    "found_footage",
    "Found footage",
    5,
    "Shaky amateur camcorder footage of {s}, unsteady framing, quick pans and accidental tilts.",
  ),
  hand(
    "handheld_push",
    "Handheld push",
    3,
    "The handheld camera steps quickly forward toward {s}, the frame bobbing as it closes in.",
  ),
  hand(
    "shoulder_cam_walk",
    "Shoulder cam walk",
    5,
    "Shoulder-mounted camera walking beside {s}, a steady rhythmic sway with each footstep.",
  ),

  // Drone & aerial
  air(
    "fpv_dive",
    "FPV dive",
    5,
    "An FPV drone dives steeply from high above straight down toward {s}, pulling out of the dive at the last moment to skim past.",
  ),
  air(
    "fpv_threadthrough",
    "FPV thread-through",
    5,
    "An FPV drone flies fast and low through a narrow gap, banking hard and racing past {s}.",
  ),
  air(
    "drone_rise",
    "Drone lift-off reveal",
    8,
    "The drone rises vertically from ground level beside {s}, climbing high to reveal the wide landscape.",
  ),
  air(
    "drone_pullaway",
    "Drone fly-away",
    8,
    "The drone flies backward and upward away from {s}, {s} shrinking to a tiny point in the vast scene.",
  ),
  air(
    "drone_orbit",
    "Drone circle",
    8,
    "Aerial drone shot circling slowly around {s} from high up, the landscape turning below.",
  ),
  air(
    "top_down_flyover",
    "Top-down flyover",
    5,
    "Straight-down aerial view flying steadily over {s}, the ground pattern scrolling beneath.",
  ),
  air(
    "drone_chase",
    "Aerial chase",
    5,
    "An aerial drone tracks fast behind and above {s} as {s} moves across the landscape.",
  ),
  air(
    "cliff_reveal",
    "Over-the-edge reveal",
    5,
    "The drone flies forward over a cliff edge or rooftop edge, the ground dropping away to reveal {s} far below.",
  ),
  air(
    "water_skim",
    "Low skim",
    5,
    "The drone skims fast and low over the water surface toward {s}, spray and reflections rushing below.",
  ),
  air(
    "drone_approach",
    "Drone approach",
    8,
    "Aerial shot flying in from far away toward {s}, descending and slowing as it arrives.",
  ),
  air(
    "fpv_tunnel",
    "FPV corridor run",
    5,
    "An FPV drone races through a long corridor or tunnel, weaving around obstacles and bursting out toward {s}.",
  ),
  air(
    "drone_tilt_reveal",
    "Drone tilt reveal",
    5,
    "The drone hovers looking straight down, then tilts up to the horizon revealing {s} in the wide view.",
  ),

  // POV & rigs
  pov(
    "pov_walk",
    "First-person walk",
    5,
    "First-person point of view walking toward {s}, the view gently bobbing with each step.",
  ),
  pov(
    "keyhole_push",
    "Through the opening",
    5,
    "The camera pushes through a small opening, a window or a doorway, and emerges into the room with {s}.",
  ),
  pov(
    "hood_mount",
    "Hood mount",
    5,
    "Camera mounted on the front of a moving vehicle racing forward toward {s}, the road rushing beneath.",
  ),
  pov(
    "side_mount",
    "Side mount",
    5,
    "Camera rigged to the side of a moving vehicle, the background streaking past while {s} stays steady in frame.",
  ),
  pov(
    "worm_eye_rise",
    "Worm's-eye pass",
    5,
    "The camera sits at ground level looking up as {s} passes over, a dramatic worm's-eye angle against the sky.",
  ),
  pov(
    "flip_upside",
    "Upside-down flip",
    5,
    "The camera starts upside down and flips around to right itself, settling on {s}.",
  ),
  pov(
    "macro_slide",
    "Macro slide",
    5,
    "An extreme macro lens slides slowly across tiny surface details of {s}, very shallow focus.",
  ),
  pov(
    "mirror_reveal",
    "Mirror reveal",
    5,
    "The camera moves past a mirror, the reflection of {s} first, then the real {s} comes into view.",
  ),
  pov(
    "zipline",
    "Cable cam",
    5,
    "A cable-suspended camera glides fast in a straight line high over the scene, passing over {s}.",
  ),
  pov(
    "periscope_rise",
    "Periscope rise",
    5,
    "The camera rises from below the edge of a table or ledge, peeking up to discover {s}.",
  ),

  // Speed & time
  speed(
    "frozen_sweep",
    "Frozen-moment sweep",
    5,
    "Time stops: {s} hangs frozen mid-action while the camera sweeps in an arc around {s}, dust and droplets suspended in the air.",
  ),
  speed(
    "ramp_push",
    "Speed-ramp push",
    3,
    "The camera rushes forward toward {s}, then slows to dramatic slow motion right at {s}.",
  ),
  speed(
    "hyperlapse_forward",
    "Hyperlapse march",
    5,
    "A hyperlapse moving forward through the scene toward {s}, the surroundings and people blurring in fast time.",
  ),
  speed(
    "timelapse_hold",
    "Timelapse hold",
    5,
    "A locked-off timelapse of {s}, clouds racing, shadows sweeping and light changing fast while {s} stays still.",
  ),
  speed(
    "slowmo_drift",
    "Slow-motion drift",
    5,
    "Slow-motion footage of {s}, the camera drifting gently forward as every movement unfolds at a fraction of real speed.",
  ),
  speed(
    "smash_in",
    "Smash-in",
    3,
    "The camera slams forward toward {s} in a hard fast rush, stopping abruptly with a jolt.",
  ),
  speed(
    "spin_out",
    "Spin-out transition",
    3,
    "The camera spins rapidly around its own axis while pulling back from {s}, a blurred whirl.",
  ),
  speed(
    "impact_shake",
    "Impact shake",
    3,
    "The camera holds on {s} and jolts with a sudden heavy impact shake, then settles.",
  ),
  speed(
    "rewind_pull",
    "Rewind pull",
    3,
    "The camera rushes backward away from {s} in a fast reverse, everything moving as if rewinding.",
  ),

  // Still & subtle
  still(
    "locked_off",
    "Locked-off frame",
    5,
    "Static locked-off camera on a tripod, no camera movement at all, only {s} moves.",
  ),
  still(
    "gentle_drift",
    "Gentle drift",
    5,
    "The camera drifts very slowly sideways past {s}, barely moving, calm and contemplative.",
  ),
  still(
    "micro_push",
    "Micro push",
    5,
    "An almost invisible slow push toward {s}, the frame tightening by only a small amount.",
  ),
  still(
    "float_hover",
    "Hover float",
    5,
    "The camera hovers in front of {s} with a soft floating motion, as if suspended in air.",
  ),
  still(
    "breathing_frame",
    "Breathing frame",
    5,
    "The framing on {s} gently swells in and out like slow breathing, a subtle living camera.",
  ),
  still(
    "rise_settle",
    "Lift and settle",
    5,
    "The camera lifts slightly upward in front of {s}, then settles into a still composed frame.",
  ),
];

export function getCameraMove(id: unknown): CameraMove | undefined {
  const key = typeof id === "string" ? id.trim() : "";
  return CAMERA_MOVES.find((m) => m.id === key);
}

export function cameraMoveGroupLabel(id: CameraMoveGroupId): string {
  return CAMERA_MOVE_GROUPS.find((x) => x.id === id)?.label ?? id;
}

/**
 * Fragment with the subject slotted in (sentence-initial slots capitalized).
 * Empty subject → "the main subject".
 */
export function cameraMovePrompt(move: CameraMove, subject?: unknown): string {
  const raw =
    typeof subject === "string" ? subject.trim().replace(/[.\s]+$/, "") : "";
  const s = raw || "the main subject";
  return move.prompt.replace(/\{s\}/g, (_m, offset: number) =>
    /(^|[.!?:]\s+)$/.test(move.prompt.slice(0, offset))
      ? s[0].toUpperCase() + s.slice(1)
      : s,
  );
}

/**
 * Appends a move to a free prompt (for prompt-steered engines whose text box
 * is the scene, e.g. LTX-2.5 Animate). Unknown id → prompt unchanged.
 */
export function withCameraMove(
  prompt: string,
  moveId: unknown,
  subject?: unknown,
): string {
  const move = getCameraMove(moveId);
  const base = prompt.trim();
  if (!move) return base;
  const frag = cameraMovePrompt(move, subject);
  if (!base) return frag;
  return `${/[.!?]$/.test(base) ? base : `${base}.`} ${frag}`;
}

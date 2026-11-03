/**
 * LTX-2.5 engine for Motion presets (wan_motion card) that LTX-2.5 can do
 * from the prompt alone.
 *
 * The presets below are camera moves (crane, orbit, drone/racing-drone,
 * crash zoom, dolly zoom) and VFX / atmospheric effects (fire, explosions,
 * disintegration, levitation, storms) whose look depends on things Wan 2.2
 * I2V does not do: a sound hit synced to the visual beat (LTX-2.5 renders
 * audio in the same pass) or a long, steady move (LTX-2.5 runs 24 fps up to
 * 10 s; Wan is 16 fps, capped at 5 s). Some are LoRA presets on Wan; on LTX
 * they run LoRA-free from their own template. With engine "ltx25" the
 * preset compiles to an ltx25_animate request: the preset's LTX template
 * with the subject slotted in, a sound line, and the recommended length.
 * Every other preset (and the default engine) stays on the Wan path.
 */
import { LTX25_ANIMATE_ACTION, LTX25_PACK_ID } from "./ltx25";
import {
  getWanMotionPreset,
  wanMotionPrompt,
  type WanMotionPreset,
} from "./wanMotionPresets";

export type WanMotionEngine = "wan22" | "ltx25";
export const WAN_MOTION_ENGINE_DEFAULT: WanMotionEngine = "wan22";

export interface LtxEffectFit {
  /** Recommended clip length in seconds (24 fps, snapped to 8n+1 later). */
  seconds: number;
  /**
   * LTX-2.5 prompt, one paragraph per the LTX prompt guide: subject action
   * first, then the camera move, then lighting. `{s}` = subject. Replaces
   * the Wan preset prompt (no LoRA trigger words on LTX).
   */
  template: string;
  /** Sound line appended to the preset prompt (LTX-2.5 renders audio). */
  sound: string;
  /** Why LTX-2.5 suits this effect better than Wan 2.2. */
  why: string;
}

const ltxFit = (
  seconds: number,
  template: string,
  sound: string,
  why: string,
): LtxEffectFit => ({ seconds, template, sound, why });

export const LTX_EFFECT_FITS: Record<string, LtxEffectFit> = {
  // Synced-sound effects and long moves
  impact_punch: ltxFit(
    5,
    "{s} winds up and throws a powerful punch straight at the camera in slow motion, the fist stopping just short of the lens as a ring-shaped shockwave ripples through the air and dust blasts outward. The camera holds a low medium shot and shakes hard on the impact. Hard rim light from behind, the flying dust catching the light.",
    "Sound: a heavy whoosh as the fist swings, then a deep bass thump and rumble exactly when the shockwave hits.",
    "The gag lands on the impact; LTX-2.5 syncs the thump to the shockwave.",
  ),
  blast_reveal: ltxFit(
    6,
    "A bright explosion of colored smoke and sparks fills the whole frame, then the cloud rolls away and clears to reveal {s} standing in the center in a confident pose as glowing embers drift down. The camera stays locked off at eye level, then pushes in slightly as the smoke clears. Warm backlight glows through the smoke with a cool fill light on {s}.",
    "Sound: a loud boom and crackling sparks as the smoke bursts, then a low rumble fading to quiet as the cloud clears.",
    "Explosion plus clear-out needs more than 5 s and a synced boom.",
  ),
  eye_dive: ltxFit(
    8,
    "{s} holds perfectly still, eyes wide open. The camera pushes in slowly toward the eye of {s}, then dives straight into the dark pupil and through it in one continuous move, emerging into a vast glowing galaxy of stars and nebula clouds. A soft catchlight in the eye gives way to deep blue and violet starlight.",
    "Sound: a soft rising whoosh as the camera dives into the pupil, swelling into a deep ambient space hum.",
    "One continuous push-through; 8 s at 24 fps keeps the move steady.",
  ),
  planet_zoom_out: ltxFit(
    10,
    "{s} stands still and looks up. The camera starts close on {s} and pulls straight up and away in one continuous move, rising over the rooftops, through the clouds and out into space until the whole planet is visible. Warm daylight at street level fades into the black of space, the planet lit along its curved edge by bright sunlight.",
    "Sound: wind rushing past as the camera climbs, fading into the quiet of space with a low ambient drone.",
    "Ground-to-orbit pull-out is the longest single camera move; 10 s fits it.",
  ),
  spiral_zoom: ltxFit(
    5,
    "{s} holds a steady pose. The camera spins in a fast continuous corkscrew roll while pushing in toward {s}, the background twisting into a dizzying spiral blur, then the rotation snaps to a stop on a sharp, level close-up of {s}. Bright, punchy light with strong contrast.",
    "Sound: a fast swirling whoosh that cuts off with a sharp snap when the rotation stops.",
    "Fast corkscrew smears at 16 fps; 24 fps plus the snap sound sell the stop.",
  ),
  building_blast: ltxFit(
    6,
    "{s} walks calmly toward the camera as the building behind erupts in a huge fireball, debris and smoke billowing outward, and {s} never looks back. The camera tracks slowly backward ahead of {s} at chest height. The orange blast light silhouettes {s} and flickers across the ground.",
    "Sound: a huge explosion boom with debris crashing down and a long rumble behind calm footsteps.",
    "The walk-away beat is the boom behind the subject; LTX-2.5 renders it.",
  ),
  fireworks: ltxFit(
    8,
    "{s} looks up in wonder as colorful fireworks burst in the night sky behind, sparks raining down. The camera slowly cranes up from a medium shot to frame {s} against the sky. Each burst throws warm red, gold and green flashes across {s}.",
    "Sound: whistling launches and booming, crackling bursts timed with each firework.",
    "Each burst pairs with a boom; longer clip shows several bursts.",
  ),
  thunder_strike: ltxFit(
    5,
    "{s} stands firm as dark storm clouds gather above, bolts of lightning strike down all around and blue electric arcs crackle across {s}. The camera holds a low angle and jolts slightly with each strike. Cold blue flashes light {s} in stark bursts against the dark sky.",
    "Sound: a sharp crack of thunder exactly as the lightning flashes, then a rolling rumble.",
    "Lightning without the synced thunder crack falls flat.",
  ),

  // Camera moves (LoRA moves on Wan; prompt-only on LTX-2.5)
  orbit_360: ltxFit(
    8,
    "{s} stays in place, breathing and blinking naturally, while the camera performs a smooth 360-degree orbit, circling all the way around {s} and returning to the front view. The surroundings sweep past behind {s} with steady parallax. Soft, even key light with natural shadows that shift as the camera circles.",
    "Sound: a calm ambient bed of the surroundings with a soft whoosh as the camera passes behind.",
    "A full orbit wants a long, steady move; LTX-2.5 runs 8 s at 24 fps with no LoRA.",
  ),
  arc_shot: ltxFit(
    5,
    "{s} turns slightly toward the lens as the camera moves in a smooth half-circle arc around {s}, shifting the view from the side to the front. Golden-hour side light rakes across {s}, the background drifting softly out of focus.",
    "Sound: soft ambient room tone under a gentle cinematic swell.",
    "Smooth arc parallax holds up better at 24 fps.",
  ),
  crash_zoom_in: ltxFit(
    3,
    "{s} suddenly looks straight at the lens as the camera crash-zooms in, rushing from a wide shot to a tight close-up in a split second. Hard, high-contrast light with a slight motion smear on the zoom.",
    "Sound: a sharp whoosh rising into a hard snap as the zoom lands.",
    "The snap sound lands the zoom; prompt-only on LTX-2.5.",
  ),
  crash_zoom_out: ltxFit(
    3,
    "{s} freezes in surprise as the camera crash-zooms out from a tight close-up to a wide shot in a split second, revealing the whole scene around {s}. Bright natural light with a slight motion smear on the zoom.",
    "Sound: a reverse whoosh pulling away, ending on a comic beat of quiet room tone.",
    "The reverse whoosh plus a beat of silence is the joke.",
  ),
  dolly_zoom: ltxFit(
    5,
    "{s} stands frozen in sudden realization as the camera dollies back while zooming in, keeping {s} the same size while the background stretches and warps behind. Moody low-key light with a cold edge light on {s}.",
    "Sound: a low tense drone swelling under a rising heartbeat thump.",
    "The vertigo warp needs clean parallax; 24 fps keeps it smooth.",
  ),
  crane_up: ltxFit(
    8,
    "{s} stands still and looks out over the scene as the camera cranes up smoothly from eye level, rising high above and revealing the surroundings around {s}. Late-afternoon sunlight with long, soft shadows stretching across the ground.",
    "Sound: wind and distant ambient sounds opening up as the camera rises, with a soft orchestral swell.",
    "Long rising reveal; 8 s with the sound opening up as it climbs.",
  ),
  crane_down: ltxFit(
    8,
    "{s} waits in the center of the scene as the camera starts high above and slowly cranes down, settling on a medium shot of {s}. Soft overcast light, the wide scene narrowing to {s}.",
    "Sound: a wide ambient atmosphere narrowing to close, intimate sounds as the camera lands.",
    "Long descending move; the sound narrows with the framing.",
  ),
  bullet_time: ltxFit(
    5,
    "{s} hangs frozen mid-action, hair and loose fabric suspended, dust and droplets hanging in the air, while the camera sweeps in a smooth arc around {s}. Crisp high-contrast light with bright rim highlights on the suspended particles.",
    "Sound: a deep slowed-down whoosh over a low sustained hum, everything else muffled.",
    "The slowed whoosh sells frozen time; prompt-only on LTX-2.5.",
  ),
  car_chase: ltxFit(
    6,
    "Cars race around {s} in a dramatic night chase, tires smoking and headlights blazing as they swerve past. The camera tracks alongside the action at bumper height, whipping to follow each car. Streaking headlights and red taillights glow on wet, reflective asphalt.",
    "Sound: roaring engines, screeching tires and a passing horn fading into the distance.",
    "A chase without engine roar is silent film; LTX-2.5 renders both.",
  ),
  cam_pull_reveal: ltxFit(
    8,
    "{s} stands still in the center of the frame as the camera starts tight and dollies back in one long, smooth move, revealing the whole environment around {s}. Soft natural light, the wider scene opening up with depth and haze.",
    "Sound: close, quiet room tone opening into the wide ambient sound of the place.",
    "Long reveal; 8 s at 24 fps on LTX-2.5 (Wan caps at 5 s).",
  ),
  cam_hero_orbit: ltxFit(
    5,
    "{s} stands tall in a confident pose as the camera circles around from a low angle, looking up so {s} towers against the sky. Strong backlight puts a bright rim around {s} and a lens flare passes as the sun goes behind.",
    "Sound: a rising heroic orchestral swell with wind rushing past.",
    "The hero beat is half score; LTX-2.5 adds it in the same pass.",
  ),
  cam_spiral_rise: ltxFit(
    8,
    "{s} looks up as the camera spirals upward around {s}, circling and rising at the same time to end high above, looking down. Soft daylight with shadows rotating across the ground.",
    "Sound: wind building as the camera climbs over a soaring ambient pad.",
    "Combined orbit and climb needs the 8 s length.",
  ),
  cam_fpv_dive: ltxFit(
    5,
    "{s} stands far below as a racing drone camera dives steeply from high above straight toward {s}, pulling out of the dive at the last moment to skim past. Bright midday sun with motion blur streaking across the ground.",
    "Sound: a high-pitched drone motor whine and rushing wind that peak as it skims past.",
    "Fast drone moves smear at 16 fps; 24 fps and the motor whine sell it.",
  ),
  cam_fpv_threadthrough: ltxFit(
    5,
    "{s} stands in the scene as a racing drone camera flies fast and low through a narrow gap, banking hard and racing past {s}. Dappled light flickers through the gap, with motion blur on the edges of the frame.",
    "Sound: a buzzing drone motor and a sharp whoosh as it threads the gap.",
    "Fast banking move needs 24 fps; the whoosh marks the gap.",
  ),
  cam_fpv_tunnel: ltxFit(
    5,
    "{s} waits at the far end as a racing drone camera races through a long corridor, weaving around obstacles and bursting out toward {s}. The dark corridor is lit by passing lights, then bright daylight floods in at the exit.",
    "Sound: an echoing motor whine in the corridor that opens up into open air at the exit.",
    "The echo-to-open-air change is a sound beat Wan can't add.",
  ),
  cam_drone_rise: ltxFit(
    8,
    "{s} stands on the ground as the drone camera rises vertically beside {s}, climbing high to reveal the wide landscape. Golden-hour sunlight sweeps across the land with long shadows.",
    "Sound: wind growing stronger with altitude over a soft ambient score.",
    "Slow aerial reveal; 8 s on LTX-2.5.",
  ),
  cam_drone_pullaway: ltxFit(
    8,
    "{s} stands still as the drone camera flies backward and upward away, {s} shrinking to a tiny point in the vast scene. Soft hazy light with atmospheric depth fading into the distance.",
    "Sound: close ambient sound fading into wide open wind and a lonely sustained tone.",
    "The fly-away needs the long take and the fading sound.",
  ),
  cam_cliff_reveal: ltxFit(
    5,
    "{s} stands small in the landscape far below as the drone camera flies forward over a high edge, the ground dropping away to reveal {s}. Bright, clear light with deep shadows in the drop.",
    "Sound: a gust of wind and a deep swell as the ground falls away.",
    "The drop-off reveal lands on the sound swell.",
  ),
  cam_water_skim: ltxFit(
    5,
    "{s} stands on the far shore as the drone camera skims fast and low over the water toward {s}, spray and reflections rushing below. Sunlight sparkles across the water surface.",
    "Sound: rushing water and wind under a steady motor hum.",
    "Low fast skim reads better at 24 fps with rushing water.",
  ),
  cam_hyperlapse_forward: ltxFit(
    5,
    "{s} stands still while the camera moves forward in a hyperlapse through the scene toward {s}, people and traffic blurring past in fast time. The light shifts quickly, passing lights drawing streaks.",
    "Sound: a rhythmic ticking pulse over a blurred, fast-forward city murmur.",
    "Hyperlapse rhythm comes from the ticking pulse.",
  ),
  cam_slowmo_drift: ltxFit(
    5,
    "{s} moves at a fraction of real speed, hair and fabric flowing gracefully, as the camera drifts gently forward. Soft warm backlight with floating dust glowing in the beams.",
    "Sound: slowed, muffled ambience under a deep, soft heartbeat.",
    "Slow motion sells with slowed sound.",
  ),
  cam_smash_in: ltxFit(
    3,
    "{s} turns sharply toward the lens as the camera slams forward in a hard, fast rush, stopping abruptly with a jolt on a close-up. Harsh, contrasty light.",
    "Sound: a fast whoosh ending in a heavy thud.",
    "Short hit; the thud lands the stop.",
  ),
  cam_impact_shake: ltxFit(
    3,
    "{s} braces as a heavy impact hits nearby and the camera jolts and shakes hard, then settles. Dust drifts down through a shaft of light.",
    "Sound: a deep booming impact with rattling debris, then a ringing quiet.",
    "A shake without the boom reads as a glitch.",
  ),
  cam_run_and_gun: ltxFit(
    5,
    "{s} runs fast through the scene as the handheld camera runs after {s}, bouncing with each step and quickly reframing to keep {s} in shot. Natural available light that flares as the camera passes the sun.",
    "Sound: pounding footsteps, heavy breathing and rustling clothes over the surrounding ambience.",
    "Handheld chase energy is mostly sound.",
  ),
  cam_lead_track: ltxFit(
    5,
    "{s} walks confidently toward the camera as it moves backward ahead in a steady leading track, keeping {s} centered. Soft directional light with the background gently blurred.",
    "Sound: rhythmic footsteps over the ambient sounds of the surroundings.",
    "Footsteps synced to the walk.",
  ),
  cam_timelapse_hold: ltxFit(
    8,
    "{s} stays perfectly still while clouds race overhead and shadows sweep across the ground in fast time. The camera stays locked off on a tripod. The light changes quickly from bright day to dusk.",
    "Sound: a slow ambient drone with a soft ticking clock.",
    "Day-to-dusk pass needs the long clip.",
  ),

  // VFX and atmospheric effects (prompt-only on LTX-2.5)
  on_fire: ltxFit(
    5,
    "{s} is engulfed in roaring realistic flames, fire licking upward and thick smoke rising into the sky. The camera holds a steady medium shot, slowly pushing in. Flickering orange firelight dances across {s} and the surroundings.",
    "Sound: a whoosh of ignition followed by roaring, crackling flames.",
    "Fire without the roar is half the effect; prompt-only on LTX-2.5.",
  ),
  explode: ltxFit(
    5,
    "{s} sits still for a beat, then bursts into a huge explosion of fire and light that engulfs the whole frame. The camera stays locked off and shakes with the blast. A blinding white flash turns into rolling orange fire.",
    "Sound: a split second of silence, then a massive boom and a rumbling roar.",
    "The boom on the flash is the payoff.",
  ),
  electrify: ltxFit(
    5,
    "Crackling bolts of electricity streak across {s}, bright arcs jumping between {s} and nearby surfaces. The camera holds a medium shot with small jolts on each arc. Cold blue-white flashes strobe across {s} in a dark scene.",
    "Sound: sharp electric crackling and buzzing with loud zaps on each arc.",
    "Zaps synced to each arc.",
  ),
  tornado: ltxFit(
    6,
    "A huge tornado swirls in behind {s}, debris and dust flying in all directions as the storm intensifies and {s} holds on. The camera holds a low wide shot, shaking in the wind. Dark green storm light with flashes of lightning in the funnel.",
    "Sound: a deep roaring wind like a passing freight train, debris clattering past.",
    "The storm roar carries the scale.",
  ),
  tsunami: ltxFit(
    6,
    "{s} turns as a towering wave crashes in, flooding everything with churning water and debris. The camera pulls back fast and rises to keep the wave in frame. Grey overcast light with white spray glowing against dark water.",
    "Sound: a rising roar of water, then a thunderous crash and churning surf.",
    "Wave build-up plus crash needs 6 s and the roar.",
  ),
  disintegrate: ltxFit(
    6,
    "{s} slowly disintegrates, breaking apart from the edges into fine dust and glowing particles that drift away on the air. The camera holds a steady close shot, then drifts back slightly as the particles scatter. Soft backlight makes the drifting particles glow.",
    "Sound: a soft granular hiss like trickling sand under a low, fading tone.",
    "Slow dissolve reads better over 6 s with the hiss.",
  ),
  force_push: ltxFit(
    5,
    "{s} is suddenly flung backward by an invisible force, flying away into the sky as dust and leaves blast outward. The camera holds, then whips up to follow {s}. Bright daylight with motion blur on the flight.",
    "Sound: a deep bass blast, a rush of wind and a distant thud.",
    "The blast sound sells the invisible force.",
  ),
  levitate: ltxFit(
    6,
    "{s} slowly rises off the ground and floats in mid-air, hair and fabric drifting weightlessly while small objects nearby lift up too. The camera slowly cranes up with {s}, holding a medium shot. Soft ethereal light from below with gently floating dust.",
    "Sound: a low resonant hum swelling softly, with the faint clink of small objects lifting.",
    "Slow float wants 6 s and an eerie hum.",
  ),
  take_flight: ltxFit(
    6,
    "{s} crouches and launches into the sky, flying up and away over the landscape. The camera tilts up and follows {s} in a rising tracking shot. A bright open sky with sunlight flaring around {s}.",
    "Sound: a powerful whoosh on launch, then rushing wind.",
    "Launch whoosh synced to the jump.",
  ),
  fire_breath: ltxFit(
    5,
    "{s} takes a deep breath and exhales a roaring jet of fire into the air. The camera holds a low side angle, slowly pushing in. The flames throw bright orange light across {s} and the scene.",
    "Sound: a deep inhale, then a roaring blast of fire and crackling embers.",
    "Inhale then roar: a sound beat Wan can't add.",
  ),
  flame_aura: ltxFit(
    5,
    "{s} bursts into a blazing aura of fire, flames wrapping around the body without burning it. The camera slowly orbits a quarter turn around {s}. Orange firelight flickers across {s} against a dark background.",
    "Sound: a rushing ignition whoosh into a steady, roaring crackle.",
    "Ignition plus steady roar.",
  ),
  mushroom_cloud: ltxFit(
    8,
    "{s} stands with their back to the camera as a huge mushroom-shaped explosion rises far away over the horizon, and the shockwave blows dust and hair past {s}. The camera holds a wide shot from behind {s}, shaking as the wave arrives. The horizon flashes white, then glows deep orange.",
    "Sound: silence, then a delayed, deep rumbling boom and a rushing wall of wind.",
    "The delayed boom after the flash needs synced audio and more than 5 s.",
  ),
  sandstorm: ltxFit(
    6,
    "{s} braces against the wind as a towering wall of sand sweeps in and swallows the scene in swirling orange dust. The camera holds a steady medium shot, slowly losing visibility. Harsh sun filtered to a dim orange glow through the dust.",
    "Sound: rising, howling wind and hissing sand.",
    "Atmosphere build-up; the howl carries it.",
  ),
  flood: ltxFit(
    6,
    "{s} stands still as water rushes in and rises quickly around {s}, flooding the floor and swirling up to the waist, loose objects floating past. The camera holds a low angle near the water line. Cool light shimmers in rippling reflections.",
    "Sound: rushing, gushing water and floating objects knocking together.",
    "Rising water needs time and the gush.",
  ),
  aurora_sky: ltxFit(
    8,
    "{s} gazes up as the sky behind fills with shimmering green and violet northern lights rippling slowly overhead. The camera slowly tilts up from {s} to the sky. Cold night light with the aurora glow reflecting softly on {s}.",
    "Sound: a quiet night wind under a soft, shimmering ambient pad.",
    "Slow atmosphere; 8 s lets the lights ripple.",
  ),
  wind_blast: ltxFit(
    5,
    "A sudden powerful gust of wind hits {s} from the front, hair and clothes whipping back wildly as {s} squints into it. The camera holds a close medium shot, buffeted slightly. Bright natural light with leaves and dust streaking past.",
    "Sound: a sudden roaring gust and fabric flapping hard.",
    "Gust and flapping synced to the hit.",
  ),
  ice_shatter: ltxFit(
    6,
    "Frost races across {s} until it is encased in clear solid ice, then the ice cracks with bright fracture lines and shatters into glittering shards that fly outward in slow motion, leaving {s} unharmed. The camera holds a steady medium shot, then drifts back as the shards fly. Cold blue light glints off every shard.",
    "Sound: crackling frost, a sharp ice crack and a bright, glassy shatter.",
    "Freeze, crack and shatter are three sound beats.",
  ),
  freeze_over: ltxFit(
    5,
    "Frost creeps across {s}, ice crystals spreading over every surface until {s} is encased in clear, glittering ice as cold mist drifts. The camera pushes in slowly. Pale blue light sparkles on the crystals.",
    "Sound: soft crackling and creaking ice over a cold wind.",
    "Creaking ice gives the freeze weight.",
  ),
  turn_smoke: ltxFit(
    5,
    "{s} dissolves into swirling grey smoke that curls upward and drifts away. The camera holds steady, then tilts up to follow the smoke. Moody side light catches the smoke wisps.",
    "Sound: a soft, airy whoosh and a faint fading hiss.",
    "Soft dissolve with an airy whoosh.",
  ),
  vanish: ltxFit(
    5,
    "{s} vanishes in an instant, the empty clothes hanging in the air for a moment before they collapse flat onto the ground. The camera holds a static medium shot. Flat natural daylight.",
    "Sound: a soft pop, a beat of silence, then the rustle of clothes falling.",
    "The pop and the falling rustle time the gag.",
  ),
  portal: ltxFit(
    6,
    "A swirling, glowing portal opens behind {s}, light and wind spilling out, and {s} turns and steps through it. The camera holds, then pushes in toward the portal. Vivid blue and violet portal light floods over {s}.",
    "Sound: a deep rising hum, crackling energy and a rush of wind through the portal.",
    "Open, step and swallow: 6 s with the hum.",
  ),
  train_rush: ltxFit(
    5,
    "{s} stands still on a platform as a train rushes past right behind at high speed, wind whipping hair and clothes. The camera stays locked off at chest height. Light flickers from the passing carriages.",
    "Sound: a rising rumble, a loud horn and the roaring clatter of the passing train.",
    "The rush is mostly sound.",
  ),
  glitch: ltxFit(
    5,
    "{s} glitches with digital distortion, the color channels splitting apart, scan lines tearing and pixels jittering. The camera holds a steady close-up broken by sudden stutters. Cold screen-like light with flashes of magenta and cyan.",
    "Sound: a digital stutter, buzzing static and crackling data noise.",
    "Glitch audio synced to the tears.",
  ),
  liquid_splash: ltxFit(
    5,
    "{s} drops into clear liquid with a dramatic slow-motion splash, droplets and a crown of liquid hanging in the air. The camera holds a low macro angle at the surface. Bright studio light against a dark backdrop.",
    "Sound: a deep plunk and a rich slow-motion splash.",
    "Product splash shots ship with sound.",
  ),
  butterfly_burst: ltxFit(
    6,
    "{s} breaks apart from the edges into hundreds of bright, colorful butterflies that flutter outward and swirl up into the sky until nothing of {s} is left. The camera holds still, then tilts up to follow the swarm. Soft sunlight and a magical atmosphere.",
    "Sound: a soft rising flutter of many wings with a delicate chime.",
    "The swarm needs 6 s and the flutter.",
  ),
  concert_stage: ltxFit(
    6,
    "{s} performs on a huge concert stage in front of a sea of cheering fans, arms raised as the crowd jumps. The camera cranes over the crowd toward {s}. Colored spotlights and strobes cut through the stage haze.",
    "Sound: a roaring crowd, a pounding live drum beat and booming speakers.",
    "A concert shot is the crowd roar.",
  ),
  deep_water: ltxFit(
    6,
    "{s} holds perfectly still as deep blue water fills the scene, fish drifting past in slow motion and light rays shimmering from above. The camera floats gently around {s}. Rippling caustic light plays across {s}.",
    "Sound: muffled underwater ambience with slow bubbles rising.",
    "Underwater mood is the muffled sound.",
  ),
  angel_wings: ltxFit(
    6,
    "Large white feathered wings slowly unfold from the back of {s}, spreading wide as loose feathers drift down. The camera slowly pushes in from a low angle. Soft glowing light from behind turns the feathers bright.",
    "Sound: soft rustling feathers and a gentle choir-like swell.",
    "Slow unfold with the rustle and swell.",
  ),
};

/** Preset ids that offer the LTX-2.5 engine (picker order). */
export const LTX_EFFECT_PRESET_IDS = Object.keys(LTX_EFFECT_FITS);

export function ltxEffectFit(presetId: unknown): LtxEffectFit | null {
  return typeof presetId === "string" &&
    Object.prototype.hasOwnProperty.call(LTX_EFFECT_FITS, presetId)
    ? LTX_EFFECT_FITS[presetId]
    : null;
}

/** Engine actually used: LTX-2.5 only when asked for and the preset fits. */
export function resolveWanMotionEngine(
  presetId: unknown,
  engine: unknown,
): WanMotionEngine {
  return engine === "ltx25" && ltxEffectFit(presetId) ? "ltx25" : "wan22";
}

/**
 * Effect prompt for LTX-2.5: the preset's LTX template (subject slotted in)
 * plus its sound line, one paragraph. Presets without a fit keep the Wan
 * prompt.
 */
export function ltxEffectPrompt(
  preset: WanMotionPreset,
  subject?: unknown,
): string {
  const f = ltxEffectFit(preset.id);
  if (!f) return wanMotionPrompt(preset, subject);
  const body = wanMotionPrompt({ ...preset, prompt: f.template }, subject);
  return `${body} ${f.sound}`;
}

/**
 * Length in seconds: "auto" (or unset) = the preset's recommendation; the
 * Wan length picks ("5s" / "3s") map to the same seconds on LTX-2.5.
 */
export function ltxEffectSeconds(fit: LtxEffectFit, duration: unknown): number {
  if (typeof duration === "string") {
    const m = duration.trim().match(/^(\d+(?:\.\d+)?)\s*s?$/i);
    if (m) return Number(m[1]);
  }
  if (typeof duration === "number" && duration > 0) return duration;
  return fit.seconds;
}

export interface WanMotionLtxRequest {
  action: typeof LTX25_ANIMATE_ACTION;
  params: Record<string, unknown>;
}

/**
 * Compile a Motion preset to an LTX-2.5 i2v (ltx25_animate) request, or null
 * when the preset has no LTX fit (callers keep the Wan request).
 */
export function wanMotionLtxRequest(opts: {
  preset: unknown;
  subject?: unknown;
  duration?: unknown;
}): WanMotionLtxRequest | null {
  const fit = ltxEffectFit(opts.preset);
  if (!fit) return null;
  const preset = getWanMotionPreset(opts.preset);
  return {
    action: LTX25_ANIMATE_ACTION,
    params: {
      pack_id: LTX25_PACK_ID,
      prompt: ltxEffectPrompt(preset, opts.subject),
      duration: String(ltxEffectSeconds(fit, opts.duration)),
      // Provenance only (the builder ignores them).
      effect: preset.id,
      engine: "ltx25",
    },
  };
}

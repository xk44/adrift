/**
 * Per-action graph builders for POST /api/jobs/action. An action listed here
 * gets its own builder (source media patching, knobs); everything else falls
 * back to the generic `buildActionWorkflow`. Register new tools with one line
 * in ACTION_BUILDERS (and VIDEO_INPUT_ACTIONS when the source is a clip).
 */
import type { ImagineRun, Workflow, WorkflowSlots } from "@/types";
import {
  RACK_FOCUS_ACTION,
  REFOCUS_ACTION,
  buildRackFocusWorkflow,
  buildRefocusWorkflow,
} from "./refocus";
import { SDR_TO_HDR_ACTION, buildSdrToHdrWorkflow } from "./sdrToHdr";
import {
  CHARACTER_SWAP_ACTION,
  buildCharacterSwapWorkflow,
} from "./characterSwap";
import { FACE_SWAP_ACTION, buildFaceSwapWorkflow } from "./faceSwap";
import { MOGE_GEOMETRY_ACTION, buildMogeGeometryWorkflow } from "./mogeGeometry";
import { MATERIAL_MAPS_ACTION, buildMaterialMapsWorkflow } from "./materialMaps";
import { SEE_THROUGH_ACTION, buildSeeThroughWorkflow } from "./seeThrough";
import {
  PERSON_REMOVE_ACTION,
  buildPersonRemoveWorkflow,
} from "./personRemove";
import {
  CAST_SWAP_ACTION,
  CHARACTER_SWAP_MASKED_ACTION,
  VIDEO_BG_SWAP_ACTION,
  VIDEO_OBJECT_ADD_ACTION,
  buildCastSwapWorkflow,
  buildCharacterSwapMaskedWorkflow,
  buildVideoBgSwapWorkflow,
  buildVideoObjectAddWorkflow,
} from "./h3MaskedEdit";
import {
  VIDEO_OBJECT_REMOVE_ACTION,
  VIDEO_REMOVE_TEXT_ACTION,
  buildVideoObjectRemoveWorkflow,
  buildVideoRemoveTextWorkflow,
} from "./videoObjectRemove";
import { VIDEO_EXPAND_ACTION, buildVideoExpandWorkflow } from "./videoExpand";
import { VIDEO_RETAKE_ACTION, buildVideoRetakeWorkflow } from "./videoRetake";
import {
  VIDEO_OBJECT_SWAP_ACTION,
  buildVideoObjectSwapWorkflow,
} from "./videoObjectSwap";
import {
  VIDEO_BG_CHANGE_ACTION,
  buildVideoBgChangeWorkflow,
} from "./videoBgChange";
import {
  OVERLAY_COMPOSITE_ACTION,
  buildOverlayCompositeWorkflow,
} from "./overlayComposite";
import { CAMERA_MOVE_ACTION, ORBIT_360_ACTION } from "./h3Video";
import {
  TRANSITION_ACTION,
  buildCameraMoveWorkflow,
  buildOrbit360Workflow,
  buildTransitionWorkflow,
} from "./h3ImageVideo";
import { REF_VIDEO_ACTION, buildRefVideoWorkflow } from "./h3RefVideo";
import { CHAR_SHEET_ACTION, buildCharSheetWorkflow } from "./h3CharSheet";
import {
  MULTIFRAME_REF_ACTION,
  buildMultiframeRefWorkflow,
} from "./h3MultiframeRef";
import { LIPSYNC_ACTION, buildLipsyncWorkflow } from "./lipsync";
import { LTX25_ANIMATE_ACTION, LTX25_TRANSITION_ACTION } from "./ltx25";
import {
  buildLtx25AnimateWorkflow,
  buildLtx25TransitionWorkflow,
} from "./ltx25Tools";
import { animateBuilder, buildMake3dWorkflow } from "./defaultEngines";
import {
  VIDEO_LIPSYNC_ACTION,
  buildVideoLipsyncWorkflow,
} from "./videoLipsync";
import { WAN_MOVE_ACTION, buildWanMoveWorkflow } from "./wanMove";
import {
  TALKING_AVATAR_ACTION,
  buildTalkingAvatarWorkflow,
} from "./talkingAvatar";
import {
  VIDEO_BG_REMOVE_ACTION,
  buildVideoBgRemoveWorkflow,
} from "./videoBgRemove";
import {
  INTERPOLATE_ACTION,
  buildInterpolateWorkflow,
} from "./frameInterpolate";
import { RELIGHT_ACTION, buildRelightWorkflow } from "./relight";
import {
  LIGHT_MIGRATION_ACTION,
  buildLightMigrationWorkflow,
} from "./lightMigration";
import { ANIMA_REF_ACTION, buildAnimaRefWorkflow } from "./animaRef";
import {
  SEEDVR2_UPSCALE_ACTION,
  buildSeedvr2UpscaleWorkflow,
} from "./seedvr2Upscale";
import { VOSR2_UPSCALE_ACTION, buildVosr2UpscaleWorkflow } from "./vosr2Upscale";
import {
  FLASHVSR_UPSCALE_ACTION,
  buildFlashvsrUpscaleWorkflow,
} from "./flashvsrUpscale";
import { RTX_UPSCALE_ACTION, buildRtxUpscaleWorkflow } from "./rtxUpscale";
import {
  SUBJECT_MATTE_ACTION,
  buildSubjectMatteWorkflow,
} from "./subjectMatte";
import { LTX_UPSCALE_X2_ACTION, buildLtxUpscaleX2Workflow } from "./ltxUpscaleX2";
import {
  MAKE_3D_TRELLIS_ACTION,
  buildMake3dTrellisWorkflow,
} from "./trellis3d";
import {
  IMAGE_TO_SPLAT_ACTION,
  buildImageToSplatWorkflow,
} from "./imageToSplat";
import { BODY_3D_ACTION, buildBody3dWorkflow } from "./body3d";
import {
  MUSIC_ACTION,
  SFX_ACTION,
  buildMusicWorkflow,
  buildSfxWorkflow,
} from "./audioGen";
import { SA3_BUILDERS } from "./sa3Audio";
import { WAN_ANIMATE_ACTION, buildWanAnimateWorkflow } from "./wanAnimate";
import {
  WAN_CAMERA_ACTION,
  WAN_MOTION_ACTION,
  buildWanCameraWorkflow,
  buildWanMotionWorkflow,
} from "./wanMotion";
import {
  VACE_EXTEND_ACTION,
  VACE_REFRAME_ACTION,
  VACE_RESTYLE_ACTION,
  buildVaceExtendWorkflow,
  buildVaceReframeWorkflow,
  buildVaceRestyleWorkflow,
} from "./vaceVideo";
import {
  SHOTS_ACTION,
  ZOOMS_ACTION,
  buildShotsWorkflow,
  buildZoomsWorkflow,
} from "./multiShot";
import { LAYERS_ACTION, buildLayersWorkflow } from "./qwenLayers";
import {
  FIBO_EDIT_ACTION,
  FIBO_EDIT_DEV_ACTION,
  buildFiboEditWorkflow,
} from "./fiboEdit";
import {
  BREAKDOWN_ACTION,
  VECTORIZE_ACTION,
  buildBreakdownWorkflow,
  buildVectorizeWorkflow,
} from "./imageTools";
import { VIDEO_EDIT_ACTION, buildVideoEditWorkflow } from "./lucyEdit";
import {
  ADD_SOUND_ACTION,
  VOICEOVER_ACTION,
  buildAddSoundWorkflow,
  buildVoiceoverWorkflow,
} from "./voiceSound";
import {
  PIPELINE_SCRIPT_ACTION,
  buildPipelineScriptWorkflow,
} from "./pipelineScript";
import {
  PIPELINE_ASSEMBLE_ACTION,
  buildPipelineAssembleWorkflow,
} from "./pipelineAssemble";
import { STITCH_CLIPS_ACTION, buildStitchClipsWorkflow } from "./stitchClips";
import { GRID_VIDEO_ACTION, buildGridVideoWorkflow } from "./gridVideo";
import {
  MUSIC_VIDEO_ACTION,
  MUSIC_VIDEO_ASSEMBLE_ACTION,
  MUSIC_VIDEO_STEMS_ACTION,
  buildMusicVideoAssembleWorkflow,
  buildMusicVideoStemsWorkflow,
  buildMusicVideoWorkflow,
} from "./musicVideo";
import {
  VIDEO_PALETTE_ACTION,
  buildVideoPaletteWorkflow,
} from "./videoPalette";
import {
  MOTION_SCRIPT_ACTION,
  buildMotionScriptWorkflow,
} from "./motionScript";
import {
  DUB_MUX_ACTION,
  DUB_TRANSCRIBE_ACTION,
  DUB_TRANSCRIBE_SPEAKERS_ACTION,
  DUB_TRANSLATE_ACTION,
  DUB_VOICE_ACTION,
  DUB_VOICE_CHATTERBOX_ACTION,
  buildDubMuxWorkflow,
  buildDubTranscribeSpeakersWorkflow,
  buildDubTranscribeWorkflow,
  buildDubTranslateWorkflow,
  buildDubVoiceChatterboxWorkflow,
  buildDubVoiceWorkflow,
} from "./dubVideo";
import { LTX_VFX_BUILDERS, LTX_VFX_VIDEO_ACTIONS } from "./ltxVfx";
import { LTX_RESHOOT_ACTION, buildLtxReshootWorkflow } from "./ltxReshoot";
import { LTX_RESTORE_ACTIONS, LTX_RESTORE_BUILDERS } from "./ltxRestore";
import {
  LTX_INGREDIENTS_ACTION,
  buildLtxIngredientsWorkflow,
} from "./ltxIngredients";
import {
  UPSCALE_CREATIVE_ACTION,
  UPSCALE_REDETAIL_ACTION,
  UPSCALE_SUBTLE_ACTION,
} from "@/lib/upscale/upscaleModels";
import {
  buildUpscaleCreativeWorkflow,
  buildUpscaleRedetailWorkflow,
  buildUpscaleSubtleWorkflow,
} from "./upscaleBuilder";
import { VIDEO_UPSCALE_ACTION, buildVideoUpscaleWorkflow } from "./videoUpscale";
import {
  VOICE_CHANGE_ACTION,
  VOICE_CHANGE_VIDEO_ACTION,
  buildVoiceChangeVideoWorkflow,
  buildVoiceChangeWorkflow,
} from "./voiceChange";

export type ActionBuilder = (
  baseWorkflow: Workflow,
  sourceRun: ImagineRun,
  sourceJobIndex: number,
  params: Record<string, unknown>,
) => { workflow: Workflow; slots: WorkflowSlots; seed: number };

export const ACTION_BUILDERS: Record<string, ActionBuilder> = {
  [ORBIT_360_ACTION]: buildOrbit360Workflow,
  [CAMERA_MOVE_ACTION]: buildCameraMoveWorkflow,
  [TRANSITION_ACTION]: buildTransitionWorkflow,
  [REF_VIDEO_ACTION]: buildRefVideoWorkflow,
  [MULTIFRAME_REF_ACTION]: buildMultiframeRefWorkflow,
  [CHAR_SHEET_ACTION]: buildCharSheetWorkflow,
  [LTX25_ANIMATE_ACTION]: buildLtx25AnimateWorkflow,
  // Default Animate Low/High: LTX-2.5 graph → LTX builder, else generic.
  animate_low: animateBuilder("animate_low", "low"),
  animate_high: animateBuilder("animate_high", "high"),
  [LTX25_TRANSITION_ACTION]: buildLtx25TransitionWorkflow,
  [VIDEO_BG_REMOVE_ACTION]: buildVideoBgRemoveWorkflow,
  [CHARACTER_SWAP_ACTION]: buildCharacterSwapWorkflow,
  [FACE_SWAP_ACTION]: buildFaceSwapWorkflow,
  // Image OR video source: the builder picks the branch, so it is not a
  // VIDEO_INPUT_ACTION.
  [SEEDVR2_UPSCALE_ACTION]: buildSeedvr2UpscaleWorkflow,
  [VOSR2_UPSCALE_ACTION]: buildVosr2UpscaleWorkflow,
  [FLASHVSR_UPSCALE_ACTION]: buildFlashvsrUpscaleWorkflow,
  [RTX_UPSCALE_ACTION]: buildRtxUpscaleWorkflow,
  [SUBJECT_MATTE_ACTION]: buildSubjectMatteWorkflow,
  [LTX_UPSCALE_X2_ACTION]: buildLtxUpscaleX2Workflow,
  [INTERPOLATE_ACTION]: buildInterpolateWorkflow,
  [RELIGHT_ACTION]: buildRelightWorkflow,
  [LIGHT_MIGRATION_ACTION]: buildLightMigrationWorkflow,
  [ANIMA_REF_ACTION]: buildAnimaRefWorkflow,
  [MAKE_3D_TRELLIS_ACTION]: buildMake3dTrellisWorkflow,
  [IMAGE_TO_SPLAT_ACTION]: buildImageToSplatWorkflow,
  // Image OR video source (like SeedVR2): not a VIDEO_INPUT_ACTION.
  [BODY_3D_ACTION]: buildBody3dWorkflow,
  make_3d: buildMake3dWorkflow,
  [MUSIC_ACTION]: buildMusicWorkflow,
  [SFX_ACTION]: buildSfxWorkflow,
  ...SA3_BUILDERS,
  [WAN_ANIMATE_ACTION]: buildWanAnimateWorkflow,
  [LIPSYNC_ACTION]: buildLipsyncWorkflow,
  [VIDEO_LIPSYNC_ACTION]: buildVideoLipsyncWorkflow,
  [WAN_MOTION_ACTION]: buildWanMotionWorkflow,
  [WAN_CAMERA_ACTION]: buildWanCameraWorkflow,
  [VACE_RESTYLE_ACTION]: buildVaceRestyleWorkflow,
  [VACE_REFRAME_ACTION]: buildVaceReframeWorkflow,
  [VIDEO_EXPAND_ACTION]: buildVideoExpandWorkflow,
  [VIDEO_RETAKE_ACTION]: buildVideoRetakeWorkflow,
  [VACE_EXTEND_ACTION]: buildVaceExtendWorkflow,
  [SHOTS_ACTION]: buildShotsWorkflow,
  [ZOOMS_ACTION]: buildZoomsWorkflow,
  [PERSON_REMOVE_ACTION]: buildPersonRemoveWorkflow,
  [VIDEO_OBJECT_REMOVE_ACTION]: buildVideoObjectRemoveWorkflow,
  [VIDEO_REMOVE_TEXT_ACTION]: buildVideoRemoveTextWorkflow,
  [VIDEO_OBJECT_SWAP_ACTION]: buildVideoObjectSwapWorkflow,
  // H3 masked edits (mannequin swap, cast swap, background swap, object add).
  [CHARACTER_SWAP_MASKED_ACTION]: buildCharacterSwapMaskedWorkflow,
  [CAST_SWAP_ACTION]: buildCastSwapWorkflow,
  [VIDEO_BG_SWAP_ACTION]: buildVideoBgSwapWorkflow,
  [VIDEO_OBJECT_ADD_ACTION]: buildVideoObjectAddWorkflow,
  [VIDEO_BG_CHANGE_ACTION]: buildVideoBgChangeWorkflow,
  // One CJVideoPalette node: one-fit LUT regrade of the clip (CPU, no models).
  [VIDEO_PALETTE_ACTION]: buildVideoPaletteWorkflow,
  [LAYERS_ACTION]: buildLayersWorkflow,
  [VECTORIZE_ACTION]: buildVectorizeWorkflow,
  [BREAKDOWN_ACTION]: buildBreakdownWorkflow,
  [REFOCUS_ACTION]: buildRefocusWorkflow,
  [RACK_FOCUS_ACTION]: buildRackFocusWorkflow,
  [MOGE_GEOMETRY_ACTION]: buildMogeGeometryWorkflow,
  [MATERIAL_MAPS_ACTION]: buildMaterialMapsWorkflow,
  [SEE_THROUGH_ACTION]: buildSeeThroughWorkflow,
  [SDR_TO_HDR_ACTION]: buildSdrToHdrWorkflow,
  [VIDEO_EDIT_ACTION]: buildVideoEditWorkflow,
  [TALKING_AVATAR_ACTION]: buildTalkingAvatarWorkflow,
  [WAN_MOVE_ACTION]: buildWanMoveWorkflow,
  [VOICEOVER_ACTION]: buildVoiceoverWorkflow,
  [ADD_SOUND_ACTION]: buildAddSoundWorkflow,
  [FIBO_EDIT_ACTION]: buildFiboEditWorkflow,
  [FIBO_EDIT_DEV_ACTION]: buildFiboEditWorkflow,
  [PIPELINE_SCRIPT_ACTION]: buildPipelineScriptWorkflow,
  [PIPELINE_ASSEMBLE_ACTION]: buildPipelineAssembleWorkflow,
  // Joins N output refs passed in params (text seed source, like assemble).
  [STITCH_CLIPS_ACTION]: buildStitchClipsWorkflow,
  // Source + music refs + beats in params, one CJGridVideo node renders it.
  [GRID_VIDEO_ACTION]: buildGridVideoWorkflow,
  // Music video (MiniMax H3 pack): text-seeded like stitch/grid; refs,
  // song + segment plan in params (src/lib/tools/musicVideo.ts).
  [MUSIC_VIDEO_ACTION]: buildMusicVideoWorkflow,
  [MUSIC_VIDEO_ASSEMBLE_ACTION]: buildMusicVideoAssembleWorkflow,
  [MUSIC_VIDEO_STEMS_ACTION]: buildMusicVideoStemsWorkflow,
  [MOTION_SCRIPT_ACTION]: buildMotionScriptWorkflow,
  [DUB_TRANSCRIBE_ACTION]: buildDubTranscribeWorkflow,
  [DUB_TRANSLATE_ACTION]: buildDubTranslateWorkflow,
  [DUB_VOICE_ACTION]: buildDubVoiceWorkflow,
  [DUB_MUX_ACTION]: buildDubMuxWorkflow,
  // LTX VFX: LTX-2.5 LoRA tools, one builder per action.
  ...LTX_VFX_BUILDERS,
  // Re-shoot: Qwen 2.1 camera-angle first frame -> LTX-2.5 i2v.
  [LTX_RESHOOT_ACTION]: buildLtxReshootWorkflow,
  // Restore: LTX-2.5 restoration IC-LoRAs, one builder (and pack) per mode.
  ...LTX_RESTORE_BUILDERS,
  // Ingredients: reference sheet of up to 4 images -> LTX-2.5 IC-LoRA.
  [LTX_INGREDIENTS_ACTION]: buildLtxIngredientsWorkflow,
  [DUB_VOICE_CHATTERBOX_ACTION]: buildDubVoiceChatterboxWorkflow,
  [DUB_TRANSCRIBE_SPEAKERS_ACTION]: buildDubTranscribeSpeakersWorkflow,
  [VOICE_CHANGE_ACTION]: buildVoiceChangeWorkflow,
  [VOICE_CHANGE_VIDEO_ACTION]: buildVoiceChangeVideoWorkflow,
  [OVERLAY_COMPOSITE_ACTION]: buildOverlayCompositeWorkflow,
  // Faithful = model only; Creative = model + tiled re-render (upscale_model).
  [UPSCALE_SUBTLE_ACTION]: buildUpscaleSubtleWorkflow,
  [UPSCALE_CREATIVE_ACTION]: buildUpscaleCreativeWorkflow,
  // Re-detail = the image model's img2img graph re-rendered in tiles (USDU).
  [UPSCALE_REDETAIL_ACTION]: buildUpscaleRedetailWorkflow,
  [VIDEO_UPSCALE_ACTION]: buildVideoUpscaleWorkflow,
};

/** Actions whose source is a clip: the route 409s when the job has no video. */
export const VIDEO_INPUT_ACTIONS = new Set<string>([
  FLASHVSR_UPSCALE_ACTION,
  RTX_UPSCALE_ACTION,
  SUBJECT_MATTE_ACTION,
  LTX_UPSCALE_X2_ACTION,
  CHARACTER_SWAP_ACTION,
  FACE_SWAP_ACTION,
  VIDEO_BG_REMOVE_ACTION,
  INTERPOLATE_ACTION,
  WAN_ANIMATE_ACTION,
  VACE_RESTYLE_ACTION,
  VACE_REFRAME_ACTION,
  VIDEO_EXPAND_ACTION,
  VIDEO_RETAKE_ACTION,
  VACE_EXTEND_ACTION,
  PERSON_REMOVE_ACTION,
  VIDEO_OBJECT_REMOVE_ACTION,
  VIDEO_REMOVE_TEXT_ACTION,
  VIDEO_OBJECT_SWAP_ACTION,
  CHARACTER_SWAP_MASKED_ACTION,
  CAST_SWAP_ACTION,
  VIDEO_BG_SWAP_ACTION,
  VIDEO_OBJECT_ADD_ACTION,
  VIDEO_BG_CHANGE_ACTION,
  VIDEO_PALETTE_ACTION,
  VIDEO_EDIT_ACTION,
  ADD_SOUND_ACTION,
  VIDEO_LIPSYNC_ACTION,
  DUB_TRANSCRIBE_ACTION,
  DUB_TRANSCRIBE_SPEAKERS_ACTION,
  DUB_VOICE_ACTION,
  DUB_MUX_ACTION,
  ...LTX_VFX_VIDEO_ACTIONS,
  LTX_RESHOOT_ACTION,
  ...LTX_RESTORE_ACTIONS,
  DUB_VOICE_CHATTERBOX_ACTION,
  VOICE_CHANGE_VIDEO_ACTION,
  OVERLAY_COMPOSITE_ACTION,
  RACK_FOCUS_ACTION,
  VIDEO_UPSCALE_ACTION,
]);

export function actionBuilderFor(action: string): ActionBuilder | undefined {
  return Object.prototype.hasOwnProperty.call(ACTION_BUILDERS, action)
    ? ACTION_BUILDERS[action]
    : undefined;
}

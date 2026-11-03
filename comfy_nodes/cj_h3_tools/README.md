# cj_h3_tools

Local ComfyUI nodes behind Adrift's MiniMax H3 masked character swap. They sit on top of
[h3-relay](../../docs/custom-nodes.md) (windowed long-video generation) and
ComfyUI-H3-FaceRefine (face tracking + VOSR2 restore).

| Node                                                                                               | What it does                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CJPasteBackSave`                                                                                 | Pastes the generated subject back onto the **original** source video at source resolution. Only pixels the model both was allowed to change and actually changed are taken. Source audio is stream-copied. Everything outside the edit (subtitles, background detail) stays bit-identical to the source instead of going through the VAE. |
| `CJWindowPreview`                                                                                 | Pass-through that writes each relay window to `output/<prefix>_wNN_<time>.mp4` as it finishes.                                                                                                                                                                                                                                            |
| `CJSubjectFaceSeed`                                                                               | From one subject's mask, picks the frame where that mask is largest and the head point on it. These feed `H3FaceTrackCrop` (`select = closest_to_xy`), so the face tracker locks onto that subject.                                                                                                                                       |
| `CJMaskedFaceClamp`                                                                               | Keeps a face polish only inside that subject's (dilated, feathered) mask. Reports how much of the change it discarded. A high value means the tracker drifted onto someone else.                                                                                                                                                          |
| `CJH3PrecomputeReferences` / `CJH3SelectReference` / `CJH3SourceLatent` / `CJH3SamplingMemory` | Hoist H3 reference and text conditioning, plus source latents, out of the relay window loop, so they're computed once instead of per window.                                                                                                                                                                                              |
| `CJChunkedAttention`                                                                              | Exact query-chunked SDPA, for MPS memory limits.                                                                                                                                                                                                                                                                                          |
| `CJTorchCompileBlocks`                                                                            | `torch.compile` on the diffusion transformer blocks only.                                                                                                                                                                                                                                                                                 |
| `CJMaskTemporal`                                                                                  | Per-frame video masks made stable: `max` dilates in time (inpaint masks never drop a frame), `mean` softens (mattes), `median` drops single-frame pops.                                                                                                                                                                                   |
| `CJVideoBgComposite`                                                                              | Subject matte over a new background image or clip (cover / contain / stretch), or over the blurred original. Choke + feather, light wrap, clip-wide colour match. Pure compositing, chunked torch.                                                                                                                                        |
| `CJGridVideo` | Adrift Grid Video: renders a beat-synced grid music video (poster grid / style infection / temporal mosaic) from one clip or still plus a music track. The edit is a plan JSON built by Adrift (`src/lib/tools/gridVideo.ts`); the node decodes the source once with ffmpeg, composites every frame with numpy (mip-filtered tile sampling, LUT effects: duotone, halftone, posterize, invert, mono, solarize, RGB split) and muxes the music as AAC. No models, no torch. |
| `CJVideoPalette` | Adrift Video Color Palette: regrades a clip to a palette (hex list `#rrggbb[:weight]`, up to 16) or a reference still. Samples ~24 frames across the clip, fits ONE OKLab mean + covariance transfer (palette mode adds a soft pull toward the nearest swatch), bakes it into a 33-point 3D LUT and applies that LUT to every frame, so the grade cannot flicker. Strength, keep luminance (source OKLab L) and skin-tone protect. Writes the MP4 (libx264, source audio as AAC) and the LUT as a `.cube` beside it; returns both paths. No models, no torch. |
| `CJExactPrepare` / `CJExactPasteSave` | Exact-to-source swap: every source frame goes to the model 1:1 (no fps resample, no crop, last frame repeated up to 17n+5); paste-back composites in the source's own YUV planes, reusing its PTS, time base, colour tags and audio packets. Master mode (x264 qp 0) leaves pixels outside the edit bit-identical. PyAV + cv2. |
| `CJRefOnScene` | Cuts the subject out of a reference photo and puts it on a blurred copy of the scene, so the photo's background does not glow around the replaced subject. Finding no subject returns the photo unchanged. |
| `CJSampleFrames` / `CJFindSubjectFrame` | Pick the frame to seed a tracker on: SAM 3.1 detections on evenly spaced frames -> the earliest confident one that is no longer entering the shot. A subject visible only between samples is missed. |
| `CJRepeatAudio` | Repeat a clip with a fixed period before diarizing it, for a retry when VibeVoice-ASR merged two people on a short clip. |
| `CJFollowCamPlate` / `CJFollowCamTrack` / `CJFollowCamCrop` / `CJFollowCamCropMask` / `CJFollowCamPaste` | Follow-cam for small subjects in wide shots: a smoothed, padded, fixed-aspect window tracks the subject mask (offline gaussian centre, running-max size envelope, clamped to the frame, `auto` keeps the full frame when the subject is already large); the tool runs on the crop at model resolution and the result is pasted back into a hi-res plate (prepared geometry at source detail) with a grown, feathered, border-faded subject mask. Pure torch math. |

## Per-subject polish

Rule: the polish only touches the mask region, and each subject is polished separately so faces
never mix. For N swapped subjects, chain N passes, each with its own mask:

```
CJSubjectFaceSeed(mask_k) -> H3FaceTrackCrop(closest_to_xy) -> VOSR2 -> H3FaceStitch
                           -> CJMaskedFaceClamp(base, stitched, mask_k) -> next subject
```

## Install

Symlink or copy this directory into `ComfyUI/custom_nodes/`. It needs `opencv-python` and `av`;
both are usually present already. Each module imports independently: if one fails, only that
module's nodes are disabled and ComfyUI still starts.

## Tests (CPU)

```
python tests/test_subject_polish.py cj_subject_face_polish.py
python tests/test_grid_video.py cj_grid_video.py   # numpy + ffmpeg on PATH
python tests/test_video_palette.py cj_video_palette.py   # numpy + ffmpeg on PATH
python tests/test_prefetch_window.py cj_h3_prefetch.py   # torch only
python tests/test_followcam.py cj_followcam.py   # torch only
python tests/test_exact.py                        # av + cv2, synthetic clips, stub model
```

# Changelog

Notable changes to Adrift. Versions follow the `version` in `package.json`.

## 0.4.0 (2026-11-02)

- Style library on the Styles page: Map, Clusters, Images and Train views. They
  need a new optional local service in `services/stylevault`: `scripts/stylevault.sh setup`, `start` and
  `index <folder>`. Its first index downloads SigLIP 2, about 1.5 GB. See
  [docs/STYLE_LIBRARY.md](docs/STYLE_LIBRARY.md).
- Character swap in video, Exact mode: swap a person across a whole clip. Frame
  count, timing and sound match the source. Pixels away from the person stay
  as in the source (bit-identical in the Lossless master); the edit area covers
  the person and a margin around them, so a close-up re-renders most of the frame.
- Video Translator, several speakers: in Audio only, VibeVoice-ASR finds up to 4
  speakers and each gets a voice cloned from their longest turn. About 16 GB
  extra. Best on clear, turn-taking speech. When a clip comes back as one
  speaker it retries on the clip repeated three times, which recovers many merged
  speakers: in a test on 21 two-speaker windows of 30 s or less from three
  films, 14 labelled the speakers cleanly with the retry, 9 without (clean = at
  least 80% of speech on the right speaker). Clips that already split are not
  retried, so some come back with the wrong labels and no warning: check the
  script. It stops and says so when it still finds one speaker or too little
  speech to clone. Overlapping speech loses words. Long music with no talking can
  tie it up for about 12 minutes on a 4090 and then fail, so pick a part with talking.
- Remove video background, MatAnyone2 engine: keep one named subject and drop
  everyone else, even if they walk in later; a hard cut to another shot can lose
  them (non-commercial weights).
- Pick single tools: the setup wizard lists every tool with its download size
  and whether it fits your GPU, hides what won't, and lets you untick single
  files. `fetch-models` takes `--tool a,b` and `--skip <file>`.
- Export FBX: any result with a GLB gets an FBX button, converted by Blender on
  the computer running Adrift. Re-importing into Blender gave back the same
  vertices, faces, vertex colours, UVs, textures, bones and skin weights. FBX
  can't hold Gaussian splats, so a splat run exports its mesh (Mesh on).
- Image to splat: "Also make a detailed mesh" raises the mesh grid from 384 to
  576. On three test assets, p95 surface error fell 18-27% with 2.2-2.5x the faces.
- Export for Three.js: a zip with a page that shows the result, the GLB or
  splat, and the code to load it. Splats use Spark. The page loads three.js and
  Spark from a CDN; Adrift itself adds no package.
- TouchDesigner: docs/TOUCHDESIGNER.md covers splats through gsLoader (untested), meshes
  through FBX (imported and rendered in TouchDesigner) and a comparison with TouchDesigner's ComfyUI packs.
- Export FBX: textures now keep their file extension, so TouchDesigner can load them.
  `scripts/adrift_td.py` runs tools that take one image, one video or text from
  Python on a thread, using only the standard library. Tested against the HTTP API. Inside TouchDesigner, listing tools worked; a full run has not been tried there.
  Live frames still need one of those packs.
- 3D preview: GLB results orbit in the lightbox. Compressed files and any that
  fail to load fall back to the download button; nothing is fetched from a CDN.
- Guided tour after first-run setup: 20 stops through Create, Tools, Edit,
  Explore, Styles, Characters, workflows, Setup and Settings, with short
  per-page tours. Re-run it from Help, the command palette or Settings.
- Upscaler of choice: pick your upscale model once (in Settings or any upscale
  picker) and every tool, chain and one-click **Upscale** uses it.
- Upscale modes for photos: Faithful, Creative and Re-detail, plus Photo
  upscale (VOSR2) and SeedVR2 3B / 7B / 7B sharp. **Strength** blends back
  toward the original and **Sharpen** adds a final edge pass.
- Upscale after: chain an upscale onto any tool's result.
- Video upscale: Fast (FlashVSR) and Best (SeedVR2) engines and LTX x2. On
  large clips 2x stops at 1440p (Fast) or 1080p (Best) so a 24 GB GPU doesn't
  run out of memory.
- LTX VFX tools on LTX-2.5: Restore video (restore, deblur, decompress,
  colorize, refine details), SDR to HDR for video, Layout to Render and
  Ingredients.
- SDR to HDR for stills: an HLG AVIF to view and an EXR master to grade.
- MiniMax H3: an H3 Image engine on Create, H3 Character Sheet, the opt-in
  Pika Flex LoRA, and context windows for long Reference to Video clips.
  Reference to Video and Multiframe Reference now render at 768p by default.
- HairDeck (linked tool): a Tools card that drives your own HairDeck demo
  ([hyz317/HairDeck](https://github.com/hyz317/HairDeck), Apache-2.0) and saves
  results to Outputs. Adrift doesn't ship HairDeck's code or weights; run it
  yourself and set `HAIRDECK_BACKEND_URL` (loopback by default).
- Layer Split: a character image becomes about 24 depth-ordered parts, saved
  as PSD, a zip of PNGs or planes for Blender.
- Depth & Normals (MoGe-2, or MoGe-3 giant) with a point-map GLB, and Material
  Maps (Marigold v2) for PBR textures.
- Video editor: an A2 audio lane with ducking, crossfade and dip transitions,
  ripple edits, clip speed, volume and fades, reverse, freeze frame and bridge
  cuts, waveforms and snapping, loudness-normalised export and presets up to
  4K / 60 fps in MP4, WebM or ProRes. Right-click a clip for AI tools.
- Creator actions are grouped into submenus; **Customize** shows or hides each
  one, in the lightbox and on gallery hover.
- Tool results show text outputs from ComfyUI (captions, prompts, metadata).
- Export for Blender: a zip with the model (GLB where possible), an
  `import_<name>.py` that frames it with a camera and lights, and a README.
  **Open in Blender** launches it directly when Blender is on this machine.
- Recipe and **Reproduce**: every result carries the settings that made it;
  Reproduce reopens the same tool or prompt with them filled in.
- Refocus and Rack focus: click what should be sharp and get real depth-of-field
  blur from a Depth Anything 3 depth map, as a still or a focus pull.
- Video Retake (LTX 2.5): regenerate a section of a clip and keep or follow
  the original audio.
- Follow subject: an option on Recast and character swap.
- Prompt bar controls are icons with a label on hover; the sidebar collapses
  to icons.
- MCP server (`scripts/adrift-mcp.mjs`): agents can list and run tools and
  fetch results over stdio. See [docs/MCP.md](docs/MCP.md).
- Multiple ComfyUI machines: pin a tool to a machine, or let auto-routing pick
  one that has the graph's nodes and models. Unsent jobs fail over; jobs that
  may have started are never resubmitted.
- MiniMax H3 long clips: Reference to Video chains clips past one generation,
  with a per-subject Fix faces pass.
- Video QC: black frames, freezes, jumps, silence and wrong length, fps or size
  are flagged after every render; failed clips re-roll with a new seed.
- Editor crop tool with aspect presets and a live output size (**C**).
- LoRA training validates its settings and refuses boards with too few usable
  images.
- Ideogram safety-filter blanks are detected, labelled and re-rolled once.
- Tools page **Scene**: set aspect, size, length, seed and style once and every
  tool card starts from them.
- Setup downloads each shared encoder and VAE once when packs overlap, and the
  size shown matches.
- Blender is detected automatically; set a path in Settings if it isn't found.
  **Open in Blender** shows which one it will use.
- Upscale video: an optional NVIDIA RTX engine. It is off by default and needs
  NVIDIA's proprietary `nvidia-vfx` SDK, which Adrift does not ship.
- Installs on npm 12, which blocks native build scripts unless they're allowed,
  and stop with a clear message if the database driver can't load.

## 0.3.0 (2026-10-30): first public release

- Released as open source under the MIT License.
- One-click tools for image editing, enhancement, video, 3D and audio, each
  backed by a plain ComfyUI workflow; [docs/HIGGSFIELD.md](docs/HIGGSFIELD.md)
  maps them to a hosted studio's tool menu.
- Model sets and `scripts/fetch-models.mjs`: download exactly the files a set
  or a single tool needs, with sizes shown before anything is fetched.
- First-run setup and a per-card **Set up** panel that list missing models and
  node packs.
- Mock ComfyUI (`scripts/mock-comfy/`) to try the app without a GPU.
- Docker setup (`docker/`) that builds the app and a ComfyUI container locally.
- Adrift overlay inside ComfyUI (**Ctrl+Shift+J**).

## 0.2.0 (2026-10-25)

- Tools page: a searchable catalog of image and video tools with preview cards
  and one-click open.
- Grid Video: beat-synced grid music videos from your clips, with poster,
  infection and mosaic layouts.
- Smart masks: select a subject by clicking it instead of painting the mask.
- Video tools: background swap, object and person removal, and motion effects
  for existing footage.
- Tool cards show whether the required models are installed before you run
  anything.
- Fixed: tool runs report readable error messages instead of raw backend
  output.

## 0.1.0-alpha (2026-04)

- Prompt-first web UI with a ComfyUI backend and live WebSocket progress.
- Workflow management, discovery and packs.
- Image prompts, style references (`--sref`) and LoRA support.
- Canvas editor with inpainting.
- Gallery with folders and favorites.
- Moodboards with apply-to-prompt.
- Model-aware adapter resolution across SDXL, Flux and SD 1.5.

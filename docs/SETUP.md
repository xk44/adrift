# Setup and reference

Everything beyond the [Quick start](../README.md#quick-start):
the manual install, node packs, models, ports, environment variables, Docker and troubleshooting.
To look around without a GPU first, see
[Try it without a GPU](../README.md#try-it-without-a-gpu-2-minutes).

- [Manual install](#manual-install)
- [Ports](#ports)
- [Platform notes](#platform-notes)
- [Audio (Stable Audio 3)](#audio-stable-audio-3)
- [Training LoRAs](#training-loras)
- [Environment](#environment)
- [Commands](#commands)
- [Docker](#docker)
- [Troubleshooting](#troubleshooting)

## Manual install

`./install.sh` (Windows: `install.cmd`) and `./adrift` do steps 1, 2, 3 (with
`--packs`) and 5, and the setup wizard gives you the command for step 4; these are the same steps by
hand. You need Node.js 20+ (LTS), git, and ComfyUI **v0.42.0
or newer** (tested at commit `e3bee7f`) installed from git with its own
virtualenv (`venv/` or `.venv/`) holding a GPU build of PyTorch. No ComfyUI
yet? This installs one (CUDA 13 shown, which needs NVIDIA driver R580 or newer;
`cu128` / `cu126` for older drivers; on Apple Silicon a plain
`pip install torch torchvision torchaudio` gives the MPS build):

```bash
git clone https://github.com/Comfy-Org/ComfyUI && cd ComfyUI && git checkout e3bee7f && python3 -m venv venv && venv/bin/pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130 && venv/bin/pip install -r requirements.txt && cd ..
```

### 1. Install the web app

macOS / Linux:

```bash
git clone https://github.com/xk44/adrift.git adrift
cd adrift
npm install
cp .env.example .env.local
```

On Windows (PowerShell), use `Copy-Item .env.example .env.local` for the last
step. The defaults point at ComfyUI on `127.0.0.1:8188`, and every variable is
optional (see [Environment](#environment)).

### 2. Start ComfyUI with a CORS origin

Use ComfyUI v0.42.0 or newer; older versions lack the Krea 2, MOSS-Image and
MiniMax H3 core nodes. Adrift is tested at commit `e3bee7f` (v0.42.0 + 7
commits), which the MOSS-Image depth restyle needs. Since v0.24, ComfyUI
rejects the browser's cross-port WebSocket (`localhost:3000` to
`127.0.0.1:8188`) with a 403 unless it is started with `--enable-cors-header`.

**macOS / Linux.** `scripts/start-comfyui.sh` passes the right flags. It reads
`COMFY_ROOT` (from your shell or `.env.local`) and runs ComfyUI's own
virtualenv (`venv/` or `.venv/` inside that folder):

```bash
COMFY_ROOT=/path/to/ComfyUI scripts/start-comfyui.sh
```

Optional variables: `COMFY_PORT` (default `8188`), `COMFY_LISTEN` (default
`127.0.0.1`), `CJ_ORIGIN` (default `http://localhost:3000`; it must match the
URL you open Adrift on) and `CJ_PREVIEW_METHOD` (default `auto`). Without the
script, run this from the ComfyUI folder and its virtualenv:

```bash
python main.py --listen 127.0.0.1 --port 8188 --enable-cors-header http://localhost:3000
```

**Windows.** The shell scripts need Git Bash or WSL. With the ComfyUI portable
build, start it from the portable folder:

```powershell
.\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --listen 127.0.0.1 --port 8188 --enable-cors-header http://localhost:3000
```

The ComfyUI desktop app also works if you add
`--enable-cors-header http://localhost:3000` to its server arguments.

### 3. Add Adrift's custom nodes

Link or copy the folders in `comfy_nodes/` into `ComfyUI/custom_nodes/`, then
restart ComfyUI:

| Folder                                             | Needed for                                                   |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `adrift_overlay`                                   | The in-ComfyUI overlay (Adrift inside ComfyUI)               |
| `sref_system`                                      | LoRA shortcodes                                              |
| `cj_image_tools`                                   | Vectorize and Breakdown                                      |
| `cj_krea2_dual_control`                            | Krea 2 dual control                                          |
| `comfyui-krea2-anypaint`, `comfyui-krea2-outpaint` | Krea 2 inpaint and outpaint                                  |
| `cj_whisper_asr`                                   | Video Translator (transcription step)                        |
| `cj_kokoro_tts`                                    | Kokoro voices in Voiceover (own Python venv, see its README) |
| `cj_h3_cache`, `cj_h3_tools`                       | the optional MiniMax H3 pack only                            |
| `sefi_wrapper`                                     | the SeFi-Image pack only                                     |

macOS / Linux: `ln -s "$PWD/comfy_nodes/sref_system" /path/to/ComfyUI/custom_nodes/`
(repeat for each folder). `scripts/install-overlay.sh [/path/to/ComfyUI]` links
`adrift_overlay` into every ComfyUI it finds, including the desktop app (or use
"Add Adrift to ComfyUI" in Settings, ComfyUI section). Windows:
copy the folders, or use `mklink /J` from an administrator prompt.

Third-party node packs (ComfyUI-GGUF, Impact Pack, VideoHelperSuite and others)
are pinned in [docs/custom-nodes.md](custom-nodes.md). Install them, with
the patches some of them need, using the same script the Docker image uses:

```sh
python3 docker/install-comfy-packs.py /path/to/ComfyUI/custom_nodes
/path/to/ComfyUI/venv/bin/python -m pip install -r docker/comfyui-packs-requirements.txt
```

On Windows, run the script with `python` and point pip at ComfyUI's own Python
(`python_embeded\python.exe -m pip ...` on the portable build).

`./install.sh --packs` also passes `docker/comfyui-constraints.txt`
(minus its torch lines) as pip constraints, so the packs cannot move
ComfyUI's own dependencies. By hand: `-c` a copy of that file without the
torch lines (keep the GPU torch you have).

### 4. Download models

Pick the tools you want in [docs/models.md](models.md). It lists every
file each tool loads, the folder under `ComfyUI/models/` it goes in, and its
size, license and nc flag. [models/download-list.md](../models/download-list.md)
has the pinned URLs. `--set starter` (~11 GB), `--set minimal` (~272 GB)
and `--set full` (~1,040 GB) are described in [Model sets](../README.md#model-sets). You do
not need everything; one image engine and one video model are enough to start. File names must match exactly,
including subfolders such as `loras/edit_tools/`.

`scripts/fetch-models.mjs` downloads them for you (Node only, no extra
packages). It prints the plan and total size first and downloads only with
`--yes`:

```bash
node scripts/fetch-models.mjs --set starter          # plan, Starter set
node scripts/fetch-models.mjs                        # plan, minimal set
node scripts/fetch-models.mjs --set full             # plan, everything
node scripts/fetch-models.mjs --list-tools           # tool ids
node scripts/fetch-models.mjs --tool bg_remove --comfy /path/to/ComfyUI --yes # one card's files
```

Pass `--comfy /path/to/ComfyUI`, or export `COMFY_ROOT` in your shell (this script doesn't read `.env.local`).
`--tool` fetches only the files that one Tools card loads. Files are pinned to
the revision in the download list and size-checked. It uses the `hf` CLI when
installed (needed, or `HF_TOKEN`, for gated repos) and plain HTTPS with resume
otherwise. It never deletes or overwrites a file; one with the wrong size is
reported and left alone. Files that are not on Hugging Face, or need a key
conversion, are printed as manual steps.

### 5. Run

```bash
npm run dev
```

Open `http://localhost:3000` (Adrift listens on `127.0.0.1`; see [Ports](#ports)
to open it to other devices). `GET /api/health?nodes=1` reports the ComfyUI
connection and any missing node classes, and `GET /api/tools/model-status`
lists the model files each tool still needs.

The FLUX.3 Klein engine is on the **Create** page by default (`CJ_FLUX3=0`
hides it). The Qwen-Image 2.1 and MOSS-Image engines stay hidden until you set
`CJ_QWEN_IMAGE_21=1` or `CJ_MOSS_IMAGE=1` in `.env.local` (download their
weights first). The Tools
cards that use these models do not need the flags. `CJ_DEFAULT_PACK` picks the
engine used when a prompt names none (default `krea2`).

## Ports

| Service | Default | Change it with |
| ------- | ------- | -------------- |
| Adrift | `127.0.0.1:3000` | `npm run dev -- -p <port>` (then start ComfyUI with a matching `CJ_ORIGIN`); `CJ_HOST` for the address |
| ComfyUI | `127.0.0.1:8188` | `COMFY_PORT` / `COMFY_LISTEN` for `scripts/start-comfyui.sh`, then `COMFY_HTTP_URL` and `NEXT_PUBLIC_COMFY_WS_BASE` |
| Helper ComfyUI (optional MiniMax H3 pack) | `127.0.0.1:8189` | `CJ_H3_WARM_URL` |
| Style library service (optional) | `127.0.0.1:8000` | `STYLEVAULT_API_URL` |
| Docker: Adrift / ComfyUI | `3044` / `8188` | `docker/.env` |

Adrift binds to `127.0.0.1`, so only this computer can open it.

**Security model.** Adrift is a single-admin app. Anyone who can use its API
(anyone holding `ADMIN_API_KEY`, or anyone on this machine when the key is
unset) can install ComfyUI node packs and run any ComfyUI graph, which means
full code execution on the machine. Treat the key like a shell password. More
in [SECURITY.md](../SECURITY.md).

**ComfyUI has no login.** Anyone who reaches its port can run any graph or
install code. Never expose ComfyUI's port on a LAN or the internet: keep it on
`127.0.0.1` (the default for `scripts/start-comfyui.sh` and, through
`COMFY_BIND_ADDR`, for Docker). For a ComfyUI on another machine, forward its
port over SSH (`ssh -N -L 8188:127.0.0.1:8188 <gpu-host>`) instead of
`--listen 0.0.0.0`.

### Using Adrift from other devices

To use Adrift from a phone or another computer, set `CJ_HOST=0.0.0.0` **and**
`ADMIN_API_KEY` in `.env.local` (Docker: `BIND_ADDR` and `ADMIN_API_KEY` in
`docker/.env`); the server will not start on a non-loopback address without
the key. ComfyUI stays on loopback: Adrift's server talks to it for you.

The one thing that does not cross over is the live progress socket, which the
browser opens straight to ComfyUI. Adrift has no built-in proxy for it. From
another device jobs still run and finish (the app falls back to polling
through Adrift's server), but without live step previews. To get them, put a
reverse proxy you run (nginx, Caddy) in front of Adrift that serves ComfyUI's
`/ws` under a path on Adrift's own origin, requires your own auth, and set
`NEXT_PUBLIC_COMFY_WS_BASE` to that path (for example `/comfy`, which the
browser opens as `wss://<adrift-host>/comfy/ws`). It is read at build time,
so rebuild Adrift after changing it.

## Platform notes

- **Linux (NVIDIA).** The main target. Use ComfyUI's venv with CUDA PyTorch.
- **macOS (Apple Silicon).** ComfyUI runs on MPS. fp8 files do not load there;
  use the bf16 or GGUF files. The scripts work with the bash 3.2 that ships
  with macOS. If video comes out black, see [Troubleshooting](#troubleshooting).
- **Windows.** `install.cmd` and `adrift.cmd` run natively (PowerShell 5.1+;
  `.\install.ps1` works too where scripts are allowed). They find the ComfyUI
  portable build (`ComfyUI_windows_portable`) and ComfyUI Desktop
  (`Documents\ComfyUI`); `adrift.cmd` starts the portable build with the CORS
  flag Adrift needs instead of `run_nvidia_gpu.bat`. The other `.sh` scripts
  need Git Bash or WSL; `node scripts/fetch-models.mjs` and `npm run dev` work
  in PowerShell too. Build with `npm run build:deploy` (plain `next build`).

## Audio (Stable Audio 3)

Adrift's audio tools run **Stable Audio 3** inside ComfyUI. The small SFX model
(in the Starter set) drives **Sound effect**. The **Medium** model adds four
tools:

- **Text to audio**: music or sound from a prompt.
- **Restyle**: keep the timing of a clip, change its sound.
- **Fix a section**: regenerate one stretch of a clip and keep the rest.
- **Extend**: continue a clip past its end.

You can also **train an audio LoRA** on your own clips with the
[stable-audio-3](https://github.com/Stability-AI/stable-audio-3) trainer.
`comfy_nodes/cj_sa3_audio/tools/sa3_lora_to_comfy.py` converts its output into a
LoRA that ComfyUI loads (check it with `verify_comfy_lora.py`); train against
`stable_audio_3_medium_base.safetensors`.

Setup:

1. Link `comfy_nodes/cj_sa3_audio` into `ComfyUI/custom_nodes/` (it adds the
   fix-a-section and extend node, *SA3 Inpaint / Continue (Adrift)*), then
   restart ComfyUI.
2. Accept the license on
   [stabilityai/stable-audio-3-medium](https://huggingface.co/stabilityai/stable-audio-3-medium)
   (gated). ComfyUI's single-file copies are in
   [Comfy-Org/stable-audio-3](https://huggingface.co/Comfy-Org/stable-audio-3):
   `checkpoints/stable_audio_3_medium.safetensors` (9.2 GB; the `_base` file
   is for training) and `text_encoders/t5gemma_b_b_ul2.safetensors` (1.2 GB).
3. Example graphs: `comfy_nodes/cj_sa3_audio/examples/sa3_medium_*.api.json`.

The Stable Audio 3 weights are under the **Stability AI Community License**
(the trainer code is MIT): free for
individuals and organizations under US$1M yearly revenue, with registration for
commercial use. Its Gemma text encoder adds the Gemma terms (`LICENSE_GEMMA.md`).

## Training LoRAs

**Characters**, **Styles** datasets and **Tools → Train Identity** train image
LoRAs with a trainer you install next to Adrift. Adrift does not ship trainer
code: it writes the trainer's config, runs the trainer's own scripts (one job
at a time, logs and progress in the run panel) and links the finished
`.safetensors` into ComfyUI's `models/loras` when ComfyUI runs on the same
machine (otherwise it shows the file's path).

| Model | Trainer | Status |
| --- | --- | --- |
| Krea 2 | [kohya-ss/musubi-tuner](https://github.com/kohya-ss/musubi-tuner) (Apache-2.0) | supported |
| Krea 2 Turbo, MOSS-Image | [ostris/ai-toolkit](https://github.com/ostris/ai-toolkit) (MIT) | untested |

Setup:

1. Clone the trainer and give it its own venv. Install PyTorch for your GPU,
   then the trainer's requirements, following the install section of its
   README (Settings → Training shows the commands to copy).
2. In **Settings → Training**, enter the repo folder and the venv's Python
   (for example `~/src/musubi-tuner/.venv/bin/python`), then **Detect**: it
   shows the repo commit, which models it can train and anything missing.
3. Model files: musubi-tuner trains Krea 2 from the raw DiT checkpoint (set
   its path), the bf16 Qwen3-VL 4B text encoder and the Qwen-Image VAE. The
   last two default to `text_encoders/qwen3vl_4b_bf16.safetensors` and
   `vae/qwen_image_vae.safetensors` in ComfyUI's models folder. The fp8
   text encoder does not load in musubi-tuner.

VRAM: Krea 2 with musubi-tuner runs on a 24 GB GPU with fp8 base weights and
block swap (20 by default, up to 26; more swap uses less VRAM and trains
slower). Rank 16-32 is enough for most characters and styles; rank 16 and
1500 steps are the defaults. On Apple Silicon Adrift runs the trainer on MPS
without fp8 or block swap, which needs much more unified memory and is slow.

Krea 2 raw checkpoints that carry last-layer `down`/`up` projection weights
need a musubi-tuner build whose Krea 2 model has that layer; **Detect** warns
when the clone does not.

When `STYLEVAULT_API_URL` is set, training from Datasets goes through the style
library service instead and these settings are not used.

## Style library (optional)

Map, Clusters, Images and Train on the Styles page need a local Python service
in `services/stylevault`. `install.sh` does not install it. Browse and Datasets
work without it, and Datasets can train with the local trainer above.

```bash
scripts/stylevault.sh setup
scripts/stylevault.sh start
scripts/stylevault.sh index /path/to/images
```

The folder must be under `CJ_VAULT_DATASET_ROOTS` and `STYLEVAULT_ALLOWED_ROOTS`.
The first index downloads SigLIP 2, about 1.5 GB. Details and licenses:
[STYLE_LIBRARY.md](STYLE_LIBRARY.md).

## Environment

Copy `.env.example` to `.env.local` and edit it as needed. Every variable is optional.

<details>
<summary>Environment variables</summary>

| Variable | Required | Description |
| --- | --- | --- |
| `COMFY_HTTP_URL` | No | Server-side ComfyUI HTTP endpoint. Defaults to `http://127.0.0.1:8188`. |
| `NEXT_PUBLIC_COMFY_WS_BASE` | No | Browser WebSocket endpoint for ComfyUI progress. Defaults to `ws://127.0.0.1:8188`. |
| `COMFY_WS_BASE` | No | Server-side ComfyUI WebSocket endpoint. |
| `COMFY_ROOT` | No | ComfyUI installation root (local model folders, LoRA downloads, saved workflows). Defaults to `../ComfyUI`. Also read by `scripts/start-comfyui.sh` and `scripts/fetch-models.mjs`. |
| `COMFYUI_OUTPUT_DIR` | No | ComfyUI output folder the admin cleanup scans. Defaults to `../ComfyUI/output`. |
| `COMFY_BEARER` | No | Bearer token sent on every server-to-ComfyUI HTTP call, for a ComfyUI behind an auth proxy. |
| `COMFY_VIDEO_HTTP_URL` | No | Optional second ComfyUI for video jobs (another GPU machine, or an fp32 video instance on Apple Silicon). Unset = one ComfyUI runs everything. |
| `COMFY_VIDEO_ACTIONS` | No | Comma-separated actions routed to `COMFY_VIDEO_HTTP_URL`. |
| `COMFY_VIDEO_PACKS` | No | Comma-separated packs routed to `COMFY_VIDEO_HTTP_URL`. |
| `COMFY_VIDEO_OUTPUT_SUBFOLDER` | No | Output subfolder used to find video-host files. Defaults to `adrift-video`. |
| `COMFY_EXCLUSIVE_BACKENDS` | No | Run one host at a time when two ComfyUIs share a GPU. On by default when `COMFY_VIDEO_HTTP_URL` is set. |
| `COMFY_EXCLUSIVE_WAIT_MS` | No | Max wait for the other host to go idle (ms). Defaults to `600000`. |
| `COMFY_EXCLUSIVE_POLL_MS` | No | Queue poll interval while waiting (ms). Defaults to `3000`. |
| `CJ_QWEN_IMAGE_21` | No | Set to `1` to add the Qwen-Image 2.1 engine (nc) to the Create page. |
| `CJ_FLUX3` | No | FLUX.3 Klein engine on the Create page; on by default, set to `0` to hide it. |
| `CJ_MOSS_IMAGE` | No | Set to `1` to add the MOSS-Image engine to the Create page. |
| `CJ_DEFAULT_PACK` | No | Engine used when no model is picked. Defaults to `krea2` (Krea 2); `sdxl` for small GPUs. |
| `CJ_DEFAULT_VIDEO_PACK` | No | Video pack used by `--video` when none is given (default `ltx25`, LTX-2.5). |
| `CJ_LOW_VRAM` | No | Set to `1` to always tile the VAE decode (same as `--lowvram`). |
| `CJ_TILED_VAE_AUTO_PIXELS` | No | Tile the VAE decode automatically above this many output pixels. |
| `CJ_H3_WARM_URL` | No | Helper ComfyUI that keeps the optional MiniMax H3 pack loaded. Defaults to `http://127.0.0.1:8189`. |
| `COMFY_DEFAULT_CHECKPOINT` | No | Checkpoint the Create page uses when the graph names none (e.g. `sd_xl_base_1.0.safetensors`). Defaults to the first one ComfyUI lists. |
| `COMFY_KREA2_DRAFT_UNET` | No | Optional Krea 2 draft diffusion model filename. |
| `KREA2_BACKEND_URL` | No | Optional standalone Krea 2 backend endpoint (not part of this repository). |
| `CJ_HOST` | No | Address the app listens on. Defaults to `127.0.0.1` (this computer only). A non-loopback value such as `0.0.0.0` requires `ADMIN_API_KEY`. |
| `PORT` | No | App port. Defaults to `3000`. |
| `CJ_ORIGIN` | No | The URL you open Adrift on, passed to ComfyUI's `--enable-cors-header`. Defaults to `http://localhost:3000`. |
| `ADMIN_API_KEY` | When `CJ_HOST` is not loopback | Admin key for all API routes. Unset = no auth (allowed on loopback only). |
| `SESSION_SECRET` | No | Optional session secret. Falls back to `ADMIN_API_KEY`. |
| `CJ_ALLOWED_HOSTS` | No | Extra Host names trusted when `ADMIN_API_KEY` is unset (DNS-rebinding guard). |
| `CJ_FRAME_ANCESTORS` | No | Extra ComfyUI origins allowed to frame Adrift (overlay), space separated. |
| `SECRETS_PASSPHRASE` | No | Passphrase for encrypted secrets. |
| `SECRETS_SALT` | No | Optional salt for secret encryption. |
| `CIVITAI_API_KEY` | No | Optional CivitAI API key. |
| `CIVITAI_API_KEY_ENCRYPTED` | No | Optional encrypted CivitAI API key. |
| `CIVITAI_API_URL` | No | CivitAI API base URL. |
| `CIVITAI_NSFW_API_URL` | No | Optional NSFW CivitAI API base URL. |
| `STYLEVAULT_API_URL` | No | Address of the optional style library service in `services/stylevault`. See [docs/STYLE_LIBRARY.md](STYLE_LIBRARY.md). Setting it also shows Describe and sends Datasets training to the service; unset, Datasets uses the local trainer from Settings → Training. |
| `NEVO_BACKEND_URL` | No | Optional external search backend for the prompt bar (not part of this repository). Its menu shows only when it is set. |
| `HF_TOKEN` | No | Hugging Face token for gated repos, read by `scripts/fetch-models.mjs`. |
| `KREA_MOODBOARDS_DIR` | No | Optional local Krea moodboard image library root. |
| `MOODBOARD_IMPORT_ROOT` | No | Folder moodboard auto-sort may import from. Defaults to your home folder. |
| `BLENDER_PATH` | No | Blender executable for GLB to USDZ and FBX export. Auto-detected when unset. |
| `NEXT_PUBLIC_ABUSE_REPORT_URL` | No | "Report misuse" link on MiniMax H3 tools. Defaults to `/legal/h3#report`. |
| `NEXT_PUBLIC_CJ_REPO_URL` | No | Repository URL for the "Report this problem" link on failed runs. Unset = hidden. |
| `NEXT_PUBLIC_REACT_SCAN` | No | Enables the React Scan dev overlay when set to `1`. |
| `CJ_API_LOG` | No | Set to `1` to log API requests in production builds. |
| `NEXT_DIST_DIR` / `NEXT_OUTPUT` | No | Build output folder (default `.next`) / `standalone` for a self-contained server build. |
| `COMFY_LIVE_TESTS` | No | Enables live ComfyUI integration tests when set to `1`. |
| `COMFY_RUNTIME_COMPAT` | No | Enables saved-workflow runtime compatibility tests when set to `1`. |

</details>

## Commands

```bash
npm run dev          # development server
npm run type-check   # tsc
npm run test:run     # unit tests (vitest)
npm run build        # production build
npm run docs:tools   # regenerate docs/TOOLS.md after changing a tool or workflow
npm run docs:models  # regenerate docs/models.md
```

Live ComfyUI tests are opt-in:

```bash
COMFY_LIVE_TESTS=1 npm run test:run -- src/__tests__/e2e-comfyui.test.ts
```

## Docker

`docker/` runs Adrift and its own ComfyUI as two containers. Images are
built locally from official base images (`python`, `node`); ComfyUI is
pinned to the commit Adrift's graphs are validated against, with CUDA
PyTorch from download.pytorch.org.

Requirements: Docker with Compose v2.24+ and BuildKit. For the GPU mode, an
NVIDIA driver that supports CUDA 13 (R580+) and the NVIDIA Container
Toolkit. Models are not included; put them in a folder with the standard
ComfyUI layout (`diffusion_models/`, `loras/`, `vae/`, `text_encoders/`,
`clip_vision/`, ...). The Tools page and `GET /api/tools/model-status` report
which files a tool still needs.

```bash
cd docker
cp .env.example .env        # paths, bind address, PUID/PGID, ADMIN_API_KEY
mkdir -p models comfy-data/output comfy-data/user custom_nodes adrift-data extra-models
cp -r ../data/wildcards adrift-data/   # optional: bundled prompt wildcards
docker compose up -d --build
```

Adrift is then on `http://<BIND_ADDR>:3044` and ComfyUI on
`http://127.0.0.1:8188` (`COMFY_BIND_ADDR`, loopback by default).

| Service                   | Image                                               | Port        | Volumes                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adrift`                  | `adrift:local` (Next.js standalone, runs as `PUID`) | 3044 → 3000 | `ADRIFT_DATA_DIR` → `/app/data` (SQLite, uploads); models (read-only) and ComfyUI output for model checks and cleanup                                                       |
| `comfyui` / `comfyui-cpu` | `adrift-comfyui:local` (runs as `PUID`)             | 8188        | `COMFY_MODELS_DIR` → `/models` (read-only), `COMFY_DATA_DIR` → `/data` (user, input, temp), `COMFY_OUTPUT_DIR` → `/data/output`, `COMFY_CUSTOM_NODES_DIR` → `/custom_nodes` |

Inside the stack Adrift talks to ComfyUI at `http://comfyui:8188`. The
browser opens ComfyUI's WebSocket directly, so `COMFY_PUBLIC_WS` must be the
address the browser can reach; it is baked into the Adrift bundle at build
time (rebuild `adrift` after changing it). `ADRIFT_PUBLIC_URL` becomes
ComfyUI's `--enable-cors-header` origin.

**GPU vs CPU.** `COMPOSE_PROFILES` in `.env` picks the ComfyUI service:
`gpu` (default; reserves one NVIDIA GPU) or `cpu` (`--cpu`, for smoke tests
on machines without a usable GPU). To switch:

```bash
sh comfy-mode.sh gpu   # or: cpu  (edits COMPOSE_PROFILES, swaps the service)
```

All services use `restart: unless-stopped`, so the stack comes back after a
host reboot in whichever mode `.env` selects.

If your Docker host uses the legacy `nvidia` runtime instead of the
toolkit's device requests (some NAS distros), add `runtime: nvidia` and
`NVIDIA_VISIBLE_DEVICES: all` to the `comfyui` service.

**Existing model library.** To let ComfyUI also see models from another
tree (e.g. an A1111/SD.Next `models/` folder), set `COMFY_EXTRA_MODELS_DIR`
(mounted read-only at `/extra-models`) and create
`$COMFY_DATA_DIR/extra_model_paths.yaml`:

```yaml
sdnext:
  base_path: /extra-models/
  checkpoints: Stable-diffusion
  loras: Lora
  vae: VAE
  upscale_models: |
    ESRGAN
    RealESRGAN
```

**VRAM.** The default is ComfyUI's dynamic VRAM management, which on a
12–16 GB card offloads to system RAM as needed. `COMFY_VRAM_ARGS` passes
extra flags: `--reserve-vram 1.0` when something else shares the GPU,
`--lowvram` only if large video models still run out of memory.

**Custom nodes.** The ComfyUI image includes Adrift's own nodes
(`comfy_nodes/`) and every third-party pack in `docs/custom-nodes.json`,
cloned at its pinned commit with the required patches applied
(`docker/install-comfy-packs.py`, deps pinned in
`docker/comfyui-packs-requirements.txt`). Set `ADRIFT_NODE_PACKS=required`
to skip the optional packs or `none` for a core-only image. Extra packs go in
`COMFY_CUSTOM_NODES_DIR`; their Python requirements must be installed into
the image (extend `Dockerfile.comfyui`). `GET /api/health?nodes=1` and the
Tools page list missing node classes.

Without Docker, install the packs into your own ComfyUI with the same script,
then the pinned deps into ComfyUI's Python:

```sh
python3 docker/install-comfy-packs.py /path/to/ComfyUI/custom_nodes
/path/to/ComfyUI/venv/bin/python -m pip install \
  -r docker/comfyui-packs-requirements.txt
```

`./install.sh --packs` also passes `docker/comfyui-constraints.txt`
(minus its torch lines) as pip constraints, so the packs cannot move
ComfyUI's own dependencies. By hand: `-c` a copy of that file without the
torch lines (keep the GPU torch you have).

Several packs (GGUF, VibeVoice, MOSS-Image, MOSS-Image-Ostris-Edit) need the
patches in `docs/patches/` to work with Adrift's models and ComfyUI version.
Installing them from their upstream repos or ComfyUI-Manager skips those
patches; use the script. It is safe to re-run: a pack already at its pinned
commit just gets any missing patches, and on Apple Silicon it also applies the
MPS patch for MOSS-i2i.

**Security.** ComfyUI has no authentication: anyone who reaches its port can
run any graph. Keep `COMFY_BIND_ADDR` on `127.0.0.1` (Adrift reaches ComfyUI
inside the stack). `BIND_ADDR` (Adrift's port) may be a LAN address, never a
public interface, and then needs `ADMIN_API_KEY` / `SESSION_SECRET` in `.env`.
A browser on another machine cannot open the loopback ComfyUI's progress
socket; jobs still finish by polling, without live step previews.

## Troubleshooting

**`Node.js ... is too old` or `Node.js is not installed`.** Adrift needs Node.js 20 or newer. macOS: `brew install node@22`; Windows: `winget install OpenJS.NodeJS.LTS`; Linux: install [nvm](https://github.com/nvm-sh/nvm), open a new terminal, then `nvm install --lts`. Then run the installer again.

**The installer stopped.** It prints the failed command and the step. Fix that and run `./install.sh` again (`install.cmd` on Windows); finished steps are skipped. `npm ci` failures are almost always `better-sqlite3` compiling on a non-LTS Node: switch to an LTS release (see the `better-sqlite3` entry below).

**`./adrift` says ComfyUI is not set up, or `no ComfyUI found`.** Tell Adrift where it is once: `./install.sh --comfy /path/to/ComfyUI` (the folder with `main.py`), `./install.sh --remote http://HOST:8188` for one on another computer, or `./install.sh --install-comfy` to install one next to Adrift. The setup wizard in the app does the same for a running ComfyUI (This computer / Another computer / Over the internet).

**`port 3000 is in use by another program`.** Something else holds the app's port. Stop it, or start Adrift elsewhere: `PORT=3001 ./adrift` (PowerShell: `$env:PORT='3001'; .\adrift.cmd`). The same goes for ComfyUI's port with `COMFY_PORT=8190`; then point Adrift at it with `COMFY_HTTP_URL=http://127.0.0.1:8190` in `.env.local` or in the setup wizard.

**ComfyUI or the app does not come up.** `./adrift` prints the last lines of the log on failure. Full logs: `~/Library/Logs/adrift-*.log` on macOS, `~/.local/state/adrift/` on Linux, `%LOCALAPPDATA%\Adrift\logs` on Windows.

**Adrift says ComfyUI is offline.** ComfyUI is not running, or not at `COMFY_HTTP_URL`. Start it with `scripts/start-comfyui.sh` (set `COMFY_ROOT` first), wait until its log says "To see the GUI go to", then reload the page.

**A tool says models are missing.** Press **Set up** on the tool card: the drawer lists each missing file, its folder and size. Download them with `node scripts/fetch-models.mjs --tool <id> --yes` (uses `COMFY_ROOT`), or by hand into the listed folder, then press the recheck button in the drawer. File names and subfolders must match exactly.

**The UI says ComfyUI is offline, or the browser console shows a WebSocket 403.** ComfyUI (v0.24 and later) checks the request origin. Start it with `--enable-cors-header <the URL you open Adrift on>` (`scripts/start-comfyui.sh` does this). If you serve Adrift on a port other than 3000, set `CJ_ORIGIN` to match, for example `CJ_ORIGIN=http://localhost:3001 scripts/start-comfyui.sh`.

**ComfyUI is running but Adrift cannot reach it.** Open `http://localhost:3000/api/health`. If it reports ComfyUI unreachable, check `COMFY_HTTP_URL` and `NEXT_PUBLIC_COMFY_WS_BASE` in `.env.local` and restart `npm run dev` (Next.js reads env files at startup). For a ComfyUI on another machine, forward its port over SSH (`ssh -N -L 8188:127.0.0.1:8188 <gpu-host>`) and keep the defaults, or start it with `--listen 0.0.0.0` on a trusted network only.

**A tool card is disabled.** The card names what is missing. Missing model files: compare against [docs/models.md](models.md); the file name and subfolder must match exactly (`loras/edit_tools/...`, not `loras/...`). Missing node classes: `GET /api/health?nodes=1` lists them; install the pack from [docs/custom-nodes.md](custom-nodes.md) and restart ComfyUI. Cards from optional packs (MiniMax H3, SeFi-Image) stay disabled until that pack is installed.

**`scripts/start-comfyui.sh` says no ComfyUI was found.** Set `COMFY_ROOT` to the folder that holds ComfyUI's `main.py` (`COMFY_DIR` still works). The script runs `venv/bin/python` or `.venv/bin/python` inside it. Create that virtualenv inside the ComfyUI folder and install ComfyUI's requirements into it, or start ComfyUI by hand from its folder and virtualenv: `python main.py --listen 127.0.0.1 --port 8188 --enable-cors-header http://localhost:3000`.

**Out of memory on the GPU.** Use the GGUF or fp8 variant of the model (see the quantization note in [docs/models.md](models.md)), start ComfyUI with `--reserve-vram 1` or `--lowvram`, and run one video job at a time. Per-tool VRAM ballparks are in [docs/TOOLS.md](TOOLS.md).

**Apple Silicon: a model fails to load, or video comes out black.** MPS has no fp8 support, so load the bf16 or GGUF files. For black video frames, run a second, video-only ComfyUI in fp32 with `CJ_VIDEO_FP32=1 COMFY_PORT=8189 COMFY_ROOT=/path/to/ComfyUI scripts/start-comfyui.sh` (fp32 applies to that whole instance, so keep image work on the default one). Then set `COMFY_VIDEO_HTTP_URL=http://127.0.0.1:8189` in `.env.local` and list the actions to send there in `COMFY_VIDEO_ACTIONS` (see `.env.example`).

**Video Translator fails at the transcription step.** The whisper ASR node (`cj_whisper_asr`) in `public/workflows/packs/audio/dub_transcribe.json` looks for `whisper/whisper-large-v3-turbo` under ComfyUI's `stt` model folder (`models/stt/` plus any `stt:` entry in `extra_model_paths.yaml`). Put the checkpoint there, or set `model_path` to an absolute folder.

**Installing dependencies fails while building `better-sqlite3`.** Use a Node.js LTS release, which has prebuilt binaries. Otherwise add a C++ toolchain (Xcode Command Line Tools on macOS, `build-essential` on Linux, Visual Studio Build Tools on Windows) and retry.

**`npm run build` fails on Windows.** It sets an environment variable with POSIX shell syntax. Use `npm run build:deploy` (a plain `next build`), or build from Git Bash or WSL.

**The overlay inside ComfyUI shows a blank frame.** Adrift only allows itself to be framed by ComfyUI on ports 8188 and 8000. For another port, start Adrift with `CJ_FRAME_ANCESTORS` set to that ComfyUI origin, for example `CJ_FRAME_ANCESTORS="http://localhost:9999" npm run dev`.

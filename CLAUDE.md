# Adrift: guide for AI coding agents

You are helping someone install or use **Adrift**, a self-hosted creative studio
(image, edit, video, audio, 3D tools) that runs on top of their own
[ComfyUI](https://github.com/Comfy-Org/ComfyUI). Adrift is a Next.js web app;
ComfyUI does the GPU work. Adrift ships no model weights.

Talk to the user in plain language. Many users are not developers. Ask before
anything that downloads gigabytes, installs software, or changes their system.

## Install: the short path

1. **Check tools:** Node.js 20+ and git. Python 3.10–3.13 only if ComfyUI must
   be installed too. Check the GPU: `nvidia-smi` (NVIDIA) or Apple Silicon.
2. **Ask where ComfyUI is.** Three cases:
   - Already installed locally: `./install.sh --comfy /path/to/ComfyUI`
   - Not installed: `./install.sh --install-comfy` (about 6 GB, needs Python)
   - On another machine: `./install.sh --no-comfy`, then forward its port
     with `ssh -N -L 8188:127.0.0.1:8188 <gpu-box>`
     Windows: `install.cmd` with `-Comfy`, `-InstallComfy`, `-NoComfy`.
     Preview first with `--dry-run`. Re-running is safe.
3. **Start:** `./adrift` (Windows: `adrift.cmd`). It starts ComfyUI and the app
   and opens the setup wizard at `http://127.0.0.1:3000`.
4. **Models:** let the wizard pick a set, or use the CLI. It only plans until
   you pass `--yes`:
   - `node scripts/fetch-models.mjs --set starter` (~11 GB, a good first run)
   - `node scripts/fetch-models.mjs --tool <id>` (one tool; `--list-tools`)
   - `--set minimal` is ~272 GB and `--set full` ~954 GB: confirm disk space
     and get the user's explicit OK before either.

No GPU, or just looking around: `./install.sh --no-comfy --no-build --yes`
then `./adrift --mock` (fake ComfyUI, opens on port 3100).

## Hardware (rough)

- NVIDIA 24 GB (3090/4090): almost every tool.
- NVIDIA 12–16 GB: image, edit, upscale, audio and lighter video tools.
- Apple Silicon: bf16/GGUF weights only. MPS cannot load `fp8` files, so skip them.
  Per-tool VRAM is in `docs/TOOLS.md`.

## Rules for agents

- **Never expose ports.** Adrift and ComfyUI bind `127.0.0.1`. ComfyUI has
  no login. For remote access use SSH or a VPN, never port-forwarding on the
  router or `0.0.0.0` without `ADMIN_API_KEY` set (see `SECURITY.md`).
- Do not commit or print `.env.local`; it can hold API keys (Civitai, HF).
- Some models have gated Hugging Face pages or non-commercial licenses.
  `MODELS.md` lists each license; tell the user before fetching NC weights.
- Custom node packs: `./install.sh --packs` installs the pinned set
  (`docs/custom-nodes.md`). Don't install unpinned packs without asking.

## When something breaks

- Start with `docs/SETUP.md#troubleshooting`.
- `GET http://127.0.0.1:3000/api/health?nodes=1` reports missing ComfyUI nodes;
  `GET /api/tools/model-status` reports missing model files per tool.
- WebSocket 403 from ComfyUI: start it with `--enable-cors-header`
  (`scripts/start-comfyui.sh` does this).
- A disabled tool card means a missing model or node, not a bug. Fetch it with
  `fetch-models.mjs --tool <id>`.
- Black video on Apple Silicon: see Troubleshooting (fp32 ComfyUI instance).

## Repo map

- `src/`: web app (Next.js 15, React 18, Zustand, SQLite in `data/`)
- `public/workflows/packs/<pack>/*.json`: every tool's ComfyUI graph (API format)
- `comfy_nodes/`: Adrift's own ComfyUI nodes, plus `adrift_overlay` (opens
  Adrift inside ComfyUI with Ctrl+Shift+J)
- `scripts/`: installer helpers, model fetcher, launcher, mock ComfyUI
- `docs/`: `SETUP.md` (full reference), `TOOLS.md`, `models.md`, `HIGGSFIELD.md`
- `models/download-list.md`: every pinned file with its size and URL

## Developing

`npm run dev` · `npm run type-check` · `npm run test:run`.
`docs/TOOLS.md` and `docs/models.md` are generated: run `npm run docs:tools` /
`npm run docs:models` after changing a workflow graph.

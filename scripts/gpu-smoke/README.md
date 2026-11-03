# GPU smoke runner

Checks every tool that `docs/HIGGSFIELD.md` still lists as not
GPU-checked, in one queue, with tiny inputs. The card names come from
`docs/TOOLS.md`.

| File                   | Role                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manifest.ts`          | Entries (tool/action, minimal params, expected output kind), deferred multi-step items, parity pending-line scan                                 |
| `assets.ts`            | Procedural inputs: gradient / shapes PNGs, an RGBA sticker, a 2 s speech-like tone WAV and a 1 s 256x256 clip (ffmpeg muxes the clip). No photos |
| `build.ts`             | Builds each graph through the same functions as `/api/jobs/action` and `/api/jobs/tool`                                                          |
| `cli.ts`               | Flags and the `--run` guard                                                                                                                      |
| `run.ts` / `runner.ts` | Entry point and runner body                                                                                                                      |

## Dry run (default, safe at any time)

This only sends `GET /object_info`. It builds every graph, bypasses missing
optional nodes, and validates the result (missing node classes, model files
not in the combo lists, broken links).

```sh
cd adrift
./node_modules/.bin/vite-node --config vitest.config.ts scripts/gpu-smoke/run.ts \
  --dry-run --comfy http://127.0.0.1:8188
```

The status of each entry is one of these:

- `ok`: valid.
- `invalid`: needs fixing before the GPU window.
- `build_error`: the builder threw.
- `blocked`: the entry already has a `blockedBy` marker and failed as expected.

The exit code is 1 if any entry is `invalid` or `build_error`.

## GPU window (`--run`)

`--run` refuses to start unless `ADRIFT_GPU_OK=1` is set. When it runs, it:

1. Writes the assets.
2. Uploads them to `input/adrift_smoke/`.
3. Takes the entries one at a time, lightest first with the MiniMax H3 ones last. For each entry it:
   - waits for an empty `/queue`;
   - sends `POST /prompt`, the same `queuePrompt` call the app makes;
   - polls `/history/<id>`.

Each entry gets one JSONL record: pass, fail, fatal or skipped, with the run time and output paths.

The run stops at the first of these:

- an Xid, CUDA, OOM or GSP-style error;
- ComfyUI becoming unreachable;
- a timeout;
- a queue that someone else keeps busy.

It never calls `/interrupt` or `/free`.

```sh
ADRIFT_GPU_OK=1 ./node_modules/.bin/vite-node --config vitest.config.ts \
  scripts/gpu-smoke/run.ts --run --comfy http://127.0.0.1:8188 --out /tmp/adrift-gpu-smoke
```

Optional flags:

- `--only action.dub,tool.` and `--skip <ids>` select entries by prefix.
- `--source clip=tests/street.mp4@1280x720:3` swaps a procedural source for a
  file already in ComfyUI's `input/` (size and seconds optional). The synthetic
  assets prove a graph runs; semantic tools (remove person / text / object)
  need real footage before anything counts as quality-checked.
- `--param "action.video_object_remove:target=red car"` overrides one entry
  param (numbers and true/false are coerced) to match that footage.
- `--skip-heavy` leaves out the H3 entries.
- `--include-blocked` also queues entries whose weights are marked missing.

Before a run on the 4090 host, check the driver/torch pin and keep the Xid
watchdog running.

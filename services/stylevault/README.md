# StyleVault service

The local server behind the Map, Clusters, Images and Train views on Adrift's Styles page. It scans a folder of images, embeds them, groups them into clusters, projects them onto a 2D map, and serves search, tags, ratings and thumbnails. Everything stays on your machine.

Requires Python 3.11 or newer. Run these from the repository root.

## Setup

    bash scripts/stylevault.sh setup

This creates `services/stylevault/.venv` and installs the package and its dependencies, including torch.

## Start

    bash scripts/stylevault.sh start

The server listens on http://127.0.0.1:8000. Adrift finds it through `STYLEVAULT_API_URL`, which defaults to that address.

The server only indexes folders under `STYLEVAULT_ALLOWED_ROOTS` (separate paths with `:` or `,`). If that is not set, `start` uses `CJ_VAULT_DATASET_ROOTS`, `COMFYUI_OUTPUT_DIR` and Adrift's data folder from your environment or `.env.local`. It only answers requests for `localhost`, `127.0.0.1` and `::1`, and refuses requests from other sites.

## Index

    bash scripts/stylevault.sh index /path/to/images

If the server is running this sends it the job, otherwise it runs here. Run it again after adding images: known files are skipped, and clusters and the map are rebuilt.

The first index downloads the SigLIP2 embedder (`google/siglip2-base-patch16-256`) from Hugging Face. Set `STYLEVAULT_EMBEDDER=color-histogram` to skip the download and group by color only.

## Settings

| Name                                 | Default                        | What it does                                      |
| ------------------------------------ | ------------------------------ | ------------------------------------------------- |
| `STYLEVAULT_HOME`                    | `~/.adrift/stylevault`         | Database, thumbnails, exports, model cache        |
| `STYLEVAULT_CONFIG`                  | `$STYLEVAULT_HOME/config.toml` | Optional settings file                            |
| `STYLEVAULT_ALLOWED_ROOTS`           | none                           | Folders that may be indexed or trained from       |
| `STYLEVAULT_ALLOWED_HOSTS`           | none                           | Extra host names it answers to, comma-separated   |
| `STYLEVAULT_EMBEDDER`                | `siglip2`                      | Embedder for indexing                             |
| `STYLEVAULT_COMFYUI_PATH`            | none                           | ComfyUI folder, for output ingest and LoRA deploy |
| `STYLEVAULT_HOST`, `STYLEVAULT_PORT` | `127.0.0.1`, `8000`            | Where `start` listens                             |

## Training

Training runs an external trainer you install yourself (ai-toolkit, musubi-tuner or sd-scripts). Point to it in `config.toml`:

    [trainers.adapters."ai-toolkit"]
    path_to_repo = "/path/to/ai-toolkit"
    python_bin = "/path/to/ai-toolkit/.venv/bin/python"

Config templates are in `trainer_templates/`. The musubi-tuner Krea 2 template needs your local model paths filled in.

## Tests

    pip install -e ".[dev]"
    pytest

## License

MIT, same as Adrift. See `LICENSE`.

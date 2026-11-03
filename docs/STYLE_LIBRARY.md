# Style library

The Styles page has six views: Browse, Datasets, Map, Clusters, Images and Train.

| View | What it does | Needs the service |
| ---- | ------------ | ----------------- |
| Browse | Browses your style collections | No |
| Datasets | Builds dataset boards, and trains a LoRA from one with the local trainer | No |
| Map | Plots your indexed images so similar ones sit close together | Yes |
| Clusters | Lists the groups of similar images it found, with their images | Yes |
| Images | Lists your indexed images and searches their file names, captions and tags | Yes |
| Train | Trains a LoRA from a cluster or a folder. Uses the service when it has a trainer installed, and the local trainer otherwise, with no Style Cluster mode or auto-caption | No |

The local trainer is set up in **Settings → Training** (see
[Training LoRAs](SETUP.md#training-loras)).

The service is a separate, optional Python program in `services/stylevault`.
`./install.sh` does not install it. It runs on your computer and listens on
`127.0.0.1:8000`.

## Set it up

Run these from the repository root.

```bash
scripts/stylevault.sh setup            # create its Python environment and install its dependencies
scripts/stylevault.sh start            # run the service; leave it running
scripts/stylevault.sh index /path/to/images   # scan, embed, cluster and map a folder
```

Indexing runs in the background, one folder at a time. To index from a script
instead, send `POST /library/index` with `{"folder": "/path/to/images"}` and read
progress from `GET /library/index/status`.

Adrift finds the service at `http://127.0.0.1:8000` without any setting.

## Which folders can be indexed

A folder sent from the Styles page has to pass both checks:

- **Adrift** refuses a folder unless it sits under `CJ_VAULT_DATASET_ROOTS` or is
  ComfyUI's output folder. Set the variable in `.env.local` and restart Adrift.
- **The service** refuses a folder unless it sits under its own
  `STYLEVAULT_ALLOWED_ROOTS`. When that is unset, `scripts/stylevault.sh start`
  fills it from `CJ_VAULT_DATASET_ROOTS` and the ComfyUI output folder, reading
  the shell and `.env.local`. It does not see folders saved in Adrift's Settings,
  so set the variable yourself if you moved the output folder there.

```bash
# .env.local
CJ_VAULT_DATASET_ROOTS=/path/to/images
```

## First index downloads a model

The default embedder is SigLIP 2
([google/siglip2-base-patch16-256](https://huggingface.co/google/siglip2-base-patch16-256),
Apache-2.0). The service downloads it from Hugging Face on the first index, about
1.5 GB. Nothing is downloaded at setup or at start, and your images stay on your
computer.

`STYLEVAULT_EMBEDDER=color-histogram` needs no download. It groups images by
colour only, so it is much less useful than SigLIP 2.

Quality scores use a simple heuristic with no model weights.

## Settings

| Variable | Read by | What it does |
| -------- | ------- | ------------ |
| `STYLEVAULT_API_URL` | Adrift | Where Adrift finds the service. Leave it unset for the default address. Setting it, even to the default, also sends training from Datasets to the service and shows Describe and the auto-sort and auto-caption buttons. |
| `CJ_VAULT_DATASET_ROOTS` | Adrift | Folders it may send to the service to index or train from. |
| `STYLEVAULT_HOME` | Service | Folder for its database, config and downloaded model. |
| `STYLEVAULT_EMBEDDER` | Service | `siglip2` (default) or `color-histogram`. |
| `STYLEVAULT_ALLOWED_ROOTS` | Service | Folders it may index or train from. `scripts/stylevault.sh start` fills it from `CJ_VAULT_DATASET_ROOTS`, the ComfyUI output folder and Adrift's data folder when it is unset. |
| `STYLEVAULT_ALLOWED_HOSTS` | Service | Extra host names it answers to, comma-separated. It only answers `localhost`, `127.0.0.1` and `::1` otherwise, and refuses requests from other sites. |
| `STYLEVAULT_COMFYUI_PATH` | Service | ComfyUI folder that finished LoRAs are deployed into (`models/loras`). `scripts/stylevault.sh start` sets it from `COMFY_ROOT` or `../ComfyUI` when that folder exists. It ignores `COMFY_MODELS_DIR`. |

## Dependencies

`scripts/stylevault.sh setup` installs these and what they depend on. PyTorch is
a large download.

| Package | License |
| ------- | ------- |
| typer | MIT |
| fastapi | MIT |
| uvicorn | BSD-3-Clause |
| pillow | MIT-CMU |
| numpy | BSD-3-Clause, plus bundled third-party licenses |
| hdbscan | BSD-3-Clause |
| umap-learn | BSD-3-Clause |
| huggingface_hub | Apache-2.0 |
| safetensors | Apache-2.0 |
| torch | BSD-3-Clause, plus bundled third-party licenses |
| transformers | Apache-2.0 |

`open-clip-torch` (MIT) is optional, in the `text-detection` extra, and setup does not install it.

## Training through the service

The Train view uses the service only when the service has a trainer installed. Otherwise it uses the local trainer from **Settings → Training**, and jobs from both show in one list. Style Cluster mode and auto-caption need a trainer in the service; the local trainer takes an image folder only. To give the service a trainer, see Training in [`services/stylevault/README.md`](../services/stylevault/README.md).

## When the service is off

Map, Clusters and Images say the service is offline and show the commands to start it. Train switches to the local trainer. The rest of Adrift keeps working.

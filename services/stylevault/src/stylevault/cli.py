from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import typer

from PIL import Image

from stylevault import db
from stylevault.config import (
    DEFAULT_CONFIG,
    DEFAULT_CONFIG_TOML,
    default_config_path,
    load_config,
    resolve_config_paths,
    validate_config,
)
from stylevault.db import init_db
from stylevault.captions import CAPTION_TYPES, caption_assets, get_caption_model
from stylevault.clustering import (
    assign_assets_to_cluster_run,
    run_hdbscan_clustering,
    run_recursive_hdbscan_clustering,
)
from stylevault.curation import add_tags, apply_file_actions, remove_tags, undo_manifest
from stylevault.embeddings import (
    embed_assets,
    get_embedding_model,
    load_embedding_head,
    register_embedding_head,
    train_embedding_head,
)
from stylevault.export import export_assets_by_tag, export_cluster_run
from stylevault.incremental import run_incremental_update
from stylevault.knn_graph import build_fused_knn_graph
from stylevault.model_cache import configure_model_cache, download_hf_models
from stylevault.omnitag import OmniTagSettings, get_omnitag_model, run_omnitag_mode
from stylevault.scan import scan_directory
from stylevault.scores import get_score_model, score_assets
from stylevault.text_detection import detect_text_assets
from stylevault.umap_projection import build_umap_projection
from stylevault.vector_store import build_vector_store, sync_vector_store
from stylevault.run_logging import (
    DEFAULT_LOG_LIBRARIES,
    build_run_log_payload,
    build_runtime_environment,
    caption_model_metadata,
    embedding_model_metadata,
    score_model_metadata,
)
from stylevault.trainers import (
    build_dataset_manifest,
    build_train_plan,
    build_trainer_routes,
    collect_artifacts,
    diagnose_trainers,
    find_adapter,
    load_known_good_matrix,
    load_trainer_adapters,
    lock_trainers,
    run_train,
    supported_model_families,
    update_trainers,
)

app = typer.Typer(help="StyleVault command line interface.")
config_app = typer.Typer(help="Inspect and validate StyleVault configuration.")
logs_app = typer.Typer(help="Inspect StyleVault run logs.")
db_app = typer.Typer(help="Inspect and migrate the StyleVault database.")
models_app = typer.Typer(help="Manage model downloads and caches.")
trainers_app = typer.Typer(help="Inspect trainer adapter configuration.")
lora_app = typer.Typer(help="Run LoRA training workflows.")
style_app = typer.Typer(help="High-level style workflows.")
app.add_typer(config_app, name="config")
app.add_typer(logs_app, name="logs")
app.add_typer(db_app, name="db")
app.add_typer(models_app, name="models")
app.add_typer(trainers_app, name="trainers")
app.add_typer(lora_app, name="lora")
app.add_typer(style_app, name="style")


@dataclass(frozen=True)
class DoctorCheck:
    name: str
    status: str
    detail: str
    fix: str | None = None


def write_run_log(logs_dir: Path, prefix: str, payload: dict[str, object]) -> Path:
    logs_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log_path = logs_dir / f"{prefix}-{timestamp}.json"
    counter = 1
    while log_path.exists():
        log_path = logs_dir / f"{prefix}-{timestamp}-{counter}.json"
        counter += 1
    log_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return log_path


def _load_run_log(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Invalid log file: {error}") from error
    if not isinstance(payload, dict):
        raise ValueError("Log file must contain a JSON object.")
    if "command" not in payload or "run" not in payload:
        raise ValueError("Log file missing required fields.")
    return payload


def _summarize_run_log(payload: dict[str, object]) -> dict[str, object]:
    run = payload.get("run") if isinstance(payload, dict) else {}
    run = run if isinstance(run, dict) else {}
    return {
        "command": payload.get("command") if isinstance(payload, dict) else None,
        "started_at": run.get("started_at"),
        "ended_at": run.get("ended_at"),
        "elapsed_seconds": run.get("elapsed_seconds"),
    }


def format_coverage(total: int, missing: int) -> str:
    total = max(0, int(total))
    missing = max(0, int(missing))
    covered = max(0, total - missing)
    if total == 0:
        return "0/0 (0.0%)"
    percent = (covered / total) * 100
    return f"{covered}/{total} ({percent:.1f}%)"


def resolve_embedding_models(settings: dict, requested: list[str] | None) -> list[str]:
    if requested:
        return list(dict.fromkeys(requested))
    embeddings_cfg = settings.get("embeddings", {})
    models: list[str] = []
    configured = embeddings_cfg.get("models")
    if isinstance(configured, list):
        models.extend(str(name) for name in configured if name)
    else:
        fusion_weights = settings.get("fusion", {}).get("weights", {})
        if isinstance(fusion_weights, dict) and fusion_weights:
            models.extend(str(name) for name in fusion_weights.keys() if name)
            return list(dict.fromkeys(models))
        primary = embeddings_cfg.get("primary_model")
        secondary = embeddings_cfg.get("secondary_model")
        if primary:
            models.append(str(primary))
        if secondary:
            models.append(str(secondary))
    return list(dict.fromkeys(models)) or ["color-histogram"]


def resolve_caption_models(settings: dict, requested: list[str] | None) -> list[str]:
    if requested:
        return list(dict.fromkeys(requested))
    captions_cfg = settings.get("captions", {})
    configured = captions_cfg.get("models")
    if isinstance(configured, list) and configured:
        return list(dict.fromkeys(str(name) for name in configured if name))
    return ["filename"]


def resolve_caption_types(settings: dict, requested: list[str] | None) -> list[str]:
    if requested:
        types = [str(value).lower() for value in requested if value]
    else:
        configured = settings.get("captions", {}).get("types")
        if isinstance(configured, list) and configured:
            types = [str(value).lower() for value in configured if value]
        else:
            types = ["long", "short", "tags"]
    for caption_type in types:
        if caption_type not in CAPTION_TYPES:
            raise ValueError(f"Unknown caption type: {caption_type}")
    return list(dict.fromkeys(types))


def resolve_score_models(settings: dict, requested: list[str] | None) -> list[str]:
    if requested:
        return list(dict.fromkeys(requested))
    configured = settings.get("scores", {}).get("models")
    if isinstance(configured, list) and configured:
        return list(dict.fromkeys(str(name) for name in configured if name))
    return ["aesthetic-simple"]


def _require_db(db_path: Path) -> None:
    """Exit cleanly when the vault DB hasn't been created yet (instead of a sqlite traceback
    or silently creating an empty vault.sqlite)."""
    if not db_path.exists():
        typer.echo(f"Database not found at {db_path}. Run `stylevault init` first.", err=True)
        raise typer.Exit(code=1)


def resolve_fusion_models(
    settings: dict,
    models: list[str] | None,
    weights: list[float] | None,
) -> tuple[list[str], dict[str, float]]:
    """Resolve fused-embedding models and their weights as ``{model: weight}``.

    fusion/knn_graph/clustering/umap all take ``weights: dict[str, float]``; handing them
    the positional list made every CLI knn-graph/cluster/cluster-tree/umap run fail with
    "Missing fusion weights" (membership test against a list of floats).
    """
    resolved_models, resolved_weights = _resolve_fusion_model_list(settings, models, weights)
    return resolved_models, dict(zip(resolved_models, resolved_weights))


def _resolve_fusion_model_list(
    settings: dict,
    models: list[str] | None,
    weights: list[float] | None,
) -> tuple[list[str], list[float]]:
    if models:
        unique_models = list(dict.fromkeys(models))
        if weights:
            if len(weights) != len(unique_models):
                raise ValueError("--weight must match the number of --model entries.")
            return unique_models, [float(value) for value in weights]
        configured_weights = settings.get("fusion", {}).get("weights", {})
        if configured_weights:
            resolved = []
            resolved_weights = []
            for name in unique_models:
                if name in configured_weights:
                    resolved.append(name)
                    resolved_weights.append(float(configured_weights[name]))
            if len(resolved) == len(unique_models):
                return resolved, resolved_weights
        return unique_models, [1.0 for _ in unique_models]
    if weights:
        raise ValueError("--weight requires at least one --model.")
    configured_weights = settings.get("fusion", {}).get("weights", {})
    if configured_weights:
        models = list(configured_weights.keys())
        return models, [float(configured_weights[name]) for name in models]
    models = resolve_embedding_models(settings, None)
    return models, [1.0 for _ in models]


def _collect_hf_model_ids(settings: dict) -> list[str]:
    model_ids: list[str] = []
    embed_models = resolve_embedding_models(settings, None)
    if "siglip2" in embed_models:
        model_ids.append("google/siglip2-base-patch16-256")
    caption_models = resolve_caption_models(settings, None)
    if "blip" in caption_models:
        model_ids.append("Salesforce/blip-image-captioning-base")
    return list(dict.fromkeys(model_ids))


@models_app.command("huggingface")
def models_huggingface(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Download or check Hugging Face models required by the current config."""
    settings = load_config(config)
    configure_model_cache(settings, config)
    model_ids = _collect_hf_model_ids(settings)
    if not model_ids:
        typer.echo("No Hugging Face models configured for download.")
        raise typer.Exit()
    results = download_hf_models(model_ids, settings, config)
    for result in results:
        model_id = result["model_id"]
        status = result["status"]
        path = result.get("path") or ""
        if path:
            typer.echo(f"{model_id}: {status} ({path})")
        else:
            typer.echo(f"{model_id}: {status}")


@trainers_app.command("list")
def trainers_list(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """List configured trainer adapters and routes."""
    settings = load_config(config)
    adapters = load_trainer_adapters(settings, config)
    routes = build_trainer_routes(settings)
    if not adapters:
        typer.echo("No trainer adapters configured.")
        return
    typer.echo("Trainer adapters:")
    for adapter in adapters:
        status = "installed" if adapter.exists else "missing"
        version = f" ({adapter.version})" if adapter.version else ""
        path = str(adapter.path) if adapter.path else "unset"
        python_bin = str(adapter.python_bin) if adapter.python_bin else "default"
        families = supported_model_families(routes, adapter.name)
        typer.echo(f"- {adapter.name}: {status}{version}")
        typer.echo(f"  repo: {path}")
        typer.echo(f"  python: {python_bin}")
        if families:
            typer.echo(f"  families: {', '.join(families)}")
    if routes:
        typer.echo("")
        typer.echo("Trainer routing:")
        for model_family, route in routes.items():
            trainer = route.get("trainer") or "unset"
            entrypoint = route.get("entrypoint") or "unset"
            typer.echo(f"- {model_family}: {trainer} ({entrypoint})")


@trainers_app.command("doctor")
def trainers_doctor(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Validate trainer adapter paths and routing entrypoints."""
    settings = load_config(config)
    adapters = load_trainer_adapters(settings, config)
    routes = build_trainer_routes(settings)
    issues = diagnose_trainers(adapters, routes)
    if issues:
        typer.echo("Trainer configuration issues detected:")
        for issue in issues:
            typer.echo(f"- {issue}")
        raise typer.Exit(code=1)
    typer.echo("Trainer configuration looks healthy.")


@trainers_app.command("lock")
def trainers_lock(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Record trainer repo commits/tags into trainer-lock.json."""
    settings = load_config(config)
    adapters = load_trainer_adapters(settings, config)
    lock_path = lock_trainers(adapters, settings, config)
    typer.echo(f"Wrote trainer lock to {lock_path}.")


@trainers_app.command("update")
def trainers_update(
    trainer: list[str] = typer.Option(
        None,
        "--trainer",
        "-t",
        help="Only update the named trainer(s).",
    ),
    relock: bool = typer.Option(
        True,
        "--relock/--no-relock",
        help="Update trainer-lock.json after pulling.",
    ),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Pull trainer repos (fast-forward only) and optionally refresh the lock file."""
    settings = load_config(config)
    adapters = load_trainer_adapters(settings, config)
    trainer_names = {name for name in trainer or [] if name}
    results = update_trainers(adapters, trainer_names or None)
    for name, status in results.items():
        typer.echo(f"{name}: {status}")
    if relock:
        lock_path = lock_trainers(adapters, settings, config)
        typer.echo(f"Wrote trainer lock to {lock_path}.")


@trainers_app.command("matrix")
def trainers_matrix() -> None:
    """Show the known-good trainer compatibility matrix."""
    matrix = load_known_good_matrix()
    if not matrix:
        typer.echo("No known-good trainer matrix data available.")
        raise typer.Exit(code=1)
    typer.echo("Known-good trainer compatibility matrix:")
    trainers = matrix.get("trainers", {})
    if not trainers:
        typer.echo("No trainers listed.")
        return
    for name, payload in trainers.items():
        payload = payload if isinstance(payload, dict) else {}
        repo = payload.get("repo") or ""
        pinned_commit = payload.get("pinned_commit") or ""
        pinned_tag = payload.get("pinned_tag") or ""
        tested = payload.get("tested_model_families") or []
        notes = payload.get("notes") or ""
        typer.echo(f"- {name}")
        if repo:
            typer.echo(f"  repo: {repo}")
        if pinned_commit or pinned_tag:
            pinned = pinned_commit or pinned_tag
            typer.echo(f"  pinned: {pinned}")
        if tested:
            tested_list = ", ".join(str(item) for item in tested)
            typer.echo(f"  tested: {tested_list}")
        if notes:
            typer.echo(f"  notes: {notes}")


@lora_app.command("dataset-export")
def lora_dataset_export(
    image: list[Path] = typer.Option(
        ..., "--image", "-i", exists=True, help="Source images for dataset export."
    ),
    model_family: str = typer.Option(..., help="Target model family for training."),
    cluster_id: int | None = typer.Option(None, help="Optional source cluster id."),
    output_dir: Path | None = typer.Option(None, help="Dataset output directory."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Build a trainer-ready dataset manifest with symlinked assets."""
    settings = load_config(config)
    trainer_root = Path(settings.get("trainers", {}).get("default_output_dir", "trainers"))
    if not trainer_root.is_absolute():
        trainer_root = config.parent / trainer_root
    manifest_path = build_dataset_manifest(
        output_root=output_dir or (trainer_root / "datasets"),
        image_paths=image,
        model_family=model_family,
        cluster_id=cluster_id,
    )
    typer.echo(f"Wrote dataset manifest to {manifest_path}")


@lora_app.command("train")
def lora_train(
    model_family: str = typer.Option(..., help="Model family route (sdxl, flux1, etc)."),
    dataset_manifest: Path = typer.Option(..., exists=True, help="Dataset manifest path."),
    output_dir: Path | None = typer.Option(None, help="Directory for trainer outputs."),
    base_model: str | None = typer.Option(None, help="Base model path/id for this variant."),
    style_name: str | None = typer.Option(None, help="Optional style node name (defaults from cluster)."),
    cluster_id: int | None = typer.Option(None, help="Optional source cluster id for style node grouping."),
    dry_run: bool = typer.Option(True, "--dry-run/--run", help="Print/run training command."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Plan and run LoRA training through the configured trainer adapter."""
    settings = load_config(config)
    adapters = load_trainer_adapters(settings, config)
    routes = build_trainer_routes(settings)
    trainer_root = Path(settings.get("trainers", {}).get("default_output_dir", "trainers"))
    if not trainer_root.is_absolute():
        trainer_root = config.parent / trainer_root
    out_dir = output_dir or (trainer_root / "runs" / model_family)

    manifest_payload: dict[str, object] = {}
    try:
        parsed = json.loads(dataset_manifest.read_text(encoding="utf-8"))
        if isinstance(parsed, dict):
            manifest_payload = parsed
    except (OSError, json.JSONDecodeError):
        manifest_payload = {}
    manifest_cluster_id = manifest_payload.get("cluster_id")
    if isinstance(manifest_cluster_id, int) and cluster_id is None:
        cluster_id = manifest_cluster_id

    style_node_name = style_name or (
        f"style_cluster_{cluster_id:04d}" if cluster_id is not None else f"style_{model_family}"
    )

    plan = build_train_plan(
        settings=settings,
        config_path=config,
        adapters=adapters,
        routes=routes,
        model_family=model_family,
        dataset_manifest_path=dataset_manifest,
        output_dir=out_dir,
        base_model=base_model,
        dry_run=dry_run,
    )
    adapter = find_adapter(adapters, plan.trainer_name)
    if adapter is None:
        raise typer.Exit(code=1)

    typer.echo("Trainer plan:")
    typer.echo(f"- trainer: {plan.trainer_name}")
    typer.echo(f"- model_family: {plan.model_family}")
    typer.echo(f"- style_node: {style_node_name}")
    typer.echo(f"- command: {' '.join(plan.command)}")

    returncode, stdout, stderr = run_train(plan, adapter=adapter, dry_run=dry_run)
    status = "planned" if dry_run else ("success" if returncode == 0 else "failed")

    with db.connect(resolve_config_paths(settings, config)["db_path"]) as connection:
        run_id = db.insert_lora_training_run(
            connection,
            method="lora",
            trainer_name=plan.trainer_name,
            model_family=plan.model_family,
            base_model=base_model,
            status=status,
            command=plan.command,
            metadata={
                "stdout": stdout[-4000:],
                "stderr": stderr[-4000:],
                "style_node": style_node_name,
                "source_cluster_id": cluster_id,
            },
            dataset_manifest_path=str(dataset_manifest),
            config_path=(
                str(plan.rendered_config_path)
                if plan.rendered_config_path
                else (str(plan.config_path) if plan.config_path else None)
            ),
        )
        style_node_id = db.upsert_style_node(
            connection,
            style_name=style_node_name,
            source_cluster_id=cluster_id,
            metadata={"last_model_family": plan.model_family, "last_trainer": plan.trainer_name},
        )
        style_variant_name = f"{style_node_name}_{plan.model_family}_v{run_id}"
        db.upsert_style_variant(
            connection,
            style_node_id=style_node_id,
            run_id=run_id,
            model_family=plan.model_family,
            base_model=base_model,
            variant_name=style_variant_name,
            metadata={"status": status},
        )
        for artifact in collect_artifacts(out_dir):
            artifact_type = "weights" if artifact.suffix == ".safetensors" else "log"
            db.insert_lora_artifact(
                connection,
                run_id=run_id,
                artifact_type=artifact_type,
                path=str(artifact),
                metadata={"style_node_id": style_node_id},
            )
        connection.commit()

    typer.echo(f"Recorded LoRA run {run_id} with status '{status}'.")
    if stdout and not dry_run:
        typer.echo(stdout.strip())
    if stderr and not dry_run:
        typer.echo(stderr.strip())
    if not dry_run and returncode != 0:
        raise typer.Exit(code=returncode)


@lora_app.command("list")
def lora_list(
    limit: int = typer.Option(20, min=1, max=200),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """List tracked LoRA training runs from the StyleVault DB."""
    settings = load_config(config)
    db_path = resolve_config_paths(settings, config)["db_path"]
    _require_db(db_path)
    with db.connect(db_path) as connection:
        rows = db.fetch_lora_training_runs(connection, limit=limit)
    if not rows:
        typer.echo("No LoRA runs recorded.")
        return
    for row in rows:
        typer.echo(
            f"#{row['id']} {row['started_at']} {row['trainer_name']} "
            f"{row['model_family']} status={row['status']}"
        )


@style_app.command("train")
def style_train(
    method: str = typer.Option("lora", help="Training method. Only lora is supported."),
    model_family: str = typer.Option("sdxl", help="Model family for LoRA route."),
    dataset_manifest: Path | None = typer.Option(None, help="Dataset manifest for LoRA route."),
    base_model: str | None = typer.Option(None, help="Base model path/id for this variant."),
    style_name: str | None = typer.Option(None, help="Optional style node name override."),
    cluster_id: int | None = typer.Option(None, help="Optional source cluster id."),
    run: bool = typer.Option(False, "--run", help="Execute trainer instead of dry planning."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Unified high-level style training workflow."""
    if method != "lora":
        typer.echo("Unsupported method. Use lora.")
        raise typer.Exit(code=2)
    if dataset_manifest is None:
        typer.echo("--dataset-manifest is required for --method lora.")
        raise typer.Exit(code=2)
    ctx = typer.get_current_context()
    ctx.invoke(
        lora_train,
        model_family=model_family,
        dataset_manifest=dataset_manifest,
        output_dir=None,
        base_model=base_model,
        style_name=style_name,
        cluster_id=cluster_id,
        dry_run=not run,
        config=config,
    )


@style_app.command("list")
def style_list(
    limit: int = typer.Option(50, min=1, max=500),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """List style nodes and their model-family variants."""
    settings = load_config(config)
    db_path = resolve_config_paths(settings, config)["db_path"]
    _require_db(db_path)
    with db.connect(db_path) as connection:
        nodes = db.fetch_style_nodes(connection, limit=limit)
        if not nodes:
            typer.echo("No style nodes recorded.")
            return
        for node in nodes:
            typer.echo(f"[{node['id']}] {node['style_name']} cluster={node['source_cluster_id']}")
            variants = db.fetch_style_variants_for_node(connection, int(node["id"]))
            for variant in variants:
                typer.echo(
                    f"  - {variant['model_family']} base={variant['base_model'] or '-'} "
                    f"variant={variant['variant_name']} run={variant['run_id']}"
                )


def register_heads(settings: dict, config_path: Path) -> None:
    heads = settings.get("embeddings", {}).get("heads", [])
    if not heads:
        return
    for head_path in heads:
        path = Path(str(head_path))
        if not path.is_absolute():
            path = config_path.parent / path
        head = load_embedding_head(path)
        register_embedding_head(head)


def _doctor_check_torch(settings: dict, config_path: Path) -> list[DoctorCheck]:
    checks: list[DoctorCheck] = []
    if importlib.util.find_spec("torch") is None:
        checks.append(
            DoctorCheck(
                name="Torch",
                status="warn",
                detail="torch is not installed.",
                fix="python -m pip install torch",
            )
        )
        return checks
    import torch

    checks.append(
        DoctorCheck(
            name="Torch",
            status="ok",
            detail=f"torch {torch.__version__} available.",
        )
    )
    default_device = settings.get("trainers", {}).get("default_device", "cuda")
    if str(default_device).lower() != "cuda":
        checks.append(
            DoctorCheck(
                name="GPU",
                status="ok",
                detail=f"CUDA not required (default_device={default_device}).",
            )
        )
        return checks
    if torch.cuda.is_available():
        gpu_name = torch.cuda.get_device_name(0) if torch.cuda.device_count() else "CUDA available"
        checks.append(
            DoctorCheck(
                name="GPU",
                status="ok",
                detail=f"CUDA available ({gpu_name}).",
            )
        )
    else:
        checks.append(
            DoctorCheck(
                name="GPU",
                status="warn",
                detail="CUDA is not available for the configured default_device=cuda.",
                fix=(
                    f"Install a CUDA-enabled torch build or set trainers.default_device = \"cpu\" in {config_path}"
                ),
            )
        )
    return checks


def _doctor_check_database(config: Path, settings: dict) -> list[DoctorCheck]:
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    if not db_path.exists():
        return [
            DoctorCheck(
                name="Database",
                status="warn",
                detail=f"Database not found at {db_path}.",
                fix=f"stylevault init --config {config}",
            )
        ]
    try:
        with db.connect(db_path) as connection:
            version = db.get_schema_version(connection)
    except Exception as exc:  # noqa: BLE001
        return [
            DoctorCheck(
                name="Database",
                status="warn",
                detail=f"Failed to read schema version: {exc}",
                fix=f"stylevault db info --config {config}",
            )
        ]
    if version < db.SCHEMA_VERSION:
        return [
            DoctorCheck(
                name="Database",
                status="warn",
                detail=f"Schema version {version} is behind latest {db.SCHEMA_VERSION}.",
                fix=f"stylevault db migrate --config {config}",
            )
        ]
    if version > db.SCHEMA_VERSION:
        return [
            DoctorCheck(
                name="Database",
                status="warn",
                detail=f"Schema version {version} is newer than CLI expects ({db.SCHEMA_VERSION}).",
                fix=f"Upgrade StyleVault or run `stylevault db info --config {config}`.",
            )
        ]
    return [
        DoctorCheck(
            name="Database",
            status="ok",
            detail=f"Schema version {version} at {db_path}.",
        )
    ]


def _doctor_check_vector_store(settings: dict, config_path: Path) -> DoctorCheck:
    backend = settings.get("vector_store", {}).get("backend", "sqlite")
    backend = str(backend).lower()
    if backend not in {"sqlite", "faiss", "qdrant"}:
        return DoctorCheck(
            name="Vector store",
            status="warn",
            detail=f"Unknown backend '{backend}'.",
            fix=f"Update vector_store.backend in {config_path} to sqlite, faiss, or qdrant.",
        )
    if backend == "faiss" and importlib.util.find_spec("faiss") is None:
        return DoctorCheck(
            name="Vector store",
            status="warn",
            detail="FAISS backend selected but faiss is not installed.",
            fix="python -m pip install faiss-cpu",
        )
    if backend == "qdrant" and importlib.util.find_spec("qdrant_client") is None:
        return DoctorCheck(
            name="Vector store",
            status="warn",
            detail="Qdrant backend selected but qdrant-client is not installed.",
            fix="python -m pip install qdrant-client",
        )
    return DoctorCheck(
        name="Vector store",
        status="ok",
        detail=f"Backend '{backend}' available.",
    )


def _doctor_check_trainers(settings: dict, config_path: Path) -> list[DoctorCheck]:
    checks: list[DoctorCheck] = []
    adapters = load_trainer_adapters(settings, config_path)
    routes = build_trainer_routes(settings)
    issues = diagnose_trainers(adapters, routes)
    if not issues:
        checks.append(
            DoctorCheck(
                name="Trainers",
                status="ok",
                detail="Trainer adapter configuration looks healthy.",
            )
        )
        return checks
    for issue in issues:
        checks.append(
            DoctorCheck(
                name="Trainers",
                status="warn",
                detail=issue,
                fix=f"Edit {config_path} or run `stylevault trainers doctor --config {config_path}`.",
            )
        )
    return checks


@app.command("doctor")
def doctor(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Check local environment readiness for StyleVault workflows."""
    settings = load_config(config)
    checks: list[DoctorCheck] = []
    checks.extend(_doctor_check_torch(settings, config))
    checks.extend(_doctor_check_database(config, settings))
    checks.append(_doctor_check_vector_store(settings, config))
    checks.extend(_doctor_check_trainers(settings, config))

    typer.echo("StyleVault doctor report:")
    status_order = {"ok": "OK", "warn": "WARN", "error": "ERROR"}
    for check in checks:
        label = status_order.get(check.status, check.status.upper())
        typer.echo(f"[{label}] {check.name}: {check.detail}")
        if check.fix:
            typer.echo(f"  Fix: {check.fix}")


@config_app.command("init")
def config_init(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
    force: bool = typer.Option(False, "--force", "-f", help="Overwrite if file exists."),
) -> None:
    """Write a default config file."""
    if config.exists() and not force:
        typer.echo(f"Config already exists at {config}. Use --force to overwrite.")
        raise typer.Exit(code=1)

    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(DEFAULT_CONFIG_TOML, encoding="utf-8")
    typer.echo(f"Wrote default config to {config}")


@config_app.command("validate")
def config_validate(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Validate configuration values and report issues."""
    settings = load_config(config)
    errors, warnings = validate_config(settings, config)
    if warnings:
        typer.echo("Warnings:")
        for warning in warnings:
            typer.echo(f"- {warning}")
    if errors:
        typer.echo("Errors:")
        for error in errors:
            typer.echo(f"- {error}")
        raise typer.Exit(code=1)
    typer.echo("Config OK.")


@config_app.command("paths")
def config_paths(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
    as_json: bool = typer.Option(False, "--json", help="Output path details as JSON."),
) -> None:
    """Show resolved filesystem paths and their current state."""
    settings = load_config(config)
    resolved = resolve_config_paths(settings, config)
    entries: list[dict[str, str]] = []
    for key, path in resolved.items():
        if path.exists():
            status = "dir" if path.is_dir() else "file"
        else:
            status = "missing"
        entries.append(
            {
                "name": key,
                "path": str(path),
                "status": status,
            }
        )

    if as_json:
        typer.echo(json.dumps(entries, indent=2))
        return

    for entry in entries:
        typer.echo(f"{entry['name']}: {entry['path']} ({entry['status']})")


@db_app.command("info")
def db_info(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Show database schema version and location."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    if not db_path.exists():
        typer.echo(f"Database not found at {db_path}")
        raise typer.Exit(code=1)
    with db.connect(db_path) as connection:
        version = db.get_schema_version(connection)
    typer.echo(f"Database: {db_path}")
    typer.echo(f"Schema version: {version}")


@db_app.command("migrate")
def db_migrate(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview migrations without applying."),
) -> None:
    """Apply pending schema migrations."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    if not db_path.exists():
        typer.echo(f"Database not found at {db_path}")
        raise typer.Exit(code=1)
    with db.connect(db_path) as connection:
        current = db.get_schema_version(connection)
        if dry_run:
            typer.echo(f"Current schema version: {current}")
            typer.echo(f"Latest schema version: {db.SCHEMA_VERSION}")
            return
        applied = db.migrate_connection(connection)
    if applied:
        typer.echo(f"Applied migrations: {', '.join(applied)}")
    else:
        typer.echo("No migrations needed.")


@db_app.command("check")
def db_check(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
    fix: bool = typer.Option(False, "--fix", help="Apply recommended repairs."),
) -> None:
    """Check database pragmas and indexes."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    if not db_path.exists():
        typer.echo(f"Database not found at {db_path}")
        raise typer.Exit(code=1)
    with db.connect(db_path) as connection:
        issues, repairs = db.check_database(connection)
        if not issues:
            typer.echo("Database checks passed.")
            return
        typer.echo("Database checks found issues:")
        for issue in issues:
            typer.echo(f"- {issue}")
        if repairs:
            typer.echo("Recommended SQL repairs:")
            for statement in repairs:
                typer.echo(statement)
        if fix and repairs:
            for statement in repairs:
                connection.execute(statement)
            connection.commit()
            typer.echo("Repairs applied.")


@db_app.command("prune-missing")
def db_prune_missing(
    root: Path | None = typer.Option(
        None,
        help="Optional root directory to limit pruning to missing assets under it.",
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="Report missing assets only."),
    limit: int | None = typer.Option(None, help="Limit how many assets to prune."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Delete assets marked missing (and remove thumbnails/search index entries)."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    thumbs_dir = paths["thumbs_dir"]
    if not db_path.exists():
        typer.echo(f"Database not found at {db_path}")
        raise typer.Exit(code=1)
    root_prefix = None
    if root is not None:
        root_prefix = str(root.resolve())
        if not root_prefix.endswith(os.sep):
            root_prefix = f"{root_prefix}{os.sep}"
        root_prefix = f"{root_prefix}%"
    with db.connect(db_path) as connection:
        missing = db.fetch_missing_assets(connection, root_prefix=root_prefix, limit=limit)
        if dry_run:
            typer.echo(f"Missing assets: {len(missing)}")
            for asset in missing[:10]:
                typer.echo(f"- {asset['source_path']}")
            return
        for asset in missing:
            thumb_path = thumbs_dir / f"{asset['sha256']}.webp"
            if thumb_path.exists():
                thumb_path.unlink()
        deleted = db.delete_assets(connection, [int(asset["id"]) for asset in missing])
        connection.commit()
    typer.echo(f"Deleted {deleted} missing assets.")


@logs_app.command("list")
def logs_list(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
    limit: int = typer.Option(10, "--limit", "-n", min=1, help="Number of logs to show."),
    as_json: bool = typer.Option(False, "--json", help="Output log summary as JSON."),
) -> None:
    """List recent run logs with basic metadata."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    logs_dir = paths["logs_dir"]
    if not logs_dir.exists():
        typer.echo(f"Logs directory does not exist: {logs_dir}")
        raise typer.Exit(code=1)

    candidates = sorted(logs_dir.glob("*.json"), reverse=True)
    summaries: list[dict[str, object]] = []
    for path in candidates[:limit]:
        try:
            payload = _load_run_log(path)
        except ValueError as error:
            summaries.append(
                {
                    "path": str(path),
                    "error": str(error),
                }
            )
            continue
        summary = _summarize_run_log(payload)
        summary["path"] = str(path)
        summaries.append(summary)

    if as_json:
        typer.echo(json.dumps(summaries, indent=2))
        return

    for summary in summaries:
        if "error" in summary:
            typer.echo(f"{summary['path']}: {summary['error']}")
            continue
        typer.echo(
            f"{summary['path']}: {summary.get('command')} "
            f"started={summary.get('started_at')} elapsed={summary.get('elapsed_seconds')}"
        )


@logs_app.command("show")
def logs_show(
    log_name: str = typer.Argument("latest", help="Log filename or 'latest'."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Show a specific run log (pretty-printed JSON)."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    logs_dir = paths["logs_dir"]
    if not logs_dir.exists():
        typer.echo(f"Logs directory does not exist: {logs_dir}")
        raise typer.Exit(code=1)

    if log_name == "latest":
        candidates = sorted(logs_dir.glob("*.json"), reverse=True)
        if not candidates:
            typer.echo("No log files found.")
            raise typer.Exit(code=1)
        log_path = candidates[0]
    else:
        log_path = Path(log_name)
        if not log_path.is_absolute():
            log_path = logs_dir / log_name

    if not log_path.exists():
        typer.echo(f"Log file not found: {log_path}")
        raise typer.Exit(code=1)

    payload = _load_run_log(log_path)
    typer.echo(json.dumps(payload, indent=2, sort_keys=True))


@app.command()
def init(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Initialize the StyleVault data directories and SQLite database."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)

    data_dir = paths["data_dir"]
    db_path = paths["db_path"]
    thumbs_dir = paths["thumbs_dir"]
    exports_dir = paths["exports_dir"]
    logs_dir = paths["logs_dir"]
    indices_dir = paths["indices_dir"]
    models_dir = paths["models_dir"]

    for directory in [data_dir, thumbs_dir, exports_dir / "runs", logs_dir, indices_dir, models_dir]:
        directory.mkdir(parents=True, exist_ok=True)

    init_db(db_path)

    typer.echo(f"Initialized StyleVault at {data_dir}")


@app.command()
def scan(
    root: Path = typer.Argument(..., help="Root directory to scan for images."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
    thumb_size: int = typer.Option(512, help="Thumbnail size (square)."),
    exclude: list[str] | None = typer.Option(
        None,
        "--exclude",
        help="Glob pattern to exclude (repeatable).",
    ),
    workers: int | None = typer.Option(
        None,
        "--workers",
        help="Number of worker threads for hashing/thumbnails.",
    ),
    commit_every: int = typer.Option(
        500,
        "--commit-every",
        help="Commit after this many assets are updated.",
    ),
    dry_run: bool = typer.Option(
        False,
        "--dry-run",
        help="Preview scan results without writing to the database or thumbnails.",
    ),
    log_run: bool = typer.Option(
        False,
        "--log-run",
        help="Write a scan summary JSON file to the logs directory.",
    ),
) -> None:
    """Scan a directory, hash/dedupe assets, and generate thumbnails."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    scan_settings = settings.get("scan", DEFAULT_CONFIG["scan"])
    flag_settings = settings.get("flags", DEFAULT_CONFIG.get("flags", {}))
    exclude_globs = exclude if exclude is not None else scan_settings.get("exclude_globs", [])
    workers = workers or int(scan_settings.get("workers", 4))

    db_path = paths["db_path"]
    thumbs_dir = paths["thumbs_dir"]
    logs_dir = paths["logs_dir"]

    started_at = datetime.now(timezone.utc) if log_run else None
    stats = scan_directory(
        root,
        db_path,
        thumbs_dir,
        size=(thumb_size, thumb_size),
        exclude_globs=exclude_globs,
        dry_run=dry_run,
        workers=workers,
        commit_every=commit_every,
        small_min_width=flag_settings.get("small_image_min_width"),
        small_min_height=flag_settings.get("small_image_min_height"),
    )
    if log_run:
        ended_at = datetime.now(timezone.utc)
        payload = build_run_log_payload(
            command="scan",
            config_path=config,
            config_fallback=DEFAULT_CONFIG_TOML,
            started_at=started_at or ended_at,
            ended_at=ended_at,
            stats=stats,
            runtime=build_runtime_environment(DEFAULT_LOG_LIBRARIES),
            extra={
                "root": str(root),
                "config_path": str(config),
                "db_path": str(db_path),
                "thumbs_dir": str(thumbs_dir),
                "exclude_globs": exclude_globs,
                "thumb_size": thumb_size,
                "dry_run": dry_run,
                "workers": workers,
                "commit_every": commit_every,
            },
        )
        log_path = write_run_log(
            logs_dir,
            "scan",
            payload,
        )
        typer.echo(f"Wrote scan log to {log_path}")
    if dry_run:
        typer.echo(
            "Scan dry-run: "
            f"{stats['scanned']} scanned, "
            f"{stats['inserted']} new, "
            f"{stats['deduped']} deduped, "
            f"{stats['relocated']} relocated, "
            f"{stats['updated']} updated, "
            f"{stats['unchanged']} unchanged, "
            f"{stats['skipped']} skipped, "
            f"{stats['thumbs_needed']} thumbs needed."
        )
        return
    typer.echo(
        "Scan complete: "
        f"{stats['scanned']} scanned, "
        f"{stats['inserted']} inserted, "
        f"{stats['deduped']} deduped, "
        f"{stats['relocated']} relocated, "
        f"{stats['updated']} updated, "
        f"{stats['unchanged']} unchanged, "
        f"{stats['skipped']} skipped, "
        f"{stats['thumbs_created']} thumbs."
    )


@app.command()
def embed(
    model: str = typer.Option("color-histogram", help="Embedding model name."),
    limit: int | None = typer.Option(None, help="Max number of assets to embed."),
    batch_size: int = typer.Option(200, help="Number of assets to fetch per batch."),
    commit_every: int = typer.Option(500, help="Commit after this many embeddings."),
    shard_total: int = typer.Option(
        1, "--shard-total", help="Total number of shards for parallel embedding."
    ),
    shard_index: int = typer.Option(
        0, "--shard-index", help="Shard index for parallel embedding (0-based)."
    ),
    log_run: bool = typer.Option(
        False,
        "--log-run",
        help="Write an embedding summary JSON file to the logs directory.",
    ),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Embed assets that do not yet have the selected embedding."""
    settings = load_config(config)
    configure_model_cache(settings, config)
    register_heads(settings, config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    logs_dir = paths["logs_dir"]

    started_at = datetime.now(timezone.utc) if log_run else None
    embedding_model = get_embedding_model(model)
    if shard_total < 1 or shard_index < 0 or shard_index >= shard_total:
        raise typer.BadParameter("--shard-index must be between 0 and --shard-total - 1.")
    stats = embed_assets(
        db_path,
        embedding_model,
        limit=limit,
        batch_size=batch_size,
        commit_every=commit_every,
        shard_total=shard_total,
        shard_index=shard_index,
    )
    if log_run:
        ended_at = datetime.now(timezone.utc)
        payload = build_run_log_payload(
            command="embed",
            config_path=config,
            config_fallback=DEFAULT_CONFIG_TOML,
            started_at=started_at or ended_at,
            ended_at=ended_at,
            stats=stats,
            runtime=build_runtime_environment(DEFAULT_LOG_LIBRARIES, batch_size=1),
            models={"embeddings": embedding_model_metadata([model])},
            extra={
                "model": model,
                "config_path": str(config),
                "db_path": str(db_path),
                "limit": limit,
                "batch_size": batch_size,
                "commit_every": commit_every,
                "shard_total": shard_total,
                "shard_index": shard_index,
            },
        )
        log_path = write_run_log(logs_dir, "embed", payload)
        typer.echo(f"Wrote embed log to {log_path}")
    typer.echo(f"Embedded {stats['embedded']} assets. Skipped {stats['skipped']}.")


@app.command()
def train_head(
    labels: Path = typer.Option(..., help="CSV with asset_id,label columns."),
    head_name: str = typer.Option("default", help="Name for the embedding head."),
    base_model: str = typer.Option("color-histogram", help="Base embedding model."),
    output: Path = typer.Option(
        Path("heads/default.json"),
        help="Output path for the trained head JSON.",
    ),
    description: str | None = typer.Option(None, help="Optional head description."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Train a lightweight embedding head from labeled assets."""
    settings = load_config(config)
    register_heads(settings, config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]

    head = train_embedding_head(
        db_path=db_path,
        base_model_name=base_model,
        labels_path=labels,
        head_name=head_name,
        output_path=output,
        description=description,
    )
    typer.echo(f"Saved embedding head '{head.name}' to {output}.")


@app.command()
def caption(
    model: str = typer.Option("filename", help="Caption model name."),
    caption_type: str = typer.Option(
        "long",
        help="Caption type to generate: long, short, or tags.",
    ),
    limit: int | None = typer.Option(None, help="Max number of assets to caption."),
    tags: bool = typer.Option(True, help="Extract tags from generated captions."),
    overwrite: bool = typer.Option(False, help="Overwrite existing captions."),
    batch_size: int = typer.Option(200, help="Number of assets to fetch per batch."),
    commit_every: int = typer.Option(500, help="Commit after this many captions."),
    shard_total: int = typer.Option(
        1, "--shard-total", help="Total number of shards for parallel captioning."
    ),
    shard_index: int = typer.Option(
        0, "--shard-index", help="Shard index for parallel captioning (0-based)."
    ),
    log_run: bool = typer.Option(
        False,
        "--log-run",
        help="Write a captioning summary JSON file to the logs directory.",
    ),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Generate captions for assets and optionally extract tags."""
    settings = load_config(config)
    configure_model_cache(settings, config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    logs_dir = paths["logs_dir"]

    caption_type = caption_type.lower()
    prompt_template = (
        settings.get("captions", {})
        .get("prompts", {})
        .get(caption_type, DEFAULT_CONFIG["captions"]["prompts"].get(caption_type))
    )
    started_at = datetime.now(timezone.utc) if log_run else None
    caption_model = get_caption_model(model)
    if shard_total < 1 or shard_index < 0 or shard_index >= shard_total:
        raise typer.BadParameter("--shard-index must be between 0 and --shard-total - 1.")
    stats = caption_assets(
        db_path,
        caption_model,
        caption_type=caption_type,
        prompt=prompt_template,
        limit=limit,
        extract_caption_tags=tags,
        overwrite=overwrite,
        batch_size=batch_size,
        commit_every=commit_every,
        shard_total=shard_total,
        shard_index=shard_index,
    )
    if log_run:
        ended_at = datetime.now(timezone.utc)
        payload = build_run_log_payload(
            command="caption",
            config_path=config,
            config_fallback=DEFAULT_CONFIG_TOML,
            started_at=started_at or ended_at,
            ended_at=ended_at,
            stats=stats,
            runtime=build_runtime_environment(DEFAULT_LOG_LIBRARIES, batch_size=1),
            models={"captions": caption_model_metadata([model])},
            extra={
                "model": model,
                "caption_type": caption_type,
                "prompt": prompt_template,
                "extract_tags": tags,
                "overwrite": overwrite,
                "config_path": str(config),
                "db_path": str(db_path),
                "limit": limit,
                "batch_size": batch_size,
                "commit_every": commit_every,
                "shard_total": shard_total,
                "shard_index": shard_index,
            },
        )
        log_path = write_run_log(logs_dir, "caption", payload)
        typer.echo(f"Wrote caption log to {log_path}")
    typer.echo(
        f"Captioned {stats['captioned']} assets. "
        f"Skipped {stats['skipped']}. "
        f"Tags added {stats['tags_added']}."
    )


@app.command("caption-omnitag")
def caption_omnitag(
    mode: str = typer.Option(
        "batch-folder",
        "--mode",
        help="OmniTag mode: batch-folder, single-video, or images.",
    ),
    input_path: Path = typer.Option(..., "--input-path", help="Folder, image, or video input path."),
    output_path: Path = typer.Option(
        Path("exports/omnitag"),
        "--output-path",
        help="Directory for generated captions and extracted media.",
    ),
    model: str = typer.Option(
        "Qwen/Qwen3-VL-4B-Instruct",
        "--model",
        help="Qwen model ID used for OmniTag captioning.",
    ),
    caption_video_targets: str = typer.Option(
        "both",
        "--caption-video-targets",
        help="What to export for videos: clips, frames, or both.",
    ),
    trigger_word: str = typer.Option("ohwx", "--trigger-word", help="Trigger word prepended to captions."),
    llm_instruction: str = typer.Option(
        "Describe the scene with clinical, objective detail. ",
        "--llm-instruction",
        help="Prompt instruction passed to the OmniTag caption model.",
    ),
    target_resolution: int = typer.Option(768, "--target-resolution", help="Long edge resize target."),
    video_segment_seconds: float = typer.Option(
        5.0,
        "--video-segment-seconds",
        help="Segment length for extracted video clips.",
    ),
    segment_skip: int = typer.Option(10, "--segment-skip", help="Stride multiplier between segments."),
    video_max_segments: int = typer.Option(3, "--video-max-segments", help="Maximum segments per video."),
    target_fps: int = typer.Option(24, "--target-fps", help="Output fps for exported clips."),
    include_audio_in_video: bool = typer.Option(
        True,
        "--include-audio-in-video/--no-audio-in-video",
        help="Keep original audio track in extracted clips.",
    ),
    blur_threshold: float = typer.Option(
        90.0,
        "--blur-threshold",
        help="Minimum Laplacian variance needed to keep a video segment.",
    ),
) -> None:
    """Run OmniTag captioning for images and videos with clip/frame extraction."""
    mode = mode.lower()
    caption_video_targets = caption_video_targets.lower()
    if mode not in {"batch-folder", "single-video", "images"}:
        raise typer.BadParameter("--mode must be batch-folder, single-video, or images.")
    if caption_video_targets not in {"clips", "frames", "both"}:
        raise typer.BadParameter("--caption-video-targets must be clips, frames, or both.")
    if mode == "batch-folder" and not input_path.is_dir():
        raise typer.BadParameter("--input-path must be a folder when --mode=batch-folder.")
    if mode == "single-video" and not input_path.is_file():
        raise typer.BadParameter("--input-path must be a video file when --mode=single-video.")
    if mode == "images" and not input_path.is_file():
        raise typer.BadParameter("--input-path must be an image file when --mode=images.")

    settings = OmniTagSettings(
        output_path=output_path,
        trigger_word=trigger_word,
        llm_instruction=llm_instruction,
        target_resolution=target_resolution,
        video_segment_seconds=video_segment_seconds,
        segment_skip=segment_skip,
        video_max_segments=video_max_segments,
        target_fps=target_fps,
        include_audio_in_video=include_audio_in_video,
        blur_threshold=blur_threshold,
    )
    caption_model = get_caption_model("filename") if model == "filename" else get_omnitag_model(model)
    stats = run_omnitag_mode(
        mode=mode,
        input_path=input_path,
        settings=settings,
        model=caption_model,
        caption_video_targets=caption_video_targets,
    )
    typer.echo(
        "OmniTag run finished: "
        f"images_captioned={stats.images_captioned}, "
        f"videos_processed={stats.videos_processed}, "
        f"clips_exported={stats.clips_exported}, "
        f"frames_exported={stats.frames_exported}, "
        f"blurry_frames_skipped={stats.blurry_frames_skipped}."
    )


@app.command()
def update(
    root: Path | None = typer.Option(
        None,
        help="Optional root directory to rescan for new assets.",
    ),
    workers: int | None = typer.Option(
        None,
        "--workers",
        help="Number of workers for scan operations (defaults to scan config).",
    ),
    embed_model: list[str] | None = typer.Option(
        None,
        "--embed-model",
        help="Embedding model name to update (repeatable).",
    ),
    caption_model: list[str] | None = typer.Option(
        None,
        "--caption-model",
        help="Caption model name to update (repeatable).",
    ),
    caption_type: list[str] | None = typer.Option(
        None,
        "--caption-type",
        help="Caption type to generate (repeatable).",
    ),
    score_model: list[str] | None = typer.Option(
        None,
        "--score-model",
        help="Score model name to update (repeatable).",
    ),
    score_prompt: str | None = typer.Option(
        None,
        help="Prompt to use for prompt-conditioned score models.",
    ),
    limit: int | None = typer.Option(None, help="Max number of assets per stage."),
    thumb_size: int = typer.Option(512, help="Thumbnail size (square) when scanning."),
    exclude: list[str] | None = typer.Option(
        None,
        "--exclude",
        help="Glob pattern to exclude from scanning (repeatable).",
    ),
    log_run: bool = typer.Option(
        False,
        "--log-run",
        help="Write an update summary JSON file to the logs directory.",
    ),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Incrementally scan and update missing embeddings, captions, and scores."""
    settings = load_config(config)
    configure_model_cache(settings, config)
    register_heads(settings, config)
    paths = resolve_config_paths(settings, config)
    scan_settings = settings.get("scan", DEFAULT_CONFIG["scan"])
    flag_settings = settings.get("flags", DEFAULT_CONFIG.get("flags", {}))
    exclude_globs = exclude if exclude is not None else scan_settings.get("exclude_globs", [])
    workers = workers or int(scan_settings.get("workers", 4))
    db_path = paths["db_path"]
    thumbs_dir = paths["thumbs_dir"]
    logs_dir = paths["logs_dir"]

    started_at = datetime.now(timezone.utc) if log_run else None
    scan_stats = None
    if root is not None:
        scan_stats = scan_directory(
            root,
            db_path,
            thumbs_dir,
            size=(thumb_size, thumb_size),
            exclude_globs=exclude_globs,
            workers=workers,
            small_min_width=flag_settings.get("small_image_min_width"),
            small_min_height=flag_settings.get("small_image_min_height"),
        )
        typer.echo(
            "Scan complete: "
            f"{scan_stats['scanned']} scanned, "
            f"{scan_stats['inserted']} inserted, "
            f"{scan_stats['deduped']} deduped, "
            f"{scan_stats['skipped']} skipped, "
            f"{scan_stats['thumbs_created']} thumbs."
        )

    embed_models = resolve_embedding_models(settings, embed_model)
    caption_models = resolve_caption_models(settings, caption_model)
    caption_types = resolve_caption_types(settings, caption_type)
    score_models = resolve_score_models(settings, score_model)
    caption_prompts = {
        "long": (
            settings.get("captions", {})
            .get("prompts", {})
            .get("long", DEFAULT_CONFIG["captions"]["prompts"]["long"])
        ),
        "short": (
            settings.get("captions", {})
            .get("prompts", {})
            .get("short", DEFAULT_CONFIG["captions"]["prompts"]["short"])
        ),
        "tags": (
            settings.get("captions", {})
            .get("prompts", {})
            .get("tags", DEFAULT_CONFIG["captions"]["prompts"]["tags"])
        ),
    }

    stats = run_incremental_update(
        db_path,
        embed_models=embed_models,
        caption_models=caption_models,
        caption_types=caption_types,
        caption_prompts=caption_prompts,
        score_models=score_models,
        score_prompt=score_prompt,
        settings=settings,
        config_path=config,
        limit=limit,
    )
    if log_run:
        ended_at = datetime.now(timezone.utc)
        payload = build_run_log_payload(
            command="update",
            config_path=config,
            config_fallback=DEFAULT_CONFIG_TOML,
            started_at=started_at or ended_at,
            ended_at=ended_at,
            stats=stats,
            runtime=build_runtime_environment(DEFAULT_LOG_LIBRARIES, batch_size=1),
            models={
                "embeddings": embedding_model_metadata(embed_models),
                "captions": caption_model_metadata(caption_models),
                "scores": score_model_metadata(
                    score_models,
                    prompt=score_prompt,
                    settings=settings,
                    config_path=config,
                ),
            },
            extra={
                "root": str(root) if root else None,
                "config_path": str(config),
                "db_path": str(db_path),
                "thumbs_dir": str(thumbs_dir),
                "exclude_globs": exclude_globs,
                "embed_models": embed_models,
                "caption_models": caption_models,
                "caption_types": caption_types,
                "score_models": score_models,
                "score_prompt": score_prompt,
                "limit": limit,
                "scan": {
                    "root": str(root) if root else None,
                    "stats": scan_stats,
                    "thumb_size": thumb_size,
                },
            },
        )
        log_path = write_run_log(
            logs_dir,
            "update",
            payload,
        )
        typer.echo(f"Wrote update log to {log_path}")

    if stats["embeddings"]:
        typer.echo("Embedding updates:")
        for model_name, detail in stats["embeddings"].items():
            typer.echo(
                f"  {model_name}: embedded {detail['embedded']} "
                f"skipped {detail['skipped']}"
            )
    if stats["captions"]:
        typer.echo("Caption updates:")
        for key, detail in stats["captions"].items():
            typer.echo(
                f"  {key}: captioned {detail['captioned']} "
                f"skipped {detail['skipped']} tags {detail['tags_added']}"
            )
    if stats["scores"]:
        typer.echo("Score updates:")
        for model_name, detail in stats["scores"].items():
            typer.echo(
                f"  {model_name}: scored {detail['scored']} skipped {detail['skipped']}"
            )


@app.command("detect-text")
def detect_text(
    methods: list[str] | None = typer.Option(
        None,
        "--method",
        help="Text detection methods to run (repeatable): ocr, vision.",
    ),
    limit: int | None = typer.Option(None, help="Max number of assets to process."),
    batch_size: int = typer.Option(200, help="Batch size for loading assets."),
    commit_every: int = typer.Option(200, help="Commit after this many assets."),
    shard_total: int = typer.Option(
        1, "--shard-total", help="Total number of shards for parallel detection."
    ),
    shard_index: int = typer.Option(
        0, "--shard-index", help="Shard index for parallel detection (0-based)."
    ),
    overwrite: bool = typer.Option(
        False, help="Recompute text detection flags for all assets."
    ),
    sample_rate: float | None = typer.Option(
        None,
        help="Process a deterministic sample of assets (0-1). Defaults to config value.",
    ),
    sample_seed: int | None = typer.Option(
        None, help="Seed for deterministic sampling. Defaults to config value."
    ),
    log_run: bool = typer.Option(
        False,
        "--log-run",
        help="Write a detection summary JSON file to the logs directory.",
    ),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Detect text, captions, or signatures using OCR/vision models."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    logs_dir = paths["logs_dir"]
    methods = methods or settings.get("text_detection", {}).get("methods", ["ocr"])
    valid_methods = {"ocr", "vision"}
    unknown = [method for method in methods if method not in valid_methods]
    if unknown:
        raise typer.BadParameter(f"Unknown text detection methods: {', '.join(unknown)}")
    if sample_rate is None:
        sample_rate = float(settings.get("text_detection", {}).get("sample_rate", 1.0))
    if sample_rate < 0 or sample_rate > 1:
        raise typer.BadParameter("sample-rate must be between 0 and 1.")

    started_at = datetime.now(timezone.utc) if log_run else None
    stats = detect_text_assets(
        paths["db_path"],
        methods=methods,
        settings=settings,
        limit=limit,
        batch_size=batch_size,
        commit_every=commit_every,
        shard_total=shard_total,
        shard_index=shard_index,
        overwrite=overwrite,
        sample_rate=sample_rate,
        sample_seed=sample_seed,
    )
    if log_run:
        ended_at = datetime.now(timezone.utc)
        payload = build_run_log_payload(
            command="detect-text",
            config_path=config,
            config_fallback=DEFAULT_CONFIG_TOML,
            started_at=started_at or ended_at,
            ended_at=ended_at,
            stats=stats,
            runtime=build_runtime_environment(DEFAULT_LOG_LIBRARIES, batch_size=1),
            extra={
                "methods": methods,
                "config_path": str(config),
                "db_path": str(paths["db_path"]),
                "limit": limit,
                "batch_size": batch_size,
                "commit_every": commit_every,
                "shard_total": shard_total,
                "shard_index": shard_index,
                "overwrite": overwrite,
                "sample_rate": sample_rate,
                "sample_seed": sample_seed,
            },
        )
        log_path = write_run_log(logs_dir, "detect-text", payload)
        typer.echo(f"Wrote text detection log to {log_path}")
    typer.echo(
        f"Text detection complete: scanned {stats['scanned']} "
        f"flagged {stats['flagged']} skipped {stats['skipped']} "
        f"sampled_out {stats['sampled_out']}."
    )


@app.command("flag-small")
def flag_small(
    min_width: int | None = typer.Option(
        None, help="Minimum width threshold for small image flag."
    ),
    min_height: int | None = typer.Option(
        None, help="Minimum height threshold for small image flag."
    ),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Recompute the small-image flag for existing assets."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    flag_settings = settings.get("flags", DEFAULT_CONFIG.get("flags", {}))
    min_width = min_width or int(flag_settings.get("small_image_min_width", 0))
    min_height = min_height or int(flag_settings.get("small_image_min_height", 0))
    with db.connect(paths["db_path"]) as connection:
        updated = db.update_small_flags(connection, min_width, min_height)
        connection.commit()
    typer.echo(
        f"Updated small-image flag for {updated} assets "
        f"(threshold {min_width}x{min_height})."
    )


@app.command()
def score(
    model: str = typer.Option(
        "aesthetic-simple",
        help="Score model name (default: aesthetic-simple).",
    ),
    prompt: str | None = typer.Option(
        None,
        help="Text prompt for prompt-conditioned scorers.",
    ),
    limit: int | None = typer.Option(None, help="Max number of assets to score."),
    overwrite: bool = typer.Option(
        False, help="Recompute scores for all assets for this model."
    ),
    batch_size: int = typer.Option(200, help="Number of assets to fetch per batch."),
    commit_every: int = typer.Option(500, help="Commit after this many scores."),
    shard_total: int = typer.Option(
        1, "--shard-total", help="Total number of shards for parallel scoring."
    ),
    shard_index: int = typer.Option(
        0, "--shard-index", help="Shard index for parallel scoring (0-based)."
    ),
    log_run: bool = typer.Option(
        False,
        "--log-run",
        help="Write a scoring summary JSON file to the logs directory.",
    ),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Score assets using an aesthetic scoring model."""
    settings = load_config(config)
    configure_model_cache(settings, config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    logs_dir = paths["logs_dir"]

    started_at = datetime.now(timezone.utc) if log_run else None
    score_model = get_score_model(model, prompt=prompt, settings=settings, config_path=config)
    if shard_total < 1 or shard_index < 0 or shard_index >= shard_total:
        raise typer.BadParameter("--shard-index must be between 0 and --shard-total - 1.")
    stats = score_assets(
        db_path,
        score_model,
        limit=limit,
        overwrite=overwrite,
        batch_size=batch_size,
        commit_every=commit_every,
        shard_total=shard_total,
        shard_index=shard_index,
    )
    if log_run:
        ended_at = datetime.now(timezone.utc)
        payload = build_run_log_payload(
            command="score",
            config_path=config,
            config_fallback=DEFAULT_CONFIG_TOML,
            started_at=started_at or ended_at,
            ended_at=ended_at,
            stats=stats,
            runtime=build_runtime_environment(DEFAULT_LOG_LIBRARIES, batch_size=1),
            models={
                "scores": score_model_metadata(
                    [model],
                    prompt=prompt,
                    settings=settings,
                    config_path=config,
                )
            },
            extra={
                "model": model,
                "prompt": prompt,
                "overwrite": overwrite,
                "config_path": str(config),
                "db_path": str(db_path),
                "limit": limit,
                "batch_size": batch_size,
                "commit_every": commit_every,
                "shard_total": shard_total,
                "shard_index": shard_index,
            },
        )
        log_path = write_run_log(logs_dir, "score", payload)
        typer.echo(f"Wrote score log to {log_path}")
    typer.echo(f"Scored {stats['scored']} assets. Skipped {stats['skipped']}.")


@app.command()
def search(
    image: Path | None = typer.Option(None, help="Image path to search with."),
    asset_id: int | None = typer.Option(None, help="Asset ID to search with."),
    model: str = typer.Option("color-histogram", help="Embedding model name."),
    limit: int = typer.Option(5, help="Number of nearest neighbors to return."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Perform a kNN search over embedded assets."""
    if image is None and asset_id is None:
        raise typer.BadParameter("Provide either --image or --asset-id.")
    if image is not None and asset_id is not None:
        raise typer.BadParameter("Provide only one of --image or --asset-id.")

    settings = load_config(config)
    configure_model_cache(settings, config)
    register_heads(settings, config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]

    embedding_model = get_embedding_model(model)
    if asset_id is not None:
        with db.connect(db_path) as connection:
            asset = db.fetch_asset_by_id(connection, asset_id)
        if asset is None:
            raise typer.BadParameter(f"Asset {asset_id} not found.")
        image = Path(asset["source_path"])

    if image is None:
        raise typer.BadParameter("Image path is required for search.")

    with Image.open(image) as img:
        query_embedding = embedding_model.encode(img)
    index_dir = paths["indices_dir"]
    vector_store = build_vector_store(settings, db_path, index_dir=index_dir)
    results = vector_store.search(query_embedding, embedding_model, limit=limit)
    typer.echo("Nearest neighbors:")
    with db.connect(db_path) as connection:
        for rank, result in enumerate(results, start=1):
            result_id = result.asset_id
            score = result.score
            asset = db.fetch_asset_by_id(connection, result_id)
            asset_path = asset["source_path"] if asset else "unknown"
            typer.echo(f"{rank}. asset_id={result_id} score={score:.4f} path={asset_path}")


@app.command("vector-sync")
def vector_sync(
    model: list[str] = typer.Option(
        None,
        "--model",
        help="Embedding model name to sync (repeatable).",
    ),
    version: list[str] = typer.Option(
        None,
        "--version",
        help="Embedding model version (repeatable, aligns with --model).",
    ),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Sync embeddings into the configured vector store backend."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    index_dir = paths["indices_dir"]

    models: list[dict[str, str | None]] = []
    if model:
        if version and len(version) != len(model):
            raise typer.BadParameter("--version must have the same count as --model.")
        for idx, name in enumerate(model):
            models.append({"name": name, "version": version[idx] if version else None})
    else:
        fusion_weights = settings.get("fusion", {}).get("weights", {})
        if fusion_weights:
            models = [{"name": key, "version": None} for key in fusion_weights.keys()]
        else:
            models = [{"name": "color-histogram", "version": None}]

    results = sync_vector_store(settings, db_path, index_dir, models)
    for result in results:
        if result["status"] == "synced":
            typer.echo(f"Synced {result['model']}@{result['version']}")
        else:
            typer.echo(
                f"Failed to sync {result['model']}@{result['version']}: {result['detail']}"
            )


@app.command("text-search")
def text_search(
    query: str = typer.Argument(..., help="FTS query over captions/tags."),
    limit: int = typer.Option(10, help="Number of matches to return."),
    as_json: bool = typer.Option(False, "--json", help="Output results as JSON."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Search captions and tags using full-text search."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    if not db_path.exists():
        typer.echo(f"Database not found at {db_path}")
        raise typer.Exit(code=1)

    with db.connect(db_path) as connection:
        results = db.search_assets(connection, query, limit=limit)
        entries: list[dict[str, object]] = []
        for rank, (asset_id, score) in enumerate(results, start=1):
            asset = db.fetch_asset_by_id(connection, asset_id)
            asset_path = asset["source_path"] if asset else "unknown"
            entries.append(
                {
                    "rank": rank,
                    "asset_id": asset_id,
                    "score": score,
                    "path": asset_path,
                }
            )

    if as_json:
        typer.echo(json.dumps(entries, indent=2))
        return

    typer.echo("Text search results:")
    for entry in entries:
        typer.echo(
            f"{entry['rank']}. asset_id={entry['asset_id']} "
            f"score={entry['score']:.4f} path={entry['path']}"
        )


@app.command("search-index-rebuild")
def search_index_rebuild(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Rebuild the full-text search index from captions and tags."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    _require_db(db_path)

    with db.connect(db_path) as connection:
        count = db.rebuild_search_index(connection)
        connection.commit()
    typer.echo(f"Rebuilt search index for {count} assets.")


@app.command()
def facets(
    score_buckets: int = typer.Option(5, help="Number of buckets per score model."),
    as_json: bool = typer.Option(False, "--json", help="Output facets as JSON."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Summarize filter facets for media type, aspect, and scores."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    _require_db(db_path)

    with db.connect(db_path) as connection:
        media_facets = db.fetch_media_type_facets(connection)
        aspect_facets = db.fetch_aspect_facets(connection)
        score_facets = db.fetch_score_facets(connection, buckets=score_buckets)
        text_facets = db.fetch_text_facets(connection)
        small_facets = db.fetch_small_facets(connection)

    if as_json:
        typer.echo(
            json.dumps(
                {
                    "media_types": media_facets,
                    "aspect_ratios": aspect_facets,
                    "scores": score_facets,
                    "text": text_facets,
                    "small": small_facets,
                },
                indent=2,
            )
        )
        return

    typer.echo("Media types:")
    if media_facets:
        for media_type, count in media_facets.items():
            typer.echo(f"  {media_type}: {count}")
    else:
        typer.echo("  (none)")

    typer.echo("Aspect ratios:")
    if aspect_facets:
        for aspect, count in aspect_facets.items():
            typer.echo(f"  {aspect}: {count}")
    else:
        typer.echo("  (none)")

    typer.echo("Score models:")
    if score_facets:
        for model_key, detail in score_facets.items():
            typer.echo(
                f"  {model_key}: count={detail['count']} min={detail['min']:.4f} "
                f"max={detail['max']:.4f} avg={detail['avg']:.4f}"
            )
            for bucket in detail["buckets"]:
                typer.echo(f"    {bucket['label']}: {bucket['count']}")
    else:
        typer.echo("  (none)")

    typer.echo("Text facets:")
    if text_facets:
        for key, count in text_facets.items():
            typer.echo(f"  {key}: {count}")
    else:
        typer.echo("  (none)")

    typer.echo("Small image facets:")
    if small_facets:
        for key, count in small_facets.items():
            typer.echo(f"  {key}: {count}")
    else:
        typer.echo("  (none)")


@app.command("api")
def api_server(
    host: str = typer.Option("127.0.0.1", help="Host interface to bind."),
    port: int = typer.Option(8000, help="Port to bind."),
    reload: bool = typer.Option(False, help="Enable auto-reload for development."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Start the StyleVault API server."""
    import uvicorn

    os.environ["STYLEVAULT_CONFIG"] = str(config.resolve())
    uvicorn.run(
        "stylevault.api.app:create_app_from_env",
        factory=True,
        host=host,
        port=port,
        reload=reload,
    )


@app.command("index")
def index_folder(
    folder: Path = typer.Argument(..., help="Folder of images to add to the library."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Scan, embed, cluster and map a folder. Uses the running API if there is one."""
    import time
    import urllib.error
    import urllib.request

    folder = folder.expanduser().resolve()
    base = os.environ.get("STYLEVAULT_API_URL", "http://127.0.0.1:8000").rstrip("/")

    def call(path: str, body: dict | None = None) -> dict:
        request = urllib.request.Request(
            base + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read())

    try:
        call("/health")
        running = True
    except (OSError, ValueError):
        running = False

    if not running:
        from stylevault.indexing import run_index

        settings = load_config(config)
        paths = resolve_config_paths(settings, config)
        db.init_db(paths["db_path"])
        total = run_index(
            folder,
            settings,
            config,
            paths,
            lambda p: typer.echo(f"{p.step} {p.done}/{p.total}"),
        )
        typer.echo(f"Done. {total} assets in the library.")
        return

    try:
        call("/library/index", {"folder": str(folder)})
    except urllib.error.HTTPError as error:
        typer.echo(f"Refused: {error.read().decode(errors='replace')}", err=True)
        raise typer.Exit(code=1)
    last = ""
    while True:
        status = call("/library/index/status")
        line = f"{status['step']} {status['done']}/{status['total']}"
        if line != last:
            typer.echo(line)
            last = line
        if status["state"] == "error":
            typer.echo(f"Failed: {status['error']}", err=True)
            raise typer.Exit(code=1)
        if status["state"] == "done":
            typer.echo(f"Done. {status['assets']} assets in the library.")
            return
        time.sleep(1)


@app.command()
def status(
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
    score_prompt: str | None = typer.Option(
        None,
        help="Prompt to use for prompt-conditioned score models.",
    ),
    as_json: bool = typer.Option(False, "--json", help="Output status as JSON."),
) -> None:
    """Summarize coverage for embeddings, captions, and scores."""
    settings = load_config(config)
    register_heads(settings, config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    _require_db(db_path)

    embed_models = resolve_embedding_models(settings, None)
    caption_models = resolve_caption_models(settings, None)
    caption_types = resolve_caption_types(settings, None)
    score_models = resolve_score_models(settings, None)

    with db.connect(db_path) as connection:
        total_assets = db.count_assets(connection)
        embedding_entries: list[dict[str, object]] = []
        caption_entries: list[dict[str, object]] = []
        score_entries: list[dict[str, object]] = []

        if embed_models:
            for model_name in embed_models:
                model = get_embedding_model(model_name)
                missing = db.count_assets_missing_embeddings(
                    connection, model.name, model.version
                )
                embedding_entries.append(
                    {
                        "model": model.name,
                        "version": model.version,
                        "total": total_assets,
                        "missing": missing,
                        "coverage": format_coverage(total_assets, missing),
                    }
                )

        if caption_models:
            for model_name in caption_models:
                model = get_caption_model(model_name)
                for caption_type in caption_types:
                    if model.name == "filename" and caption_type == "tags":
                        continue
                    missing = db.count_assets_missing_captions(
                        connection, model.name, model.version, caption_type
                    )
                    caption_entries.append(
                        {
                            "model": model.name,
                            "version": model.version,
                            "type": caption_type,
                            "total": total_assets,
                            "missing": missing,
                            "coverage": format_coverage(total_assets, missing),
                        }
                    )

        if score_models:
            for model_name in score_models:
                try:
                    model = get_score_model(
                        model_name,
                        prompt=score_prompt,
                        settings=settings,
                        config_path=config,
                    )
                except ValueError as error:
                    score_entries.append(
                        {
                            "model": model_name,
                            "error": str(error),
                            "skipped": True,
                        }
                    )
                    continue
                missing = db.count_assets_missing_scores(
                    connection, model.name, model.version
                )
                score_entries.append(
                    {
                        "model": model.name,
                        "version": model.version,
                        "total": total_assets,
                        "missing": missing,
                        "coverage": format_coverage(total_assets, missing),
                    }
                )

    if as_json:
        typer.echo(
            json.dumps(
                {
                    "assets": total_assets,
                    "embeddings": embedding_entries,
                    "captions": caption_entries,
                    "scores": score_entries,
                },
                indent=2,
            )
        )
        return

    typer.echo(f"Assets: {total_assets}")

    typer.echo("Embeddings:")
    if embedding_entries:
        for entry in embedding_entries:
            typer.echo(
                f"  {entry['model']}@{entry['version']}: "
                f"{entry['coverage']} missing={entry['missing']}"
            )
    else:
        typer.echo("  (none configured)")

    typer.echo("Captions:")
    if caption_entries:
        for entry in caption_entries:
            typer.echo(
                "  "
                f"{entry['model']}@{entry['version']} [{entry['type']}]: "
                f"{entry['coverage']} missing={entry['missing']}"
            )
    else:
        typer.echo("  (none configured)")

    typer.echo("Scores:")
    if score_entries:
        for entry in score_entries:
            if entry.get("skipped"):
                typer.echo(f"  {entry['model']}: skipped ({entry['error']})")
                continue
            typer.echo(
                f"  {entry['model']}@{entry['version']}: "
                f"{entry['coverage']} missing={entry['missing']}"
            )
    else:
        typer.echo("  (none configured)")


@app.command("knn-graph")
def knn_graph(
    model: list[str] = typer.Option(
        None,
        "--model",
        help="Embedding model name to include (repeatable).",
    ),
    weight: list[float] = typer.Option(
        None,
        "--weight",
        help="Fusion weight for each --model (repeatable).",
    ),
    k: int = typer.Option(15, help="Neighbors per asset."),
    approx: bool = typer.Option(
        True,
        "--approx/--exact",
        help="Use approximate ANN search when available.",
    ),
    metric: str = typer.Option(
        "cosine",
        help="Distance metric for neighbor search (cosine or l2).",
    ),
    batch_size: int = typer.Option(512, help="Batch size for ANN queries."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Build a fused kNN graph from multiple embedding models."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]

    models, weights = resolve_fusion_models(settings, model, weight)

    cache_dir = paths["indices_dir"] / "fused_cache"
    stats = build_fused_knn_graph(
        db_path,
        models,
        weights,
        k=k,
        approx=approx,
        metric=metric,
        batch_size=batch_size,
        cache_dir=cache_dir,
    )
    typer.echo(
        f"Fused kNN graph run {stats.run_id}: "
        f"{stats.assets} assets, {stats.edges} edges."
    )


@app.command()
def cluster(
    model: list[str] = typer.Option(
        None,
        "--model",
        help="Embedding model name to include (repeatable).",
    ),
    weight: list[float] = typer.Option(
        None,
        "--weight",
        help="Fusion weight for each --model (repeatable).",
    ),
    min_cluster_size: int = typer.Option(10, help="Minimum cluster size."),
    min_samples: int | None = typer.Option(None, help="Minimum samples per cluster core."),
    cluster_selection_epsilon: float = typer.Option(
        0.0, help="Distance threshold for cluster selection."
    ),
    log_run: bool = typer.Option(
        False,
        "--log-run",
        help="Write a clustering summary JSON file to the logs directory.",
    ),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Run HDBSCAN clustering over fused embeddings."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    logs_dir = paths["logs_dir"]

    models, weights = resolve_fusion_models(settings, model, weight)
    started_at = datetime.now(timezone.utc) if log_run else None
    cache_dir = paths["indices_dir"] / "fused_cache"
    stats = run_hdbscan_clustering(
        db_path,
        models,
        weights,
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        cluster_selection_epsilon=cluster_selection_epsilon,
        cache_dir=cache_dir,
    )
    if log_run:
        ended_at = datetime.now(timezone.utc)
        payload = build_run_log_payload(
            command="cluster",
            config_path=config,
            config_fallback=DEFAULT_CONFIG_TOML,
            started_at=started_at or ended_at,
            ended_at=ended_at,
            stats=stats,
            runtime=build_runtime_environment(DEFAULT_LOG_LIBRARIES),
            models={"embeddings": embedding_model_metadata(models)},
            extra={
                "config_path": str(config),
                "db_path": str(db_path),
                "fusion": {"models": models, "weights": weights},
                "min_cluster_size": min_cluster_size,
                "min_samples": min_samples,
                "cluster_selection_epsilon": cluster_selection_epsilon,
            },
        )
        log_path = write_run_log(logs_dir, "cluster", payload)
        typer.echo(f"Wrote cluster log to {log_path}")
    typer.echo(
        f"HDBSCAN run {stats.run_id}: "
        f"{stats.assets} assets, "
        f"{stats.clusters} clusters, "
        f"{stats.noise} noise."
    )


@app.command("cluster-assign")
def cluster_assign(
    run_id: int = typer.Argument(..., help="Cluster run ID to extend."),
    similarity_threshold: float | None = typer.Option(
        None,
        help="Optional cosine similarity threshold for assignment.",
    ),
    limit: int | None = typer.Option(
        None,
        help="Limit assignments to the first N unlabeled assets.",
    ),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Assign unlabeled assets to existing clusters via centroid similarity."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    _require_db(db_path)

    cache_dir = paths["indices_dir"] / "fused_cache"
    stats = assign_assets_to_cluster_run(
        db_path,
        run_id,
        similarity_threshold=similarity_threshold,
        limit=limit,
        cache_dir=cache_dir,
    )
    typer.echo(
        f"Cluster run {stats.run_id}: "
        f"{stats.assigned} assigned, "
        f"{stats.skipped} skipped, "
        f"{stats.candidates} candidates, "
        f"{stats.clusters} clusters."
    )


@app.command("cluster-tree")
def cluster_tree(
    model: list[str] = typer.Option(
        None,
        "--model",
        help="Embedding model name to include (repeatable).",
    ),
    weight: list[float] = typer.Option(
        None,
        "--weight",
        help="Fusion weight for each --model (repeatable).",
    ),
    min_cluster_size: int = typer.Option(10, help="Minimum cluster size."),
    min_samples: int | None = typer.Option(None, help="Minimum samples per cluster core."),
    cluster_selection_epsilon: float = typer.Option(
        0.0, help="Distance threshold for cluster selection."
    ),
    max_depth: int = typer.Option(2, help="Maximum recursion depth."),
    min_subcluster_size: int | None = typer.Option(
        None,
        help="Minimum cluster size to attempt recursive splitting.",
    ),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Run recursive HDBSCAN clustering and store a cluster tree."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]

    models, weights = resolve_fusion_models(settings, model, weight)
    cache_dir = paths["indices_dir"] / "fused_cache"
    stats = run_recursive_hdbscan_clustering(
        db_path,
        models,
        weights,
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        cluster_selection_epsilon=cluster_selection_epsilon,
        max_depth=max_depth,
        min_subcluster_size=min_subcluster_size,
        cache_dir=cache_dir,
    )
    typer.echo(
        "Recursive HDBSCAN run "
        f"{stats.root_run_id}: "
        f"{stats.assets} assets, "
        f"{stats.clusters} clusters, "
        f"{stats.runs} runs, "
        f"depth={stats.max_depth}, "
        f"{stats.noise} noise."
    )


@app.command("umap")
def umap_projection(
    model: list[str] = typer.Option(
        None,
        "--model",
        help="Embedding model name to include (repeatable).",
    ),
    weight: list[float] = typer.Option(
        None,
        "--weight",
        help="Fusion weight for each --model (repeatable).",
    ),
    n_neighbors: int = typer.Option(15, help="Number of neighbors for UMAP."),
    min_dist: float = typer.Option(0.1, help="Minimum distance for UMAP."),
    metric: str = typer.Option("euclidean", help="Distance metric for UMAP."),
    log_run: bool = typer.Option(
        False,
        "--log-run",
        help="Write a UMAP summary JSON file to the logs directory.",
    ),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Project fused embeddings into 2D UMAP coordinates."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    logs_dir = paths["logs_dir"]

    models, weights = resolve_fusion_models(settings, model, weight)
    started_at = datetime.now(timezone.utc) if log_run else None
    cache_dir = paths["indices_dir"] / "fused_cache"
    stats = build_umap_projection(
        db_path,
        models,
        weights,
        n_neighbors=n_neighbors,
        min_dist=min_dist,
        metric=metric,
        cache_dir=cache_dir,
    )
    if log_run:
        ended_at = datetime.now(timezone.utc)
        payload = build_run_log_payload(
            command="umap",
            config_path=config,
            config_fallback=DEFAULT_CONFIG_TOML,
            started_at=started_at or ended_at,
            ended_at=ended_at,
            stats=stats,
            runtime=build_runtime_environment(DEFAULT_LOG_LIBRARIES),
            models={"embeddings": embedding_model_metadata(models)},
            extra={
                "config_path": str(config),
                "db_path": str(db_path),
                "fusion": {"models": models, "weights": weights},
                "n_neighbors": n_neighbors,
                "min_dist": min_dist,
                "metric": metric,
            },
        )
        log_path = write_run_log(logs_dir, "umap", payload)
        typer.echo(f"Wrote UMAP log to {log_path}")
    typer.echo(f"UMAP run {stats.run_id}: {stats.assets} assets.")


@app.command("export-clusters")
def export_clusters(
    run_id: int = typer.Argument(..., help="Cluster run ID to export."),
    mode: str = typer.Option(
        "hardlink",
        help="Export mode: hardlink, symlink, or copy.",
    ),
    include_noise: bool = typer.Option(
        False,
        help="Include noise points (cluster_label = -1).",
    ),
    dry_run: bool = typer.Option(
        False,
        help="Plan the export and write the manifest without modifying files.",
    ),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Export cluster-labeled assets to folder trees with a manifest."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    _require_db(db_path)
    exports_dir = paths["exports_dir"]

    stats = export_cluster_run(
        db_path,
        exports_dir,
        run_id,
        mode=mode,
        include_noise=include_noise,
        dry_run=dry_run,
    )
    if dry_run:
        typer.echo(
            f"Planned {stats.planned} assets "
            f"(skipped {stats.skipped}, missing {stats.missing}). "
            f"Manifest: {stats.manifest_path}"
        )
    else:
        typer.echo(
            f"Exported {stats.exported} assets "
            f"(skipped {stats.skipped}, missing {stats.missing}) "
            f"to {stats.export_dir}. Manifest: {stats.manifest_path}"
        )


@app.command("tag-add")
def tag_add(
    asset_id: list[int] = typer.Option(
        ...,
        "--asset-id",
        help="Asset ID to tag (repeatable).",
    ),
    tag: list[str] = typer.Option(
        ...,
        "--tag",
        help="Tag value to add (repeatable).",
    ),
    source: str = typer.Option("curation", help="Tag source label."),
    dry_run: bool = typer.Option(False, help="Preview changes without writing."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Add tags to assets for curation."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]

    stats = add_tags(db_path, asset_id, tag, source=source, dry_run=dry_run)
    typer.echo(
        f"Tags added {stats.tags_added}, skipped {stats.tags_skipped}, "
        f"missing assets {stats.missing_assets}."
    )
    if dry_run:
        typer.echo("Dry run: no changes written.")


@app.command("tag-remove")
def tag_remove(
    asset_id: list[int] = typer.Option(
        ...,
        "--asset-id",
        help="Asset ID to untag (repeatable).",
    ),
    tag: list[str] = typer.Option(
        ...,
        "--tag",
        help="Tag value to remove (repeatable).",
    ),
    source: str | None = typer.Option(
        None,
        help="Optional source label to filter removals.",
    ),
    dry_run: bool = typer.Option(False, help="Preview changes without writing."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Remove tags from assets for curation."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]

    stats = remove_tags(db_path, asset_id, tag, source=source, dry_run=dry_run)
    typer.echo(
        f"Tags removed {stats.tags_removed}, skipped {stats.tags_skipped}, "
        f"missing assets {stats.missing_assets}."
    )
    if dry_run:
        typer.echo("Dry run: no changes written.")


@app.command("curate-files")
def curate_files(
    target: Path = typer.Argument(..., help="Target directory for curation actions."),
    asset_id: list[int] = typer.Option(
        ...,
        "--asset-id",
        help="Asset ID to act on (repeatable).",
    ),
    mode: str = typer.Option(
        "hardlink",
        help="Action: move, copy, hardlink, or symlink.",
    ),
    dry_run: bool = typer.Option(False, help="Preview changes without writing."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Move, copy, or link curated assets to a target directory."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    logs_dir = paths["logs_dir"] / "curation"

    stats = apply_file_actions(
        db_path,
        asset_id,
        target,
        mode=mode,
        dry_run=dry_run,
        log_dir=logs_dir,
    )
    typer.echo(
        f"Planned {stats.planned} items, skipped {stats.skipped}, "
        f"missing assets {stats.missing_assets}."
    )
    if dry_run:
        typer.echo("Dry run: no changes written.")
    if stats.manifest_path:
        typer.echo(f"Manifest: {stats.manifest_path}")


@app.command("undo")
def undo(
    manifest: Path = typer.Argument(..., help="Manifest JSON to undo."),
    dry_run: bool = typer.Option(False, help="Preview undo steps without changes."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
) -> None:
    """Undo a curation/export manifest."""
    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    db_path = paths["db_path"]
    stats = undo_manifest(db_path, manifest, dry_run=dry_run)
    typer.echo(
        f"Undo complete: removed {stats['removed']}, restored {stats['restored']}, "
        f"skipped {stats['skipped']}."
    )
    if dry_run:
        typer.echo("Dry run: no changes written.")


@app.command("export-by-tag")
def export_by_tag_cmd(
    tag: str = typer.Argument(..., help="Tag to export."),
    target: Path = typer.Argument(..., help="Target dataset directory."),
    config: Path = typer.Option(default_config_path(), help="Path to config file."),
    mode: str = typer.Option("symlink", help="symlink | copy"),
    limit: int | None = typer.Option(None, help="Max assets to export."),
) -> None:
    """Materialize a tag group (images + prompt .txt sidecars) as a training dataset."""

    settings = load_config(config)
    paths = resolve_config_paths(settings, config)
    _require_db(paths["db_path"])
    count = export_assets_by_tag(
        db_path=paths["db_path"],
        tag=tag,
        target_dir=target.expanduser().resolve(),
        mode=mode,
        limit=limit,
    )
    typer.echo(f"Exported {count} assets to {target}")

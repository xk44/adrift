from __future__ import annotations

from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import threading
from typing import Any

from fastapi import APIRouter, HTTPException
from PIL import Image
from pydantic import BaseModel, field_validator

from stylevault import db, indexing
from stylevault.omnitag import FilenameOmniTagCaptionModel, _module_available, get_omnitag_model
from stylevault.trainers import (
    build_dataset_manifest,
    build_train_plan,
    build_trainer_routes,
    check_model_family,
    collect_artifacts,
    detect_install,
    detect_version,
    find_adapter,
    load_trainer_adapters,
)

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
CAPTION_EXTS = {".txt", ".caption"}
_PROCESSES: dict[int, subprocess.Popen[str]] = {}
# Jobs the user cancelled. Checked between commands and after each exit so a trainer that
# exits 0 on SIGTERM (or a cancel landing between cache/train steps) can't resume the
# plan and overwrite the cancelled status with "done".
_CANCELLED: set[int] = set()
_STEP_RE = re.compile(r"(?:step\D*)?(\d+)\s*/\s*(\d+)", re.IGNORECASE)
_LOSS_RE = re.compile(r"\bavr_loss=([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)")
_PRED_STD_RE = re.compile(r"\bpred_std=([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)")
LOGGER = logging.getLogger(__name__)


class TrainingDatasetRequest(BaseModel):
    images_dir: str | None = None
    cluster_id: int | None = None
    caption_ext: str | None = None


class TrainingJobRequest(BaseModel):
    backend: str
    model_family: str
    run_name: str
    dataset: TrainingDatasetRequest
    params: dict[str, Any] | None = None

    _family = field_validator("model_family")(check_model_family)


class TrainingDeployRequest(BaseModel):
    lora_dir: str | None = None
    name: str | None = None



def _signal_process_group(process: Any, sig: int) -> None:
    """Signal the trainer's whole process group (it runs in its own session) so
    grandchildren (dataloader workers, accelerate launchers) don't outlive a cancel."""
    if os.name == "posix":
        try:
            os.killpg(os.getpgid(process.pid), sig)
            return
        except (ProcessLookupError, PermissionError, OSError, TypeError, ValueError):
            pass
    try:
        if sig == signal.SIGKILL:
            process.kill()
        else:
            process.terminate()
    except Exception:  # noqa: BLE001
        pass


def _terminate_process(process: Any, grace: float = 5) -> None:
    _signal_process_group(process, signal.SIGTERM)
    try:
        process.wait(timeout=grace)
    except subprocess.TimeoutExpired:
        _signal_process_group(process, getattr(signal, "SIGKILL", signal.SIGTERM))
        process.wait()


def _append_training_log(metadata: dict[str, Any], line: str) -> None:
    tail = list(metadata.get("log_tail", []))
    tail.append(line.rstrip())
    metadata["log_tail"] = tail[-80:]
    match = _STEP_RE.search(line)
    if match:
        step = int(match.group(1))
        total = max(int(match.group(2)), 1)
        metadata["step"] = step
        metadata["total_steps"] = total
        metadata["progress"] = min(max(step / total, 0.0), 1.0)
    loss_match = _LOSS_RE.search(line)
    if loss_match:
        loss = float(loss_match.group(1))
        metadata["last_loss"] = loss
        history = list(metadata.get("loss_history", []))
        history.append(loss)
        metadata["loss_history"] = history[-60:]
        max_loss = metadata.get("max_loss")
        metadata["max_loss"] = loss if max_loss is None else max(float(max_loss), loss)
    pred_std_match = _PRED_STD_RE.search(line)
    if pred_std_match:
        metadata["last_pred_std"] = float(pred_std_match.group(1))


def _loss_exceeded_threshold(metadata: dict[str, Any], threshold: float) -> bool:
    loss = metadata.get("last_loss")
    return threshold > 0 and loss is not None and float(loss) > threshold


def _caption_text(caption: str, trigger_word: str) -> str:
    caption = caption.strip()
    trigger_word = trigger_word.strip()
    if trigger_word and caption:
        return f"{trigger_word}, {caption}"
    return trigger_word or caption


def _clean_caption_ext(value: Any) -> str:
    """Caption files sit next to the images, so only caption extensions are allowed."""
    ext = str(value or ".txt").strip()
    if not ext.startswith("."):
        ext = f".{ext}"
    if ext not in CAPTION_EXTS:
        raise HTTPException(status_code=400, detail="caption_ext must be .txt or .caption.")
    return ext


def _clean_trigger_word(value: Any) -> str:
    return " ".join(str(value or "").split())


def _auto_caption_missing_sidecars(
    image_paths: list[Path],
    params: dict[str, Any],
    settings: dict[str, Any],
) -> None:
    if not params.get("auto_caption"):
        return
    caption_ext = _clean_caption_ext(params.get("caption_ext"))
    targets = [path for path in image_paths if not path.with_suffix(caption_ext).exists()]
    if not targets:
        return
    omnitag_cfg = settings.get("omnitag", {}) if isinstance(settings.get("omnitag", {}), dict) else {}
    model_id = str(omnitag_cfg.get("model_id", "Qwen/Qwen3-VL-4B-Instruct"))
    if _module_available("torch") and _module_available("transformers"):
        try:
            model = get_omnitag_model(model_id)
        except (ImportError, RuntimeError) as exc:
            LOGGER.warning("Falling back to filename captions: %s", exc)
            model = FilenameOmniTagCaptionModel()
    else:
        model = FilenameOmniTagCaptionModel()
    trigger_word = _clean_trigger_word(params.get("trigger_word"))
    for image_path in targets:
        sidecar_path = image_path.with_suffix(caption_ext)
        try:
            with Image.open(image_path) as image:
                caption = model.generate(image.convert("RGB"), image_path, prompt=None)
            sidecar_path.write_text(_caption_text(caption, trigger_word) + "\n", encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("Skipping auto-caption for %s: %s", image_path, exc)


def build_training_router(
    *,
    settings: dict[str, Any],
    config_path: Path,
    db_path: Path,
    paths: dict[str, Path],
) -> APIRouter:
    router = APIRouter(prefix="/training", tags=["training"])

    def _trainer_root() -> Path:
        root = Path(str(settings.get("trainers", {}).get("default_output_dir", "trainers")))
        if not root.is_absolute():
            root = config_path.parent / root
        return root

    def _safe_run_name(value: str) -> str:
        cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", value.strip()).strip(".-")
        return cleaned or datetime.now(timezone.utc).strftime("run-%Y%m%dT%H%M%SZ")

    def _adapter_for_backend(backend: str):
        adapters = load_trainer_adapters(settings, config_path)
        adapter = find_adapter(adapters, backend)
        if adapter is None:
            raise HTTPException(status_code=400, detail=f"Unknown backend '{backend}'.")
        return adapters, adapter

    def _routes_for_backend(backend: str, model_family: str) -> dict[str, dict[str, str]]:
        routes = build_trainer_routes(settings)
        route = routes.get(model_family, {})
        entrypoint = route.get("entrypoint", "") if route.get("trainer") == backend else ""
        return {model_family: {"trainer": backend, "entrypoint": entrypoint}}

    def _metadata_for_run(run: Any) -> dict[str, Any]:
        if not run["metadata_json"]:
            return {}
        try:
            return json.loads(run["metadata_json"])
        except json.JSONDecodeError:
            return {}

    def _write_metadata(run_id: int, metadata: dict[str, Any]) -> None:
        with db.connect(db_path) as connection:
            connection.execute(
                "UPDATE lora_training_runs SET metadata_json = ? WHERE id = ?",
                (json.dumps(metadata), run_id),
            )
            connection.commit()

    def _set_status(run_id: int, status: str, ended_at: str | None = None) -> None:
        with db.connect(db_path) as connection:
            db.update_lora_training_run_status(connection, run_id, status, ended_at=ended_at)
            connection.commit()

    def _find_output_lora(output_dir: Path) -> Path | None:
        artifacts = [p for p in collect_artifacts(output_dir) if p.suffix == ".safetensors"]
        if not artifacts:
            return None
        return max(artifacts, key=lambda path: path.stat().st_mtime)

    def _run_job(
        run_id: int,
        commands: list[list[str]],
        cwd: Path | None,
        env: dict[str, str],
        output_dir: Path,
        params: dict[str, Any],
    ) -> None:
        threshold = float(params.get("divergence_loss_threshold", 100.0) or 0.0)
        metadata = {
            "progress": 0.0,
            "step": 0,
            "total_steps": 0,
            "log_tail": [],
            "last_loss": None,
            "last_pred_std": None,
            "loss_history": [],
            "max_loss": None,
            "diverged": False,
        }
        _write_metadata(run_id, metadata)
        _set_status(run_id, "running")
        try:
            for command in commands:
                if run_id in _CANCELLED:
                    metadata["cancelled"] = True
                    _write_metadata(run_id, metadata)
                    # Re-assert: a cancel that raced a queued job was overwritten by "running".
                    _set_status(run_id, "error", datetime.now(timezone.utc).isoformat())
                    return
                metadata["current_command"] = command
                _write_metadata(run_id, metadata)
                process = subprocess.Popen(  # noqa: S603
                    command,
                    cwd=str(cwd) if cwd else None,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    env=env,
                    start_new_session=os.name == "posix",
                )
                _PROCESSES[run_id] = process
                assert process.stdout is not None
                for line in process.stdout:
                    _append_training_log(metadata, line)
                    if _loss_exceeded_threshold(metadata, threshold):
                        _signal_process_group(process, signal.SIGTERM)
                        metadata["diverged"] = True
                        metadata["error"] = (
                            f"training diverged (avr_loss={metadata['last_loss']} exceeded threshold {threshold})"
                        )
                        _write_metadata(run_id, metadata)
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            _signal_process_group(process, getattr(signal, "SIGKILL", signal.SIGTERM))
                            process.wait()
                        _set_status(run_id, "error", datetime.now(timezone.utc).isoformat())
                        return
                    _write_metadata(run_id, metadata)
                returncode = process.wait()
                if run_id in _CANCELLED:
                    metadata["cancelled"] = True
                    metadata["returncode"] = returncode
                    _write_metadata(run_id, metadata)
                    _set_status(run_id, "error", datetime.now(timezone.utc).isoformat())
                    return
                if returncode != 0:
                    metadata["returncode"] = returncode
                    _write_metadata(run_id, metadata)
                    _set_status(run_id, "error", datetime.now(timezone.utc).isoformat())
                    return
            output_lora = _find_output_lora(output_dir)
            if output_lora:
                metadata["output_lora_path"] = str(output_lora)
                with db.connect(db_path) as connection:
                    db.insert_lora_artifact(
                        connection,
                        run_id=run_id,
                        artifact_type="lora",
                        path=str(output_lora),
                        metadata={"source": "training-api"},
                    )
                    connection.commit()
            metadata["progress"] = 1.0
            _write_metadata(run_id, metadata)
            _set_status(run_id, "done", datetime.now(timezone.utc).isoformat())
        except Exception as exc:
            metadata["error"] = str(exc)
            _write_metadata(run_id, metadata)
            _set_status(run_id, "error", datetime.now(timezone.utc).isoformat())
        finally:
            # Never orphan a live trainer (e.g. an exception while streaming its output).
            process = _PROCESSES.pop(run_id, None)
            if process is not None and process.poll() is None:
                _terminate_process(process)
            _CANCELLED.discard(run_id)

    def _image_paths_from_request(dataset: TrainingDatasetRequest) -> tuple[list[Path], int | None]:
        if dataset.images_dir:
            try:
                root = indexing.check_folder(dataset.images_dir)
            except indexing.FolderRefused as exc:
                raise HTTPException(status_code=403, detail=str(exc)) from exc
            return (
                sorted(path for path in root.iterdir() if path.suffix.lower() in IMAGE_SUFFIXES),
                None,
            )
        if dataset.cluster_id is None:
            raise HTTPException(status_code=400, detail="Provide dataset.images_dir or dataset.cluster_id.")
        with db.connect(db_path) as connection:
            asset_ids = db.fetch_cluster_member_asset_ids(connection, dataset.cluster_id)
            assets = db.fetch_assets_by_ids(connection, asset_ids)
        return [Path(str(asset["source_path"])) for asset in assets], dataset.cluster_id

    @router.get("/backends")
    async def get_training_backends() -> dict[str, object]:
        adapters = load_trainer_adapters(settings, config_path)
        routes = build_trainer_routes(settings)
        template_families: dict[str, set[str]] = {}
        for adapter in adapters:
            families = set()
            if adapter.template_config_dir and adapter.template_config_dir.exists():
                families.update(path.stem for path in adapter.template_config_dir.glob("*.toml"))
                families.discard("krea2.dataset")
            for family, route in routes.items():
                if route.get("trainer") == adapter.name:
                    families.add(family)
            template_families[adapter.name] = families
        return {
            "backends": [
                {
                    "name": adapter.name,
                    "installed": detect_install(adapter),
                    "version": detect_version(adapter),
                    "model_families": sorted(template_families.get(adapter.name, set())),
                }
                for adapter in adapters
            ]
        }

    @router.post("/jobs")
    async def create_training_job(payload: TrainingJobRequest) -> dict[str, object]:
        adapters, adapter = _adapter_for_backend(payload.backend)
        image_paths, cluster_id = _image_paths_from_request(payload.dataset)
        image_paths = [path for path in image_paths if path.exists()]
        if not image_paths:
            raise HTTPException(status_code=400, detail="No valid training images found.")
        params = dict(payload.params or {})
        if payload.dataset.caption_ext or params.get("caption_ext"):
            params["caption_ext"] = _clean_caption_ext(
                payload.dataset.caption_ext or params.get("caption_ext")
            )
        if "trigger_word" in params:
            params["trigger_word"] = _clean_trigger_word(params["trigger_word"])
        run_name = _safe_run_name(payload.run_name)
        output_dir = _trainer_root() / "runs" / run_name
        manifest_path = build_dataset_manifest(
            output_root=_trainer_root() / "datasets",
            image_paths=image_paths,
            model_family=payload.model_family,
            cluster_id=cluster_id,
            extra={"caption_ext": params.get("caption_ext")},
        )
        try:
            plan = build_train_plan(
                settings=settings,
                config_path=config_path,
                adapters=adapters,
                routes=_routes_for_backend(payload.backend, payload.model_family),
                model_family=payload.model_family,
                dataset_manifest_path=manifest_path,
                output_dir=output_dir,
                base_model=None,
                dry_run=False,
                params=params,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        # Only write captions once the trainer is known to be able to run.
        _auto_caption_missing_sidecars(image_paths, params, settings)
        env = dict(os.environ)
        env.update(adapter.extra_env)
        with db.connect(db_path) as connection:
            run_id = db.insert_lora_training_run(
                connection,
                method="lora",
                trainer_name=payload.backend,
                model_family=payload.model_family,
                status="queued",
                command=plan.commands[0],
                metadata={
                    "commands": plan.commands,
                    "progress": 0.0,
                    "step": 0,
                    "total_steps": int(params.get("steps", 0) or 0),
                    "log_tail": [],
                    "last_loss": None,
                    "last_pred_std": None,
                    "loss_history": [],
                    "max_loss": None,
                    "diverged": False,
                    "run_name": run_name,
                    "output_dir": str(output_dir),
                },
                dataset_manifest_path=str(manifest_path),
                config_path=str(plan.rendered_config_path) if plan.rendered_config_path else None,
            )
            connection.commit()
        thread = threading.Thread(
            target=_run_job,
            args=(run_id, plan.commands, adapter.path, env, output_dir, params),
            daemon=True,
        )
        thread.start()
        return {"job_id": run_id, "status": "queued"}

    @router.get("/jobs")
    async def list_training_jobs() -> list[dict[str, object]]:
        with db.connect(db_path) as connection:
            runs = db.fetch_lora_training_runs(connection, limit=200)
        return [
            {
                "job_id": int(run["id"]),
                "backend": str(run["trainer_name"]),
                "model_family": str(run["model_family"]),
                "status": str(run["status"]),
                "created_at": str(run["started_at"]),
            }
            for run in runs
        ]

    @router.get("/jobs/{job_id}")
    async def get_training_job(job_id: int) -> dict[str, object]:
        with db.connect(db_path) as connection:
            run = db.fetch_lora_training_run_by_id(connection, job_id)
            if run is None:
                raise HTTPException(status_code=404, detail="Training job not found.")
        metadata = _metadata_for_run(run)
        return {
            "job_id": int(run["id"]),
            "status": str(run["status"]),
            "progress": float(metadata.get("progress", 0.0) or 0.0),
            "step": int(metadata.get("step", 0) or 0),
            "total_steps": int(metadata.get("total_steps", 0) or 0),
            "log_tail": "\n".join(str(line) for line in metadata.get("log_tail", [])),
            "output_lora_path": metadata.get("output_lora_path"),
            "last_loss": metadata.get("last_loss"),
            "last_pred_std": metadata.get("last_pred_std"),
            "loss_history": list(metadata.get("loss_history", [])),
            "max_loss": metadata.get("max_loss"),
            "diverged": bool(metadata.get("diverged", False)),
        }

    @router.post("/jobs/{job_id}/cancel")
    async def cancel_training_job(job_id: int) -> dict[str, object]:
        with db.connect(db_path) as connection:
            run = db.fetch_lora_training_run_by_id(connection, job_id)
        if run is None:
            raise HTTPException(status_code=404, detail="Training job not found.")
        if str(run["status"]) not in {"queued", "running"}:
            # Finished jobs keep their status; cancelling a "done" run must not flip it to error.
            return {"ok": True, "status": str(run["status"])}
        _CANCELLED.add(job_id)
        process = _PROCESSES.get(job_id)
        if process and process.poll() is None:
            _signal_process_group(process, signal.SIGTERM)
        _set_status(job_id, "error", datetime.now(timezone.utc).isoformat())
        return {"ok": True}

    @router.post("/jobs/{job_id}/deploy")
    async def deploy_training_job(job_id: int, payload: TrainingDeployRequest) -> dict[str, object]:
        with db.connect(db_path) as connection:
            run = db.fetch_lora_training_run_by_id(connection, job_id)
            if run is None:
                raise HTTPException(status_code=404, detail="Training job not found.")
        metadata = _metadata_for_run(run)
        output_lora = metadata.get("output_lora_path")
        if not output_lora:
            raise HTTPException(status_code=400, detail="Training job has no LoRA output.")
        source = Path(str(output_lora))
        if not source.exists():
            raise HTTPException(status_code=404, detail="LoRA output file not found.")
        if payload.lora_dir:
            target_dir = Path(payload.lora_dir).expanduser()
        elif "comfyui_path" in paths:
            target_dir = paths["comfyui_path"] / "models" / "loras"
        else:
            raise HTTPException(
                status_code=400,
                detail="Set STYLEVAULT_COMFYUI_PATH or pass lora_dir to deploy a LoRA.",
            )
        target_dir.mkdir(parents=True, exist_ok=True)
        lora_name = payload.name or source.stem
        if not lora_name.endswith(".safetensors"):
            lora_name = f"{lora_name}.safetensors"
        target = target_dir / Path(lora_name).name
        if target.exists() or target.is_symlink():
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            target = target.with_name(f"{target.stem}-{stamp}{target.suffix}")
        try:
            target.symlink_to(source.resolve())
        except OSError:
            shutil.copy2(source, target)
        return {"deployed_path": str(target), "lora_name": target.stem}

    return router

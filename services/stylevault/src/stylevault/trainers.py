from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from importlib import resources
import json
from pathlib import Path
import os
import shutil
import re
import subprocess
import tomllib
from typing import Any

from stylevault import db


@dataclass(frozen=True)
class TrainerAdapterInfo:
    name: str
    path: Path | None
    python_bin: Path | None
    accelerate_config_path: Path | None
    template_config_dir: Path | None
    extra_env: dict[str, str]
    exists: bool
    version: str | None


@dataclass(frozen=True)
class TrainerRunPlan:
    trainer_name: str
    model_family: str
    entrypoint: str
    command: list[str]
    commands: list[list[str]]
    config_path: Path | None
    rendered_config_path: Path | None
    dataset_manifest_path: Path | None


def _resolve_optional_path(value: object, base_dir: Path) -> Path | None:
    if not value:
        return None
    path = Path(str(value)).expanduser()
    if not path.is_absolute():
        path = (base_dir / path).resolve()
    return path


def _detect_git_version(path: Path) -> str | None:
    if not (path / ".git").exists():
        return None
    try:
        result = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            check=False,
            text=True,
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _run_git(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            ["git", "-C", str(cwd), *args],
            capture_output=True,
            check=False,
            text=True,
        )
    except OSError:
        return None


def _git_output(args: list[str], cwd: Path) -> str | None:
    result = _run_git(args, cwd)
    if result is None or result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _detect_git_tag(path: Path) -> str | None:
    return _git_output(["describe", "--tags", "--abbrev=0"], path)


def _detect_git_commit(path: Path) -> str | None:
    return _git_output(["rev-parse", "HEAD"], path)


def _detect_git_dirty(path: Path) -> bool | None:
    result = _run_git(["status", "--porcelain"], path)
    if result is None or result.returncode != 0:
        return None
    return bool(result.stdout.strip())


def _resolve_trainer_output_dir(settings: dict[str, Any], config_path: Path) -> Path:
    trainers_cfg = settings.get("trainers", {})
    output_dir = trainers_cfg.get("default_output_dir") or "trainers"
    path = Path(str(output_dir))
    if not path.is_absolute():
        path = config_path.parent / path
    return path


def _lock_path(settings: dict[str, Any], config_path: Path) -> Path:
    return _resolve_trainer_output_dir(settings, config_path) / "trainer-lock.json"


def lock_trainers(
    adapters: list[TrainerAdapterInfo],
    settings: dict[str, Any],
    config_path: Path,
) -> Path:
    lock_entries: dict[str, dict[str, object]] = {}
    for adapter in adapters:
        if not adapter.path or not adapter.path.exists():
            lock_entries[adapter.name] = {
                "path": str(adapter.path) if adapter.path else "",
                "present": False,
            }
            continue
        lock_entries[adapter.name] = {
            "path": str(adapter.path),
            "present": True,
            "commit": _detect_git_commit(adapter.path),
            "tag": _detect_git_tag(adapter.path),
            "dirty": _detect_git_dirty(adapter.path),
        }
    lock_payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "trainers": lock_entries,
    }
    lock_path = _lock_path(settings, config_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text(json.dumps(lock_payload, indent=2), encoding="utf-8")
    return lock_path


def update_trainers(
    adapters: list[TrainerAdapterInfo],
    trainer_names: set[str] | None = None,
) -> dict[str, str]:
    results: dict[str, str] = {}
    for adapter in adapters:
        if trainer_names and adapter.name not in trainer_names:
            continue
        if not adapter.path or not adapter.path.exists():
            results[adapter.name] = "missing"
            continue
        result = _run_git(["pull", "--ff-only"], adapter.path)
        if result is None:
            results[adapter.name] = "git-unavailable"
        elif result.returncode != 0:
            results[adapter.name] = "pull-failed"
        else:
            results[adapter.name] = "updated"
    return results


def load_trainer_adapters(settings: dict[str, Any], config_path: Path) -> list[TrainerAdapterInfo]:
    trainers_cfg = settings.get("trainers", {})
    adapters_cfg = trainers_cfg.get("adapters", {})
    base_dir = config_path.parent
    adapters: list[TrainerAdapterInfo] = []
    if not isinstance(adapters_cfg, dict):
        return adapters
    for name, adapter_cfg in adapters_cfg.items():
        adapter_cfg = adapter_cfg if isinstance(adapter_cfg, dict) else {}
        path = _resolve_optional_path(adapter_cfg.get("path_to_repo"), base_dir)
        python_bin = _resolve_optional_path(adapter_cfg.get("python_bin"), base_dir)
        accelerate_config_path = _resolve_optional_path(
            adapter_cfg.get("accelerate_config_path"),
            base_dir,
        )
        template_config_dir = _resolve_optional_path(
            adapter_cfg.get("template_config_dir"),
            base_dir,
        )
        extra_env = adapter_cfg.get("extra_env")
        extra_env = extra_env if isinstance(extra_env, dict) else {}
        extra_env = {str(key): str(value) for key, value in extra_env.items()}
        exists = bool(path and path.exists())
        version = _detect_git_version(path) if path else None
        adapters.append(
            TrainerAdapterInfo(
                name=str(name),
                path=path,
                python_bin=python_bin,
                accelerate_config_path=accelerate_config_path,
                template_config_dir=template_config_dir,
                extra_env=extra_env,
                exists=exists,
                version=version,
            )
        )
    return adapters


def build_trainer_routes(settings: dict[str, Any]) -> dict[str, dict[str, str]]:
    trainers_cfg = settings.get("trainers", {})
    routing_cfg = trainers_cfg.get("routing", {})
    routes: dict[str, dict[str, str]] = {}
    if not isinstance(routing_cfg, dict):
        return routes
    for model_family, route in routing_cfg.items():
        route = route if isinstance(route, dict) else {}
        trainer = route.get("trainer")
        entrypoint = route.get("entrypoint")
        if trainer or entrypoint:
            routes[str(model_family)] = {
                "trainer": str(trainer) if trainer else "",
                "entrypoint": str(entrypoint) if entrypoint else "",
            }
    return routes


def diagnose_trainers(
    adapters: list[TrainerAdapterInfo],
    routes: dict[str, dict[str, str]],
) -> list[str]:
    issues: list[str] = []
    adapter_index = {adapter.name: adapter for adapter in adapters}
    for model_family, route in routes.items():
        trainer_name = route.get("trainer") or ""
        entrypoint = route.get("entrypoint") or ""
        if not trainer_name:
            issues.append(f"routing.{model_family} is missing a trainer name.")
            continue
        adapter = adapter_index.get(trainer_name)
        if adapter is None:
            issues.append(f"routing.{model_family} references unknown trainer '{trainer_name}'.")
            continue
        if not adapter.exists:
            issues.append(f"trainer '{trainer_name}' repo path is missing.")
            continue
        if entrypoint:
            entrypoint_path = adapter.path / entrypoint
            if not entrypoint_path.exists():
                issues.append(
                    f"trainer '{trainer_name}' entrypoint '{entrypoint}' not found for {model_family}."
                )
    for adapter in adapters:
        if adapter.python_bin and not adapter.python_bin.exists():
            issues.append(f"trainer '{adapter.name}' python_bin not found.")
        if adapter.accelerate_config_path and not adapter.accelerate_config_path.exists():
            issues.append(f"trainer '{adapter.name}' accelerate_config_path not found.")
        if adapter.template_config_dir and not adapter.template_config_dir.exists():
            issues.append(f"trainer '{adapter.name}' template_config_dir not found.")
    return issues


def find_adapter(adapters: list[TrainerAdapterInfo], name: str) -> TrainerAdapterInfo | None:
    for adapter in adapters:
        if adapter.name == name:
            return adapter
    return None


def supported_model_families(routes: dict[str, dict[str, str]], trainer_name: str) -> list[str]:
    families: list[str] = []
    for model_family, route in routes.items():
        if (route.get("trainer") or "") == trainer_name:
            families.append(model_family)
    return sorted(families)


def detect_install(adapter: TrainerAdapterInfo) -> bool:
    return bool(adapter.path and adapter.path.exists())


def detect_version(adapter: TrainerAdapterInfo) -> str | None:
    if not adapter.path:
        return None
    return _detect_git_commit(adapter.path) or adapter.version


def check_model_family(value: str) -> str:
    """model_family becomes part of folder and file names, so keep it a plain name."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", value) or ".." in value:
        raise ValueError("model_family may only contain letters, numbers, '_', '-' and '.'.")
    return value


def build_dataset_manifest(
    *,
    output_root: Path,
    image_paths: list[Path],
    model_family: str,
    cluster_id: int | None,
    extra: dict[str, object] | None = None,
) -> Path:
    output_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dataset_dir = output_root / f"dataset-{model_family}-{timestamp}"
    dataset_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, object]] = []
    for source in image_paths:
        target = dataset_dir / source.name
        if target.exists() or target.is_symlink():
            timestamp_suffix = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            target = target.with_name(f"{target.stem}-{timestamp_suffix}{target.suffix}")
        if source.exists():
            try:
                target.symlink_to(source.resolve())
                link_mode = "symlink"
            except OSError:
                shutil.copy2(source, target)
                link_mode = "copy"
        else:
            link_mode = "missing"
        records.append({
            "source_path": str(source),
            "dataset_path": str(target),
            "link_mode": link_mode,
        })
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model_family": model_family,
        "cluster_id": cluster_id,
        "images": records,
    }
    if extra:
        manifest["extra"] = extra
    manifest_path = dataset_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest_path




def _required_model_path(models: dict, key: str) -> str:
    value = str(models.get(key) or "").strip()
    if not value:
        raise ValueError(f"Set models.{key} in the trainer config template to a local file path.")
    return value


def build_train_plan(
    *,
    settings: dict[str, Any],
    config_path: Path,
    adapters: list[TrainerAdapterInfo],
    routes: dict[str, dict[str, str]],
    model_family: str,
    dataset_manifest_path: Path,
    output_dir: Path,
    base_model: str | None,
    dry_run: bool,
    params: dict[str, object] | None = None,
) -> TrainerRunPlan:
    route = routes.get(model_family, {})
    trainer_name = route.get("trainer") or settings.get("trainers", {}).get("default_trainer") or ""
    entrypoint = route.get("entrypoint") or ""
    adapter = find_adapter(adapters, trainer_name)
    if adapter is None:
        raise ValueError(f"No trainer adapter configured for '{trainer_name}'.")
    if not detect_install(adapter):
        raise ValueError(f"Trainer '{trainer_name}' is not installed at {adapter.path}.")
    if not entrypoint:
        entrypoint = _default_entrypoint_for_adapter(trainer_name, model_family)
    if not entrypoint:
        raise ValueError(f"No trainer entrypoint configured for model family '{model_family}'.")

    trainer_python = str(adapter.python_bin) if adapter.python_bin else "python"
    trainer_script = str((adapter.path / entrypoint).resolve()) if adapter.path else entrypoint
    output_dir.mkdir(parents=True, exist_ok=True)

    trainer_config_path = None
    if adapter.template_config_dir and adapter.template_config_dir.exists():
        trainer_config_path = adapter.template_config_dir / f"{model_family}.toml"

    rendered_config_path = _render_trainer_config(
        adapter=adapter,
        model_family=model_family,
        output_dir=output_dir,
        dataset_manifest_path=dataset_manifest_path,
        base_model=base_model,
        template_path=trainer_config_path,
        params=params,
    )

    command = _build_adapter_command(
        adapter=adapter,
        trainer_python=trainer_python,
        trainer_script=trainer_script,
        dataset_manifest_path=dataset_manifest_path,
        output_dir=output_dir,
        rendered_config_path=rendered_config_path,
        base_model=base_model,
        params=params,
    )
    commands = [command]
    if adapter.name == "musubi-tuner" and model_family == "krea2":
        commands = _build_musubi_krea2_commands(
            adapter=adapter,
            trainer_python=trainer_python,
            dataset_manifest_path=dataset_manifest_path,
            output_dir=output_dir,
            rendered_config_path=rendered_config_path,
            params=params,
        )
        command = commands[-1]
    if dry_run:
        commands = [cmd + ["--help"] for cmd in commands]
        command = commands[-1]

    return TrainerRunPlan(
        trainer_name=trainer_name,
        model_family=model_family,
        entrypoint=entrypoint,
        command=command,
        commands=commands,
        config_path=trainer_config_path,
        rendered_config_path=rendered_config_path,
        dataset_manifest_path=dataset_manifest_path,
    )


def _default_entrypoint_for_adapter(trainer_name: str, model_family: str) -> str:
    family = model_family.lower()
    if trainer_name == "sd-scripts":
        if family == "sdxl":
            return "sdxl_train_network.py"
        if family in {"sd1", "sd2", "sd15", "sd2x"}:
            return "train_network.py"
        if family.startswith("flux"):
            return "flux_train_network.py"
        if family == "sd3":
            return "sd3_train_network.py"
    if trainer_name == "musubi-tuner":
        if family == "krea2":
            return "src/musubi_tuner/krea2_train_network.py"
        return "train_network.py"
    if trainer_name == "ai-toolkit":
        return "run.py"
    return ""


def _render_trainer_config(
    *,
    adapter: TrainerAdapterInfo,
    model_family: str,
    output_dir: Path,
    dataset_manifest_path: Path,
    base_model: str | None,
    template_path: Path | None,
    params: dict[str, object] | None = None,
) -> Path | None:
    if not template_path or not template_path.exists():
        return None
    try:
        template_text = template_path.read_text(encoding="utf-8")
    except OSError:
        return None
    params = params or {}
    rendered = template_text
    replacements = {
        "{{dataset_manifest}}": str(dataset_manifest_path),
        "{{dataset_dir}}": str(dataset_manifest_path.parent),
        "{{output_dir}}": str(output_dir),
        "{{base_model}}": base_model or "",
        # Resolved model path for configs that need one even when the caller passes none
        # explicit arg > params > STYLEVAULT_BASE_MODEL_<FAMILY> env.
        "{{model_path}}": str(
            base_model
            or params.get("base_model")
            or os.environ.get(f"STYLEVAULT_BASE_MODEL_{model_family.upper().replace('-', '_')}", "")
        ),
        "{{assistant_lora_path}}": str(
            params.get(
                "assistant_lora_path",
                "ostris/krea2_turbo_training_adapter/krea2_turbo_training_adapter_v1.safetensors",
            )
        ),
        "{{model_family}}": model_family,
        "{{run_name}}": output_dir.name,
        "{{steps}}": str(params.get("steps", 1500)),
        "{{lr}}": str(params.get("lr", "1e-4")),
        "{{rank}}": str(params.get("rank", 16)),
        "{{resolution}}": str(params.get("resolution", 1024)),
        "{{caption_ext}}": str(params.get("caption_ext", ".txt")),
        # ai-toolkit configs take the extension without the leading dot
        "{{caption_ext_nodot}}": str(params.get("caption_ext", ".txt")).lstrip("."),
        "{{trigger_word}}": str(params.get("trigger_word", "")),
        "{{blocks_to_swap}}": str(params.get("blocks_to_swap", 20)),
    }
    for key, value in replacements.items():
        rendered = rendered.replace(key, value)
    if rendered == template_text:
        return None
    suffix = ".yaml" if adapter.name == "ai-toolkit" and rendered.lstrip().startswith("---") else ".toml"
    target_path = output_dir / f"{adapter.name}-{model_family}.rendered{suffix}"
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_text(rendered, encoding="utf-8")
    if adapter.name == "musubi-tuner" and model_family == "krea2":
        dataset_template = template_path.with_name(f"{model_family}.dataset.toml")
        if dataset_template.exists():
            dataset_text = dataset_template.read_text(encoding="utf-8")
            for key, value in replacements.items():
                dataset_text = dataset_text.replace(key, value)
            dataset_path = output_dir / f"{adapter.name}-{model_family}.dataset.rendered.toml"
            dataset_path.write_text(dataset_text, encoding="utf-8")
    return target_path


def _build_adapter_command(
    *,
    adapter: TrainerAdapterInfo,
    trainer_python: str,
    trainer_script: str,
    dataset_manifest_path: Path,
    output_dir: Path,
    rendered_config_path: Path | None,
    base_model: str | None,
    params: dict[str, object] | None = None,
) -> list[str]:
    command = [trainer_python, trainer_script]
    if adapter.accelerate_config_path and adapter.accelerate_config_path.exists():
        command = [
            trainer_python,
            "-m",
            "accelerate.commands.launch",
            "--config_file",
            str(adapter.accelerate_config_path),
            trainer_script,
        ]

    if adapter.name == "sd-scripts":
        command.extend(["--dataset_config", str(dataset_manifest_path), "--output_dir", str(output_dir)])
        if base_model:
            command.extend(["--pretrained_model_name_or_path", base_model])
    elif adapter.name == "ai-toolkit":
        if rendered_config_path:
            # run.py only takes config files (+ -r/-n/-l); the base model lives in the config.
            command.append(str(rendered_config_path))
        else:
            command.extend(["--dataset-manifest", str(dataset_manifest_path), "--output-dir", str(output_dir)])
            if base_model:
                command.extend(["--base-model", base_model])
    elif adapter.name == "musubi-tuner":
        command.extend(["--dataset-manifest", str(dataset_manifest_path), "--output-dir", str(output_dir)])
        if rendered_config_path:
            command.extend(["--config", str(rendered_config_path)])
        if base_model:
            command.extend(["--base-model", base_model])
    else:
        command.extend(["--dataset-manifest", str(dataset_manifest_path), "--output-dir", str(output_dir)])
    return command


def _config_values(rendered_config_path: Path | None) -> dict[str, Any]:
    if not rendered_config_path or not rendered_config_path.exists():
        return {}
    try:
        return tomllib.loads(rendered_config_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def _musubi_dataset_config_path(
    *,
    adapter: TrainerAdapterInfo,
    model_family: str,
    output_dir: Path,
    rendered_config_path: Path | None,
) -> Path:
    candidate = output_dir / f"{adapter.name}-{model_family}.dataset.rendered.toml"
    if candidate.exists():
        return candidate
    return rendered_config_path or candidate


def _build_accelerate_command(
    *,
    adapter: TrainerAdapterInfo,
    trainer_python: str,
    trainer_script: str,
) -> list[str]:
    command = [trainer_python, "-m", "accelerate.commands.launch"]
    if adapter.accelerate_config_path and adapter.accelerate_config_path.exists():
        command.extend(["--config_file", str(adapter.accelerate_config_path)])
    command.extend(["--num_cpu_threads_per_process", "1", "--mixed_precision", "bf16", trainer_script])
    return command


def _build_musubi_krea2_commands(
    *,
    adapter: TrainerAdapterInfo,
    trainer_python: str,
    dataset_manifest_path: Path,
    output_dir: Path,
    rendered_config_path: Path | None,
    params: dict[str, object] | None,
) -> list[list[str]]:
    params = params or {}
    config = _config_values(rendered_config_path)
    models = config.get("models", {}) if isinstance(config.get("models"), dict) else {}
    train = config.get("train", {}) if isinstance(config.get("train"), dict) else {}
    raw_dit = _required_model_path(models, "raw_dit")
    text_encoder = _required_model_path(models, "text_encoder")
    vae = _required_model_path(models, "vae")
    lr = str(params.get("lr", train.get("lr", "5e-5")))
    rank = str(params.get("rank", train.get("rank", 16)))
    steps = str(params.get("steps", train.get("steps", 1500)))
    # musubi caps block-swap at num_blocks-2 (=26 for Krea2's 28 blocks); clamp to avoid the assert.
    blocks_to_swap = str(min(int(params.get("blocks_to_swap", train.get("blocks_to_swap", 20))), 26))
    dataset_config = _musubi_dataset_config_path(
        adapter=adapter,
        model_family="krea2",
        output_dir=output_dir,
        rendered_config_path=rendered_config_path,
    )
    repo = adapter.path or Path(".")
    latent_script = str((repo / "src/musubi_tuner/krea2_cache_latents.py").resolve())
    text_script = str((repo / "src/musubi_tuner/krea2_cache_text_encoder_outputs.py").resolve())
    train_script = str((repo / "src/musubi_tuner/krea2_train_network.py").resolve())
    cache_latents = [
        trainer_python,
        latent_script,
        "--dataset_config",
        str(dataset_config),
        "--vae",
        vae,
    ]
    cache_text = [
        trainer_python,
        text_script,
        "--dataset_config",
        str(dataset_config),
        "--text_encoder",
        text_encoder,
        "--batch_size",
        "1",
    ]
    train_cmd = _build_accelerate_command(
        adapter=adapter,
        trainer_python=trainer_python,
        trainer_script=train_script,
    )
    train_cmd.extend(
        [
            "--dit",
            raw_dit,
            "--vae",
            vae,
            "--dataset_config",
            str(dataset_config),
            "--sdpa",
            "--mixed_precision",
            "bf16",
            "--timestep_sampling",
            "shift",
            "--weighting_scheme",
            "none",
            "--discrete_flow_shift",
            "2.5",
            "--optimizer_type",
            "adamw8bit",
            "--learning_rate",
            lr,
            "--gradient_checkpointing",
            # Krea2's shared txtfusion/projector layers see ~380-magnitude Qwen3-VL activations;
            # without warmup + grad clipping the first optimizer step overshoots and training
            # diverges to ~1e6 loss (verified). Warmup lets AdamW settle before full LR.
            "--max_grad_norm",
            "1.0",
            "--lr_scheduler",
            "constant_with_warmup",
            "--lr_warmup_steps",
            str(params.get("lr_warmup_steps", train.get("lr_warmup_steps", "0.05"))),
            "--max_data_loader_n_workers",
            "2",
            "--persistent_data_loader_workers",
            "--network_module",
            "networks.lora_krea2",
            "--network_dim",
            rank,
            "--network_alpha",
            rank,
            "--max_train_steps",
            steps,
            "--save_every_n_steps",
            "500",
            "--seed",
            "42",
            "--output_dir",
            str(output_dir),
            "--output_name",
            output_dir.name,
            "--fp8_base",
            "--fp8_scaled",
            "--blocks_to_swap",
            blocks_to_swap,
        ]
    )
    if params.get("exclude_shared", True):
        network_index = train_cmd.index("--network_dim")
        train_cmd[network_index:network_index] = [
            "--network_args",
            r'exclude_patterns=["first","last\..*","tmlp\..*","txtmlp\..*","tproj\..*","txtfusion\..*"]',
        ]
    return [cache_latents, cache_text, train_cmd]


def run_train(
    plan: TrainerRunPlan,
    *,
    adapter: TrainerAdapterInfo,
    dry_run: bool,
) -> tuple[int, str, str]:
    merged_env = dict(os.environ)
    merged_env.update(adapter.extra_env)
    if dry_run:
        return (0, "dry-run", "dry-run")
    stdout_parts: list[str] = []
    stderr_parts: list[str] = []
    last_returncode = 0
    for command in plan.commands:
        result = subprocess.run(
            command,
            cwd=str(adapter.path) if adapter.path else None,
            capture_output=True,
            check=False,
            text=True,
            env=merged_env,
        )
        last_returncode = result.returncode
        stdout_parts.append(result.stdout)
        stderr_parts.append(result.stderr)
        if result.returncode != 0:
            return result.returncode, "\n".join(stdout_parts), "\n".join(stderr_parts)
    return last_returncode, "\n".join(stdout_parts), "\n".join(stderr_parts)


def collect_artifacts(output_dir: Path) -> list[Path]:
    artifacts: list[Path] = []
    if not output_dir.exists():
        return artifacts
    for pattern in ("*.safetensors", "*.pt", "*.ckpt", "*.json", "*.log"):
        artifacts.extend(sorted(output_dir.glob(pattern)))
    return artifacts


def load_known_good_matrix() -> dict[str, Any]:
    try:
        matrix_path = resources.files("stylevault").joinpath("data/known_good_trainers.json")
        return json.loads(matrix_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}

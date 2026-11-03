from __future__ import annotations

import time
from pathlib import Path

from stylevault import db
from stylevault.config import load_config, resolve_config_paths


def watch_comfyui_output(
    config_path: Path = Path("config.toml"),
    interval: float = 30.0,
    once: bool = False,
) -> None:
    settings = load_config(config_path)
    paths = resolve_config_paths(settings, config_path)
    db_path = paths["db_path"]
    comfyui_cfg = settings.get("comfyui", {})
    comfyui_path_str = comfyui_cfg.get("path", "")
    if not comfyui_path_str:
        raise ValueError("comfyui.path not configured in config.toml.")
    comfyui_path = Path(comfyui_path_str).expanduser()
    output_dir = comfyui_path / "output"
    extra_dirs = comfyui_cfg.get("output_scan_dirs", [])
    scan_dirs = [output_dir] + [Path(d).expanduser() for d in extra_dirs]
    scan_dirs = [d for d in scan_dirs if d.is_dir()]
    if not scan_dirs:
        raise ValueError(f"No valid output directories found: {scan_dirs}")

    from stylevault.scan import scan_directory

    scan_settings = settings.get("scan", {})
    while True:
        total_new = 0
        for scan_dir in scan_dirs:
            with db.connect(db_path) as connection:
                stats = scan_directory(
                    connection,
                    scan_dir,
                    thumbs_dir=paths["thumbs_dir"],
                    exclude_globs=scan_settings.get("exclude_globs", []),
                    workers=scan_settings.get("workers", 4),
                )
                connection.commit()
            total_new += stats.get("new", 0)
        if total_new > 0:
            print(f"[watcher] Ingested {total_new} new images")
        if once:
            break
        time.sleep(interval)

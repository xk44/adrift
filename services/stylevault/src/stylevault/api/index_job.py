"""POST /library/index and GET /library/index/status: one background index job at a time."""

from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from stylevault import indexing


class IndexRequest(BaseModel):
    folder: str


def build_index_router(settings: dict, config_path: Path, paths: dict[str, Path]) -> APIRouter:
    router = APIRouter(prefix="/library", tags=["library"])
    lock = threading.Lock()
    status: dict[str, Any] = {"state": "idle", "step": "", "done": 0, "total": 0, "error": None}

    def report(progress: indexing.IndexProgress) -> None:
        with lock:
            status.update(step=progress.step, done=progress.done, total=progress.total)

    def worker(folder: Path) -> None:
        try:
            indexing.run_index(folder, settings, config_path, paths, report)
        except Exception as exc:  # noqa: BLE001 - shown to the user through the status route
            with lock:
                status.update(state="error", error=str(exc) or type(exc).__name__)
        else:
            with lock:
                status.update(state="done")

    @router.post("/index")
    def start_index(payload: IndexRequest) -> dict[str, str]:
        try:
            folder = indexing.check_folder(payload.folder)
        except indexing.FolderRefused as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc
        with lock:
            if status["state"] == "running":
                raise HTTPException(status_code=409, detail="An index job is already running.")
            status.update(state="running", step="starting", done=0, total=0, error=None)
        job = uuid.uuid4().hex
        threading.Thread(target=worker, args=(folder,), daemon=True).start()
        return {"job": job}

    @router.get("/index/status")
    def index_status() -> dict[str, Any]:
        with lock:
            snapshot = dict(status)
        snapshot["assets"] = indexing.count_assets(paths["db_path"])
        return snapshot

    return router

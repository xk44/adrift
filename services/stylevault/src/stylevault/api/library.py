"""Library routes: tag listing and export-by-tag."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from stylevault import db
from stylevault.export import export_assets_by_tag


class ExportByTagRequest(BaseModel):
    tag: str
    mode: str = "symlink"  # symlink | copy
    limit: int | None = None


def _safe_dir_name(tag: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in tag)[:120]


def build_library_router(db_path: Path, exports_root: Path) -> APIRouter:
    router = APIRouter(prefix="/library", tags=["library"])

    @router.get("/tags")
    async def list_tags(
        prefix: str = Query(default="", max_length=64),
    ) -> list[dict[str, Any]]:
        like = f"{prefix}%" if prefix else "%"
        with db.connect(db_path) as connection:
            rows = connection.execute(
                """
                SELECT t.tag, COUNT(*) AS n
                FROM tags t JOIN assets a ON a.id = t.asset_id
                WHERE t.tag LIKE ? AND a.is_missing = 0
                GROUP BY t.tag ORDER BY n DESC LIMIT 500
                """,
                (like,),
            ).fetchall()
        return [{"tag": str(r["tag"]), "count": int(r["n"])} for r in rows]

    @router.post("/export-by-tag")
    async def export_by_tag(payload: ExportByTagRequest) -> dict[str, Any]:
        if payload.mode not in ("symlink", "copy"):
            raise HTTPException(status_code=400, detail="mode must be symlink|copy")
        if not payload.tag.strip():
            raise HTTPException(status_code=400, detail="tag required")
        target = exports_root / "by-tag" / _safe_dir_name(payload.tag)
        count = export_assets_by_tag(
            db_path=db_path,
            tag=payload.tag.strip(),
            target_dir=target,
            mode=payload.mode,
            limit=payload.limit,
        )
        if count == 0:
            raise HTTPException(
                status_code=404, detail=f"No assets carry tag '{payload.tag}'."
            )
        return {"ok": True, "exported": count, "images_dir": str(target)}

    return router

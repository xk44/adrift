from __future__ import annotations

import hashlib as _hashlib
import hmac
import json
import os
import sqlite3
import time as _time
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, field_validator

from stylevault import db
from stylevault.api.caption import build_caption_router
from stylevault.api.clustering import build_cluster_router
from stylevault.api.index_job import build_index_router
from stylevault.api.library import build_library_router
from stylevault.api.training import build_training_router
from stylevault.config import default_config_path, load_config, resolve_config_paths
from stylevault.trainers import check_model_family

LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _host_name(value: str) -> str:
    """Lower-case host from a Host header, without port or IPv6 brackets."""
    value = value.strip().lower()
    if value.startswith("["):
        return value[1:].split("]", 1)[0]
    return value.split(":", 1)[0]


def _allowed_hosts() -> set[str]:
    extra = os.environ.get("STYLEVAULT_ALLOWED_HOSTS", "")
    return LOOPBACK_HOSTS | {_host_name(h) for h in extra.split(",") if h.strip()}


class LocalOnlyMiddleware:
    """Refuse a request whose Host or Origin is not this machine.

    The service has no login, so this is what stops a web page reaching it
    through DNS rebinding or a cross-site POST.
    """

    def __init__(self, app, hosts: set[str], origins: set[str]) -> None:  # noqa: ANN001
        self.app = app
        self.hosts = hosts
        self.origins = origins

    def _allowed(self, headers: dict[bytes, bytes]) -> bool:
        host = _host_name(headers.get(b"host", b"").decode("latin-1"))
        if host not in self.hosts:
            return False
        origin = headers.get(b"origin")
        if origin is None:
            return True
        text = origin.decode("latin-1").strip()
        if text in self.origins:
            return True
        try:
            return (urlsplit(text).hostname or "").lower() in self.hosts
        except ValueError:
            return False

    async def __call__(self, scope, receive, send) -> None:  # noqa: ANN001
        if scope["type"] == "http" and not self._allowed(dict(scope["headers"])):
            refused = JSONResponse(
                {"detail": "Host or Origin not allowed. See STYLEVAULT_ALLOWED_HOSTS."},
                status_code=403,
            )
            await refused(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _place_lora(source: Path, dest: Path, use_symlink: bool) -> None:
    """Symlink/copy ``source`` to ``dest``, replacing a stale entry at ``dest``.

    If ``dest`` already *is* ``source`` (trainer output dir inside the loras dir), leave it:
    unlinking it would delete the only copy of the LoRA and leave a dangling self-link.
    """
    if dest.exists() and dest.resolve() == source.resolve():
        return
    if use_symlink:
        if dest.exists() or dest.is_symlink():
            dest.unlink()
        dest.symlink_to(source.resolve())
    else:
        import shutil

        shutil.copy2(source, dest)


def _file_sha256(path: Path) -> str:
    """Compute SHA256 of a file using chunked reads (safe for large files)."""
    h = _hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _resolve_db_path(config_path: Path) -> Path:
    settings = load_config(config_path)
    paths = resolve_config_paths(settings, config_path)
    return paths["db_path"]


# Request models MUST live at module scope. Pydantic v2 cannot resolve
# function-local models as ForwardRefs during OpenAPI generation, so
# app.openapi() (and /docs) raise PydanticUserError "class-not-fully-defined"
# if these are nested inside create_app().
class ClusterMoveRequest(BaseModel):
    asset_ids: list[int]
    target_cluster_id: int | None = None
    target_cluster_name: str | None = None
    remove_from_cluster_id: int | None = None


class LoraDeployRequest(BaseModel):
    target_subdir: str | None = None


class LoraTrainRequest(BaseModel):
    style_node_id: int | None = None
    cluster_id: int | None = None
    model_family: str = "z-image-turbo"
    base_model: str | None = None
    trainer: str | None = None
    config_overrides: dict[str, object] | None = None

    _family = field_validator("model_family")(check_model_family)


class LoraTrainPreviewRequest(BaseModel):
    style_node_id: int | None = None
    cluster_id: int | None = None
    model_family: str = "z-image-turbo"
    base_model: str | None = None

    _family = field_validator("model_family")(check_model_family)


class MultiBaseTrainRequest(BaseModel):
    style_node_id: int | None = None
    cluster_id: int | None = None
    model_families: list[str] = ["z-image-turbo", "z-image-base"]
    base_models: dict[str, str] | None = None  # family -> base_model path
    config_overrides: dict[str, object] | None = None

    @field_validator("model_families")
    @classmethod
    def _families(cls, value: list[str]) -> list[str]:
        return [check_model_family(family) for family in value]


class LoraCompareRequest(BaseModel):
    lora_a_id: int
    lora_b_id: int


class AssetRateRequest(BaseModel):
    rating: int


class StyleFromClusterRequest(BaseModel):
    cluster_run_id: int | None = None
    cluster_label: str | None = None
    cluster_id: int | None = None
    style_name: str | None = None


def create_app(config_path: Path | None = None) -> FastAPI:
    config_path = config_path or default_config_path()
    settings = load_config(config_path)
    paths = resolve_config_paths(settings, config_path)
    db_path = paths["db_path"]
    paths["thumbs_dir"].mkdir(parents=True, exist_ok=True)
    db.init_db(db_path)

    api_settings = settings.get("api", {})
    api_key = str(api_settings.get("api_key", "")).strip()

    def require_api_key(x_api_key: str | None = Header(None)) -> None:
        if not api_key:
            return
        if not hmac.compare_digest(x_api_key or "", api_key):
            raise HTTPException(status_code=401, detail="Invalid API key.")

    dependencies = [Depends(require_api_key)] if api_key else None
    app = FastAPI(title="StyleVault API", dependencies=dependencies)

    if api_settings.get("cors_enabled"):
        origins = api_settings.get("cors_origins", ["http://localhost", "http://localhost:8000"])
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    cors_origins = api_settings.get("cors_origins", []) if api_settings.get("cors_enabled") else []
    app.add_middleware(LocalOnlyMiddleware, hosts=_allowed_hosts(), origins=set(cors_origins))

    app.include_router(
        build_training_router(settings=settings, config_path=config_path, db_path=db_path, paths=paths)
    )
    app.include_router(build_cluster_router())
    app.include_router(build_caption_router(settings))
    app.include_router(
        build_library_router(
            db_path=db_path,
            exports_root=paths.get("exports_dir", paths["data_dir"]),
        )
    )
    app.include_router(
        build_index_router(settings=settings, config_path=config_path, paths=paths)
    )

    def _cosine_similarity(a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(x * x for x in b) ** 0.5
        if norm_a == 0.0 or norm_b == 0.0:
            return 0.0
        return dot / (norm_a * norm_b)

    def _compute_centroid(
        conn: object,
        cluster_id: int,
        model_name: str,
        model_version: str,
    ) -> list[float] | None:
        from stylevault.embeddings import deserialize_embedding

        asset_ids = db.fetch_cluster_member_asset_ids(conn, cluster_id, limit=5000)
        if not asset_ids:
            return None
        rows = db.fetch_embeddings_for_assets(conn, model_name, model_version, asset_ids)
        if not rows:
            return None
        vecs = [deserialize_embedding(row["embedding"]) for row in rows]
        dim = len(vecs[0])
        centroid = [0.0] * dim
        for vec in vecs:
            for i, v in enumerate(vec):
                centroid[i] += v
        n = len(vecs)
        return [c / n for c in centroid]

    @app.get("/health")
    def health() -> dict[str, object]:
        with db.connect(db_path) as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS n FROM assets WHERE is_missing = 0"
            ).fetchone()
        return {
            "status": "ok",
            "assets": int(row["n"]),
            "embedder": str(settings.get("embeddings", {}).get("primary_model", "siglip2")),
        }

    @app.get("/umap/runs")
    def list_umap_runs() -> list[dict[str, object]]:
        with db.connect(db_path) as connection:
            runs = db.fetch_umap_runs(connection)
        return [
            {
                "id": int(run["id"]),
                "models": json.loads(run["models_json"]),
                "weights": json.loads(run["weights_json"]),
                "n_neighbors": int(run["n_neighbors"]),
                "min_dist": float(run["min_dist"]),
                "metric": str(run["metric"]),
                "created_at": str(run["created_at"]),
            }
            for run in runs
        ]

    @app.get("/umap/runs/{run_id}/points")
    def list_umap_points(
        run_id: int,
        limit: int | None = Query(5000, ge=1, le=100000),
        offset: int = Query(0, ge=0),
        sample: int | None = Query(None, ge=1, le=100000),
    ) -> dict[str, object]:
        with db.connect(db_path) as connection:
            run = db.fetch_umap_run(connection, run_id)
            if run is None:
                raise HTTPException(status_code=404, detail="UMAP run not found.")
            if sample:
                points = db.fetch_umap_points_sample(connection, run_id, sample)
                limit = sample
                offset = 0
            else:
                points = db.fetch_umap_points(connection, run_id, limit=limit, offset=offset)
            asset_ids = [int(point["asset_id"]) for point in points]
            cluster_map = db.fetch_asset_cluster_map(connection, asset_ids)
        return {
            "run_id": int(run_id),
            "count": len(points),
            "limit": limit,
            "offset": offset,
            "sample": sample,
            "points": [
                {
                    "asset_id": int(point["asset_id"]),
                    "x": float(point["x"]),
                    "y": float(point["y"]),
                    "source_path": str(point["source_path"]),
                    "sha256": str(point["sha256"]),
                    "cluster_id": cluster_map.get(int(point["asset_id"])),
                }
                for point in points
            ],
        }

    @app.get("/assets")
    def list_assets(
        limit: int = Query(60, ge=1, le=500),
        offset: int = Query(0, ge=0),
    ) -> dict[str, object]:
        """Indexed images, newest first. Same shape as /search, with no score."""
        with db.connect(db_path) as connection:
            total_count = int(connection.execute("SELECT COUNT(*) FROM assets").fetchone()[0])
            rows = connection.execute(
                """
                SELECT id, source_path, sha256, media_type, width, height, created_at
                FROM assets
                ORDER BY id DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
        return {
            "count": len(rows),
            "total_count": total_count,
            "limit": limit,
            "offset": offset,
            "results": [
                {
                    "asset_id": int(row["id"]),
                    "score": None,
                    "source_path": str(row["source_path"]),
                    "sha256": str(row["sha256"]),
                    "media_type": str(row["media_type"]),
                    "width": int(row["width"]) if row["width"] is not None else None,
                    "height": int(row["height"]) if row["height"] is not None else None,
                    "created_at": str(row["created_at"]),
                }
                for row in rows
            ],
        }

    @app.get("/assets/{asset_id}/thumb")
    def get_thumbnail(asset_id: int) -> Response:
        thumbs_dir = paths["thumbs_dir"]
        with db.connect(db_path) as connection:
            asset = db.fetch_asset_by_id(connection, asset_id)
        if asset is None:
            raise HTTPException(status_code=404, detail="Asset not found.")
        thumb_path = thumbs_dir / f"{asset['sha256']}.webp"
        if not thumb_path.exists():
            raise HTTPException(status_code=404, detail="Thumbnail not found.")
        return Response(content=thumb_path.read_bytes(), media_type="image/webp")

    @app.get("/assets/{asset_id}/file")
    def get_asset_file(asset_id: int) -> Response:
        with db.connect(db_path) as connection:
            asset = db.fetch_asset_by_id(connection, asset_id)
        if asset is None:
            raise HTTPException(status_code=404, detail="Asset not found.")
        source_path = Path(str(asset["source_path"]))
        if not source_path.exists():
            raise HTTPException(status_code=404, detail="Asset file not found.")
        return FileResponse(source_path)

    @app.get("/clusters/tree")
    def list_cluster_tree() -> list[dict[str, object]]:
        with db.connect(db_path) as connection:
            clusters = db.fetch_clusters(connection)
            member_counts = db.fetch_cluster_member_counts(connection)

        nodes: dict[int, dict[str, object]] = {}
        for cluster in clusters:
            cluster_id = int(cluster["id"])
            nodes[cluster_id] = {
                "id": cluster_id,
                "name": str(cluster["name"]),
                "parent_id": int(cluster["parent_id"]) if cluster["parent_id"] else None,
                "member_count": member_counts.get(cluster_id, 0),
                "children": [],
            }

        roots: list[dict[str, object]] = []
        for node in nodes.values():
            parent_id = node["parent_id"]
            if parent_id is None or parent_id not in nodes:
                roots.append(node)
            else:
                nodes[parent_id]["children"].append(node)

        return roots

    @app.get("/clusters/{cluster_id}/members")
    def list_cluster_members(
        cluster_id: int,
        limit: int = Query(200, ge=1, le=5000),
        offset: int = Query(0, ge=0),
        score_model: str | None = Query(
            None, description="Score model key in the form model@version."
        ),
        score_min: float | None = Query(None, ge=-1e9),
        score_max: float | None = Query(None, ge=-1e9),
        sort: str = Query("score_desc", pattern="^(score_desc|score_asc|path)$"),
        text_filter: str | None = Query(
            None,
            description="Text filter: any, none, ocr, vision, caption, signature, unknown.",
            pattern="^(any|none|ocr|vision|caption|signature|unknown)$",
        ),
        small_filter: str | None = Query(
            None,
            description="Small image filter: small, not_small, unknown.",
            pattern="^(small|not_small|unknown)$",
        ),
        include_ratings: bool = Query(False),
    ) -> dict[str, object]:
        with db.connect(db_path) as connection:
            cluster = db.fetch_cluster_by_id(connection, cluster_id)
            if cluster is None:
                raise HTTPException(status_code=404, detail="Cluster not found.")
            if score_model:
                if "@" not in score_model:
                    raise HTTPException(
                        status_code=400, detail="Score model must be in the form model@version."
                    )
                model_name, model_version = score_model.split("@", 1)
                members = db.fetch_cluster_members_with_score(
                    connection,
                    cluster_id,
                    model_name,
                    model_version,
                    limit,
                    offset,
                    score_min=score_min,
                    score_max=score_max,
                    sort=sort,
                    text_filter=text_filter,
                    small_filter=small_filter,
                )
                total = db.fetch_cluster_member_total_with_score(
                    connection,
                    cluster_id,
                    model_name,
                    model_version,
                    score_min=score_min,
                    score_max=score_max,
                    text_filter=text_filter,
                    small_filter=small_filter,
                )
            else:
                members = db.fetch_cluster_members(
                    connection,
                    cluster_id,
                    limit,
                    offset,
                    text_filter=text_filter,
                    small_filter=small_filter,
                )
                total = db.fetch_cluster_member_total(
                    connection,
                    cluster_id,
                    text_filter=text_filter,
                    small_filter=small_filter,
                )
            ratings: dict[int, int] = {}
            if include_ratings:
                asset_ids = [int(m["id"]) for m in members]
                ratings = db.fetch_user_ratings_batch(connection, asset_ids)
        return {
            "cluster_id": cluster_id,
            "cluster_name": str(cluster["name"]),
            "count": total,
            "limit": limit,
            "offset": offset,
            "members": [
                {
                    "asset_id": int(member["id"]),
                    "source_path": str(member["source_path"]),
                    "sha256": str(member["sha256"]),
                    "text_detected_ocr": member["text_detected_ocr"],
                    "text_detected_vision": member["text_detected_vision"],
                    "text_detected_caption": member["text_detected_caption"],
                    "text_detected_signature": member["text_detected_signature"],
                    "is_small": member["is_small"],
                    "score": (
                        float(member["score"])
                        if "score" in member.keys() and member["score"] is not None
                        else None
                    ),
                    "user_rating": ratings.get(int(member["id"])) if include_ratings else None,
                }
                for member in members
            ],
        }

    @app.post("/clusters/members")
    def add_cluster_members(payload: ClusterMoveRequest) -> dict[str, object]:
        if not payload.asset_ids:
            raise HTTPException(status_code=400, detail="asset_ids must not be empty.")
        if payload.target_cluster_id is None and payload.target_cluster_name is None:
            raise HTTPException(
                status_code=400,
                detail="Provide target_cluster_id or target_cluster_name.",
            )
        with db.connect(db_path) as connection:
            if payload.target_cluster_id is not None:
                target_id = payload.target_cluster_id
            else:
                target_id = db.ensure_cluster(connection, payload.target_cluster_name or "Text")
            added = db.add_assets_to_cluster(connection, target_id, payload.asset_ids)
            removed = 0
            if payload.remove_from_cluster_id is not None:
                removed = db.remove_assets_from_cluster(
                    connection, payload.remove_from_cluster_id, payload.asset_ids
                )
            connection.commit()
        return {
            "target_cluster_id": target_id,
            "added": added,
            "removed": removed,
        }

    @app.get("/scores/facets")
    def list_score_facets(buckets: int = Query(5, ge=1, le=20)) -> dict[str, dict[str, object]]:
        with db.connect(db_path) as connection:
            return db.fetch_score_facets(connection, buckets=buckets)

    @app.get("/facets")
    def list_facets(
        score_buckets: int = Query(5, ge=1, le=20),
    ) -> dict[str, object]:
        with db.connect(db_path) as connection:
            media_facets = db.fetch_media_type_facets(connection)
            aspect_facets = db.fetch_aspect_facets(connection)
            score_facets = db.fetch_score_facets(connection, buckets=score_buckets)
            text_facets = db.fetch_text_facets(connection)
            small_facets = db.fetch_small_facets(connection)
        return {
            "media_type": media_facets,
            "aspect": aspect_facets,
            "scores": score_facets,
            "text": text_facets,
            "small": small_facets,
        }



    @app.get("/lora/runs")
    def list_lora_runs(limit: int = Query(50, ge=1, le=500)) -> list[dict[str, object]]:
        with db.connect(db_path) as connection:
            rows = db.fetch_lora_training_runs(connection, limit=limit)
        return [
            {
                "id": int(row["id"]),
                "trainer_name": str(row["trainer_name"]),
                "model_family": str(row["model_family"]),
                "base_model": str(row["base_model"]) if row["base_model"] else None,
                "status": str(row["status"]),
                "started_at": str(row["started_at"]),
                "ended_at": str(row["ended_at"]) if row["ended_at"] else None,
            }
            for row in rows
        ]

    @app.get("/styles")
    def list_styles(limit: int = Query(200, ge=1, le=1000)) -> list[dict[str, object]]:
        with db.connect(db_path) as connection:
            nodes = db.fetch_style_nodes(connection, limit=limit)
            payload: list[dict[str, object]] = []
            for node in nodes:
                node_id = int(node["id"])
                variants = db.fetch_style_variants_for_node(connection, node_id)
                payload.append(
                    {
                        "id": node_id,
                        "style_name": str(node["style_name"]),
                        "source_cluster_id": (
                            int(node["source_cluster_id"]) if node["source_cluster_id"] is not None else None
                        ),
                        "variants": [
                            {
                                "id": int(variant["id"]),
                                "run_id": int(variant["run_id"]),
                                "model_family": str(variant["model_family"]),
                                "base_model": (
                                    str(variant["base_model"]) if variant["base_model"] is not None else None
                                ),
                                "variant_name": str(variant["variant_name"]),
                            }
                            for variant in variants
                        ],
                    }
                )
        return payload

    @app.get("/styles/{style_id}/representatives")
    def get_style_representatives(
        style_id: int,
        limit: int = Query(10, ge=1, le=50),
        score_model: str = Query("aesthetic-simple@v1"),
        include_ratings: bool = Query(False),
    ) -> dict[str, object]:
        with db.connect(db_path) as connection:
            node = db.fetch_style_node_by_id(connection, style_id)
            if node is None:
                raise HTTPException(status_code=404, detail="Style node not found.")
            cluster_id = node["source_cluster_id"]
            if cluster_id is None:
                return {"style_id": style_id, "representatives": []}
            if "@" not in score_model:
                raise HTTPException(
                    status_code=400,
                    detail="score_model must be in the form model@version.",
                )
            model_name, model_version = score_model.split("@", 1)
            top_assets = db.fetch_top_scored_assets_in_cluster(
                connection, cluster_id, model_name, model_version, limit=limit
            )
            ratings: dict[int, int] = {}
            if include_ratings:
                asset_ids = [int(a["id"]) for a in top_assets]
                ratings = db.fetch_user_ratings_batch(connection, asset_ids)
        if include_ratings and ratings:
            rated = [a for a in top_assets if int(a["id"]) in ratings]
            unrated = [a for a in top_assets if int(a["id"]) not in ratings]
            rated.sort(key=lambda a: ratings[int(a["id"])], reverse=True)
            unrated.sort(
                key=lambda a: float(a["score"]) if a["score"] is not None else float("-inf"),
                reverse=True,
            )
            top_assets = rated + unrated
        return {
            "style_id": style_id,
            "cluster_id": cluster_id,
            "representatives": [
                {
                    "asset_id": int(asset["id"]),
                    "source_path": str(asset["source_path"]),
                    "sha256": str(asset["sha256"]),
                    "thumb_url": f"/assets/{int(asset['id'])}/thumb",
                    "score": float(asset["score"]) if asset["score"] is not None else None,
                    "user_rating": ratings.get(int(asset["id"])),
                }
                for asset in top_assets
            ],
        }

    @app.get("/loras")
    def list_loras(limit: int = Query(200, ge=1, le=1000)) -> list[dict[str, object]]:
        with db.connect(db_path) as connection:
            artifacts = db.fetch_lora_artifacts(connection, limit=limit)
        results = []
        for artifact in artifacts:
            meta = json.loads(artifact["metadata_json"]) if artifact["metadata_json"] else {}
            results.append({
                "id": int(artifact["id"]),
                "run_id": int(artifact["run_id"]),
                "trainer": str(artifact["trainer_name"]),
                "model_family": str(artifact["model_family"]),
                "base_model": (
                    str(artifact["base_model"]) if artifact["base_model"] else None
                ),
                "method": str(artifact["method"]),
                "file_path": str(artifact["path"]),
                "trigger_words": meta.get("trigger_words", []),
                "status": str(artifact["status"]),
                "created_at": str(artifact["started_at"]),
            })
        return results

    @app.post("/loras/{lora_id}/deploy")
    def deploy_lora(lora_id: int, payload: LoraDeployRequest | None = None) -> dict[str, object]:
        comfyui_cfg = settings.get("comfyui", {})
        comfyui_path_str = comfyui_cfg.get("path", "")
        if not comfyui_path_str:
            raise HTTPException(
                status_code=400,
                detail="comfyui.path not configured in config.toml.",
            )
        comfyui_path = Path(comfyui_path_str).expanduser()
        if not comfyui_path.is_dir():
            raise HTTPException(
                status_code=400,
                detail=f"ComfyUI path not found: {comfyui_path}",
            )
        subdir = (
            (payload.target_subdir if payload and payload.target_subdir else None)
            or comfyui_cfg.get("lora_output_subdir", "stylevault")
        )
        loras_root = Path(os.path.normpath(comfyui_path / "models" / "loras"))
        lora_dest_dir = Path(os.path.normpath(loras_root / str(subdir)))
        # target_subdir comes from the request body and this endpoint unlinks/overwrites at
        # the destination, so it must stay inside ComfyUI's loras dir (nested subdirs OK).
        # Lexical check (not resolve()) so symlinked loras subdirs on other drives still work.
        if not lora_dest_dir.is_relative_to(loras_root):
            raise HTTPException(
                status_code=400,
                detail="target_subdir must stay inside ComfyUI models/loras.",
            )
        lora_dest_dir.mkdir(parents=True, exist_ok=True)

        with db.connect(db_path) as connection:
            artifact = db.fetch_lora_artifact_by_id(connection, lora_id)
        if artifact is None:
            raise HTTPException(status_code=404, detail="LoRA artifact not found.")

        source = Path(str(artifact["path"]))
        if not source.exists():
            raise HTTPException(
                status_code=404,
                detail=f"LoRA file not found: {source}",
            )
        dest = lora_dest_dir / source.name
        use_symlink = bool(comfyui_cfg.get("auto_symlink", True))
        _place_lora(source, dest, use_symlink)

        meta = json.loads(artifact["metadata_json"]) if artifact["metadata_json"] else {}
        meta_dest = dest.with_suffix(".metadata.json")
        file_stat = source.stat()
        sha256_hash = _file_sha256(source)
        meta_payload = {
            # Required LoRA Manager schema fields
            "file_name": source.stem,
            "model_name": meta.get("display_name", source.stem),
            "file_path": str(dest.resolve()),
            "size": file_stat.st_size,
            "modified": _time.time(),
            "sha256": sha256_hash,
            "base_model": (
                str(artifact["base_model"]) if artifact["base_model"] else "Unknown"
            ),
            # Optional LoRA Manager fields
            "from_civitai": False,
            "tags": meta.get("tags", ["stylevault"]),
            "notes": f"Trained by StyleVault (artifact #{int(artifact['id'])})",
            "favorite": False,
            "hash_status": "completed",
            "usage_tips": json.dumps({
                "strength_min": 0.5,
                "strength_max": 1.0,
                "strength": 0.8,
            }),
            # SV-specific fields (LoRA Manager allows additionalProperties)
            "civitai": {
                "trainedWords": meta.get("trigger_words", []),
            },
            "stylevault_artifact_id": int(artifact["id"]),
            "stylevault_model_family": str(artifact["model_family"]),
            "stylevault_trainer": str(artifact["trainer_name"]),
        }
        meta_dest.write_text(json.dumps(meta_payload, indent=2))

        return {
            "status": "deployed",
            "lora_id": lora_id,
            "deployed_path": str(dest),
            "symlinked": use_symlink,
        }

    @app.get("/loras/{lora_id}/metadata")
    def get_lora_metadata(lora_id: int) -> dict[str, object]:
        """Return the LoRA Manager-compatible .metadata.json sidecar for a deployed LoRA."""
        comfyui_cfg = settings.get("comfyui", {})
        comfyui_path_str = comfyui_cfg.get("path", "")
        with db.connect(db_path) as connection:
            artifact = db.fetch_lora_artifact_by_id(connection, lora_id)
        if artifact is None:
            raise HTTPException(status_code=404, detail="LoRA artifact not found.")

        source = Path(str(artifact["path"]))
        subdir = comfyui_cfg.get("lora_output_subdir", "stylevault")
        if comfyui_path_str:
            comfyui_path = Path(comfyui_path_str).expanduser()
            dest = comfyui_path / "models" / "loras" / subdir / source.name
        else:
            dest = source

        meta_path = dest.with_suffix(".metadata.json")
        if not meta_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"No .metadata.json sidecar found at {meta_path}",
            )
        return json.loads(meta_path.read_text())

    @app.post("/ingest/comfyui-output")
    def ingest_comfyui_output() -> dict[str, object]:
        comfyui_cfg = settings.get("comfyui", {})
        comfyui_path_str = comfyui_cfg.get("path", "")
        if not comfyui_path_str:
            raise HTTPException(
                status_code=400,
                detail="comfyui.path not configured in config.toml.",
            )
        comfyui_path = Path(comfyui_path_str).expanduser()
        output_dir = comfyui_path / "output"
        extra_dirs = comfyui_cfg.get("output_scan_dirs", [])
        scan_dirs = [output_dir] + [Path(d).expanduser() for d in extra_dirs]
        existing_dirs = [d for d in scan_dirs if d.is_dir()]
        if not existing_dirs:
            raise HTTPException(
                status_code=400,
                detail=f"No valid output directories found. Checked: {scan_dirs}",
            )

        from stylevault.scan import scan_directory
        scan_settings = settings.get("scan", {})
        total_new = 0
        total_dupes = 0
        for scan_dir in existing_dirs:
            stats = scan_directory(
                scan_dir,
                db_path,
                thumbs_dir=paths["thumbs_dir"],
                exclude_globs=scan_settings.get("exclude_globs", []),
                workers=scan_settings.get("workers", 4),
            )
            total_new += stats.get("inserted", 0)
            total_dupes += stats.get("deduped", 0)
        return {
            "status": "complete",
            "dirs_scanned": [str(d) for d in existing_dirs],
            "new_assets": total_new,
            "duplicates": total_dupes,
        }

    @app.post("/styles/create-from-cluster")
    def create_style_from_cluster(
        payload: StyleFromClusterRequest,
    ) -> dict[str, object]:
        if payload.cluster_id is None and (
            payload.cluster_run_id is None or payload.cluster_label is None
        ):
            raise HTTPException(
                status_code=400,
                detail="Provide cluster_id or both cluster_run_id and cluster_label.",
            )
        with db.connect(db_path) as connection:
            if payload.cluster_id is not None:
                cluster = db.fetch_cluster_by_id(connection, payload.cluster_id)
                if cluster is None:
                    raise HTTPException(status_code=404, detail="Cluster not found.")
                cluster_id = payload.cluster_id
                name = payload.style_name or str(cluster["name"])
            else:
                cluster_id = None
                name = (
                    payload.style_name
                    or f"run{payload.cluster_run_id}_{payload.cluster_label}"
                )

            node_id = db.upsert_style_node(
                connection,
                style_name=name,
                source_cluster_id=cluster_id,
                metadata={
                    "cluster_run_id": payload.cluster_run_id,
                    "cluster_label": payload.cluster_label,
                },
            )

            connection.commit()
        return {
            "style_node_id": node_id,
            "style_code": None,
            "style_name": name,
            "cluster_id": cluster_id,
        }

    @app.get("/search")
    def search(
        query: str = Query(..., min_length=1),
        limit: int = Query(20, ge=1, le=500),
        offset: int = Query(0, ge=0),
    ) -> dict[str, object]:
        with db.connect(db_path) as connection:
            try:
                results = db.search_assets(connection, query, limit=limit, offset=offset)
                total_count = db.count_search_assets(connection, query)
            except sqlite3.OperationalError as exc:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid search syntax: {exc}",
                ) from exc
            assets = db.fetch_assets_by_ids(connection, [asset_id for asset_id, _ in results])
        asset_map = {int(asset["id"]): asset for asset in assets}
        return {
            "query": query,
            "count": len(results),
            "total_count": total_count,
            "limit": limit,
            "offset": offset,
            "results": [
                {
                    "asset_id": asset_id,
                    "score": score,
                    "source_path": str(asset_map[asset_id]["source_path"]),
                    "sha256": str(asset_map[asset_id]["sha256"]),
                    "media_type": str(asset_map[asset_id]["media_type"]),
                    "width": (
                        int(asset_map[asset_id]["width"])
                        if asset_map[asset_id]["width"] is not None
                        else None
                    ),
                    "height": (
                        int(asset_map[asset_id]["height"])
                        if asset_map[asset_id]["height"] is not None
                        else None
                    ),
                    "created_at": str(asset_map[asset_id]["created_at"]),
                }
                for asset_id, score in results
                if asset_id in asset_map
            ],
        }

    def _auto_deploy_lora_artifacts(
        artifact_paths: list[Path], model_family: str
    ) -> None:
        comfyui_cfg = settings.get("comfyui", {})
        comfyui_path_str = comfyui_cfg.get("path", "")
        if not comfyui_path_str:
            return
        comfyui_path = Path(comfyui_path_str).expanduser()
        if not comfyui_path.is_dir():
            return
        subdir = comfyui_cfg.get("lora_output_subdir", "stylevault")
        lora_dest_dir = comfyui_path / "models" / "loras" / subdir
        lora_dest_dir.mkdir(parents=True, exist_ok=True)
        use_symlink = comfyui_cfg.get("auto_symlink", True)
        for src in artifact_paths:
            if src.suffix not in (".safetensors", ".pt", ".ckpt"):
                continue
            dest = lora_dest_dir / src.name
            _place_lora(src, dest, bool(use_symlink))
            meta_dest = dest.with_suffix(".metadata.json")
            file_stat = src.stat()
            sha256_hash = _file_sha256(src)
            auto_meta_payload = {
                # Required LoRA Manager schema fields
                "file_name": src.stem,
                "model_name": src.stem,
                "file_path": str(dest.resolve()),
                "size": file_stat.st_size,
                "modified": _time.time(),
                "sha256": sha256_hash,
                "base_model": "Unknown",
                # Optional LoRA Manager fields
                "from_civitai": False,
                "tags": ["stylevault"],
                "notes": "Auto-deployed by StyleVault after training",
                "favorite": False,
                "hash_status": "completed",
                "usage_tips": json.dumps({
                    "strength_min": 0.5,
                    "strength_max": 1.0,
                    "strength": 0.8,
                }),
                # SV-specific fields
                "civitai": {"trainedWords": []},
                "stylevault_model_family": model_family,
                "stylevault_trainer": "auto-deploy",
            }
            meta_dest.write_text(json.dumps(auto_meta_payload, indent=2))

    @app.post("/lora/train")
    def start_lora_training(payload: LoraTrainRequest) -> dict[str, object]:
        from stylevault.trainers import (
            build_dataset_manifest,
            build_train_plan,
            collect_artifacts,
            load_trainer_adapters,
            build_trainer_routes,
            run_train,
            find_adapter,
        )
        import threading
        from datetime import datetime, timezone

        resolved_cluster_id = payload.cluster_id
        if resolved_cluster_id is None and payload.style_node_id is not None:
            with db.connect(db_path) as connection:
                node = db.fetch_style_node_by_id(connection, payload.style_node_id)
                if node is None:
                    raise HTTPException(status_code=404, detail="Style node not found.")
                resolved_cluster_id = node["source_cluster_id"]
        if resolved_cluster_id is None:
            raise HTTPException(
                status_code=400,
                detail="Provide cluster_id or style_node_id with a linked cluster.",
            )

        with db.connect(db_path) as connection:
            member_ids = db.fetch_cluster_member_asset_ids(connection, resolved_cluster_id)
            if not member_ids:
                raise HTTPException(status_code=400, detail="Cluster has no members.")
            assets = db.fetch_assets_by_ids(connection, member_ids)
        image_paths = [
            Path(str(a["source_path"])) for a in assets
            if Path(str(a["source_path"])).exists()
        ]
        if not image_paths:
            raise HTTPException(status_code=400, detail="No valid image files in cluster.")

        dataset_root = paths.get("exports_dir", paths["data_dir"]) / "training_datasets"
        manifest_path = build_dataset_manifest(
            output_root=dataset_root,
            image_paths=image_paths,
            model_family=payload.model_family,
            cluster_id=resolved_cluster_id,
        )

        adapters = load_trainer_adapters(settings, config_path)
        routes = build_trainer_routes(settings)
        try:
            plan = build_train_plan(
                settings=settings,
                config_path=config_path,
                adapters=adapters,
                routes=routes,
                model_family=payload.model_family,
                dataset_manifest_path=manifest_path,
                output_dir=dataset_root / "output",
                base_model=payload.base_model,
                dry_run=False,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        with db.connect(db_path) as connection:
            run_id = db.insert_lora_training_run(
                connection,
                method="lora",
                trainer_name=plan.trainer_name,
                model_family=payload.model_family,
                status="running",
                command=plan.command,
                metadata={
                    "style_node_id": payload.style_node_id,
                    "cluster_id": resolved_cluster_id,
                    "config_overrides": payload.config_overrides,
                },
                base_model=payload.base_model,
                dataset_manifest_path=str(manifest_path),
                config_path=(
                    str(plan.rendered_config_path) if plan.rendered_config_path else None
                ),
            )
            connection.commit()

        adapter = find_adapter(adapters, plan.trainer_name)

        def _run_training() -> None:
            try:
                returncode, stdout, stderr = run_train(plan, adapter=adapter, dry_run=False)
                end_time = datetime.now(timezone.utc).isoformat()
                output_dir = dataset_root / "output"
                with db.connect(db_path) as conn:
                    if returncode == 0:
                        artifacts = collect_artifacts(output_dir)
                        for artifact_path in artifacts:
                            if artifact_path.suffix in (".safetensors", ".pt", ".ckpt"):
                                db.insert_lora_artifact(
                                    conn,
                                    run_id=run_id,
                                    artifact_type="lora",
                                    path=str(artifact_path),
                                    metadata={
                                        "model_family": payload.model_family,
                                        "base_model": payload.base_model,
                                    },
                                )
                        db.update_lora_training_run_status(
                            conn, run_id, "completed", ended_at=end_time
                        )
                        conn.commit()
                        _auto_deploy_lora_artifacts(artifacts, payload.model_family)
                    else:
                        db.update_lora_training_run_status(
                            conn, run_id, "failed", ended_at=end_time
                        )
                    conn.commit()
            except Exception:
                end_time = datetime.now(timezone.utc).isoformat()
                with db.connect(db_path) as conn:
                    db.update_lora_training_run_status(
                        conn, run_id, "failed", ended_at=end_time
                    )
                    conn.commit()

        thread = threading.Thread(target=_run_training, daemon=True)
        thread.start()

        return {"training_run_id": run_id, "status": "running"}

    @app.get("/lora/runs/{run_id}")
    def get_lora_run(run_id: int) -> dict[str, object]:
        with db.connect(db_path) as connection:
            run = db.fetch_lora_training_run_by_id(connection, run_id)
            if run is None:
                raise HTTPException(status_code=404, detail="Training run not found.")
            artifacts = db.fetch_lora_artifacts_for_run(connection, run_id)
        meta = json.loads(run["metadata_json"]) if run["metadata_json"] else {}
        cmd = json.loads(run["command_json"]) if run["command_json"] else []
        started = run["started_at"]
        ended = run["ended_at"]
        return {
            "id": int(run["id"]),
            "status": str(run["status"]),
            "trainer_name": str(run["trainer_name"]),
            "model_family": str(run["model_family"]),
            "base_model": str(run["base_model"]) if run["base_model"] else None,
            "method": str(run["method"]),
            "started_at": str(started) if started else None,
            "ended_at": str(ended) if ended else None,
            "dataset_manifest_path": (
                str(run["dataset_manifest_path"]) if run["dataset_manifest_path"] else None
            ),
            "command": cmd,
            "metadata": meta,
            "artifacts": [
                {
                    "id": int(a["id"]),
                    "artifact_type": str(a["artifact_type"]),
                    "path": str(a["path"]),
                    "metadata": json.loads(a["metadata_json"]) if a["metadata_json"] else {},
                    "created_at": str(a["created_at"]),
                }
                for a in artifacts
            ],
        }

    @app.post("/lora/train/preview")
    def preview_lora_training(payload: LoraTrainPreviewRequest) -> dict[str, object]:
        from stylevault.trainers import (
            build_train_plan,
            load_trainer_adapters,
            build_trainer_routes,
        )

        resolved_cluster_id = payload.cluster_id
        if resolved_cluster_id is None and payload.style_node_id is not None:
            with db.connect(db_path) as connection:
                node = db.fetch_style_node_by_id(connection, payload.style_node_id)
                if node is None:
                    raise HTTPException(status_code=404, detail="Style node not found.")
                resolved_cluster_id = node["source_cluster_id"]
        if resolved_cluster_id is None:
            raise HTTPException(
                status_code=400,
                detail="Provide cluster_id or style_node_id with a linked cluster.",
            )

        with db.connect(db_path) as connection:
            member_ids = db.fetch_cluster_member_asset_ids(connection, resolved_cluster_id)
            if not member_ids:
                raise HTTPException(status_code=400, detail="Cluster has no members.")
            assets = db.fetch_assets_by_ids(connection, member_ids)
        image_paths = [
            Path(str(a["source_path"]))
            for a in assets
            if Path(str(a["source_path"])).exists()
        ]

        caption_sample: list[dict[str, object]] = []
        with db.connect(db_path) as connection:
            cursor = connection.cursor()
            for aid in member_ids[:3]:
                cursor.execute(
                    "SELECT text FROM captions WHERE asset_id = ? LIMIT 1",
                    (aid,),
                )
                row = cursor.fetchone()
                if row:
                    caption_sample.append({"asset_id": aid, "caption": str(row["text"])})

        adapters = load_trainer_adapters(settings, config_path)
        routes = build_trainer_routes(settings)
        dataset_root = paths.get("exports_dir", paths["data_dir"]) / "training_datasets"
        try:
            plan = build_train_plan(
                settings=settings,
                config_path=config_path,
                adapters=adapters,
                routes=routes,
                model_family=payload.model_family,
                dataset_manifest_path=Path("/preview/placeholder"),
                output_dir=dataset_root / "output",
                base_model=payload.base_model,
                dry_run=True,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        return {
            "asset_count": len(image_paths),
            "total_cluster_members": len(member_ids),
            "caption_sample": caption_sample,
            "trainer": plan.trainer_name,
            "entrypoint": plan.entrypoint,
            "model_family": payload.model_family,
            "base_model": payload.base_model,
        }

    @app.post("/assets/{asset_id}/rate")
    def rate_asset(asset_id: int, payload: AssetRateRequest) -> dict[str, object]:
        if payload.rating < 1 or payload.rating > 5:
            raise HTTPException(status_code=400, detail="Rating must be between 1 and 5.")
        with db.connect(db_path) as connection:
            asset = db.fetch_asset_by_id(connection, asset_id)
            if asset is None:
                raise HTTPException(status_code=404, detail="Asset not found.")
            rating_id = db.upsert_user_rating(connection, asset_id, payload.rating)
            connection.commit()
        return {
            "asset_id": asset_id,
            "rating": payload.rating,
            "rating_id": rating_id,
        }

    _watcher_thread: dict[str, object] = {}

    @app.post("/watcher/start")
    def start_watcher(
        interval: float = Query(30.0, ge=5.0, le=3600.0),
    ) -> dict[str, object]:
        import threading
        if _watcher_thread.get("running"):
            return {"status": "already_running", "interval": interval}

        _watcher_thread["stop"] = False

        def _watch_loop() -> None:
            from stylevault.watcher import watch_comfyui_output
            _watcher_thread["running"] = True
            try:
                watch_comfyui_output(
                    config_path=config_path, interval=interval, once=False
                )
            except Exception:
                pass
            finally:
                _watcher_thread["running"] = False

        thread = threading.Thread(target=_watch_loop, daemon=True)
        thread.start()
        return {"status": "started", "interval": interval}

    @app.post("/watcher/stop")
    def stop_watcher() -> dict[str, str]:
        _watcher_thread["stop"] = True
        _watcher_thread["running"] = False
        return {"status": "stopped"}

    @app.get("/watcher/status")
    def watcher_status() -> dict[str, object]:
        return {"running": bool(_watcher_thread.get("running", False))}

    # P5/VIDEO — ComfyUI Wan Video captioning
    _caption_thread: dict[str, object] = {}

    @app.post("/caption/comfyui-videos")
    def caption_comfyui_videos(
        max_videos: int = Query(10, ge=1, le=100),
    ) -> dict[str, object]:
        """
        Scan ComfyUI output dir for uncaptioned video files and caption them via OmniTag.
        Heavy operation (loads Qwen model); runs in a background thread.
        Returns immediately with status and queue count.
        """
        import threading

        if _caption_thread.get("running"):
            return {"status": "already_running", "videos_queued": 0}

        comfyui_cfg = settings.get("comfyui", {})
        comfyui_path_str = comfyui_cfg.get("path", "")
        if not comfyui_path_str:
            raise HTTPException(
                status_code=400,
                detail="comfyui.path not configured in config.toml.",
            )
        comfyui_path = Path(comfyui_path_str).expanduser()
        output_dir = comfyui_path / "output"
        if not output_dir.is_dir():
            raise HTTPException(
                status_code=400,
                detail=f"ComfyUI output dir not found: {output_dir}",
            )

        from stylevault.omnitag import VIDEO_EXTENSIONS

        captions_dir = paths.get("data_dir", Path(".")) / "video_captions"
        captions_dir.mkdir(parents=True, exist_ok=True)

        video_files = [
            p for p in sorted(output_dir.iterdir())
            if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS
        ]
        uncaptioned = [
            v for v in video_files
            if not (captions_dir / f"{v.stem}.txt").exists()
        ][:max_videos]

        if not uncaptioned:
            return {"status": "nothing_to_do", "videos_queued": 0}

        _caption_thread["running"] = True
        _caption_thread["videos_queued"] = len(uncaptioned)
        _caption_thread["videos_captioned"] = 0
        _caption_thread["errors"] = []

        def _run_captioning() -> None:
            from stylevault.omnitag import (
                OmniTagSettings,
                get_omnitag_model,
                run_omnitag_mode,
            )

            omnitag_cfg = settings.get("omnitag", {})
            model_id = omnitag_cfg.get("model_id", "Qwen/Qwen3-VL-4B-Instruct")
            try:
                model = get_omnitag_model(model_id)
                ot_settings = OmniTagSettings(
                    output_path=captions_dir,
                    trigger_word=omnitag_cfg.get("trigger_word", "ohwx"),
                    llm_instruction=omnitag_cfg.get(
                        "llm_instruction",
                        "Describe the scene with clinical, objective detail.",
                    ),
                )
                captioned = 0
                errors: list[str] = []
                for video_path in uncaptioned:
                    try:
                        run_omnitag_mode(
                            mode="single-video",
                            input_path=video_path,
                            settings=ot_settings,
                            model=model,
                            caption_video_targets="frames",
                        )
                        captioned += 1
                    except Exception as exc:  # noqa: BLE001
                        errors.append(f"{video_path.name}: {exc}")
                _caption_thread["videos_captioned"] = captioned
                _caption_thread["errors"] = errors
            except Exception as exc:  # noqa: BLE001
                _caption_thread["errors"] = [str(exc)]
            finally:
                _caption_thread["running"] = False

        thread = threading.Thread(target=_run_captioning, daemon=True)
        thread.start()
        return {"status": "started", "videos_queued": len(uncaptioned)}

    @app.get("/caption/status")
    def caption_status() -> dict[str, object]:
        return {
            "running": bool(_caption_thread.get("running", False)),
            "videos_queued": int(_caption_thread.get("videos_queued", 0)),
            "videos_captioned": int(_caption_thread.get("videos_captioned", 0)),
            "errors": list(_caption_thread.get("errors", [])),
        }

    @app.get("/styles/search")
    def search_styles(
        query: str | None = Query(None, min_length=1),
        similar_to: int | None = Query(
            None, description="Style node ID to find similar styles"
        ),
        limit: int = Query(20, ge=1, le=100),
    ) -> dict[str, object]:
        with db.connect(db_path) as connection:
            if similar_to is not None:
                ref_node = db.fetch_style_node_by_id(connection, similar_to)
                if ref_node is None:
                    raise HTTPException(status_code=404, detail="Style node not found.")
                ref_cluster_id = ref_node["source_cluster_id"]
                if ref_cluster_id is None:
                    return {"results": []}
                model_name = settings.get("embeddings", {}).get("primary_model", "siglip2")
                try:
                    model_version = db.fetch_model_version(connection, model_name)
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail=str(exc)) from exc
                ref_centroid = _compute_centroid(
                    connection, ref_cluster_id, model_name, model_version
                )
                if ref_centroid is None:
                    return {"results": []}
                all_nodes = db.fetch_style_nodes(connection, limit=1000)
                scored: list[tuple[float, sqlite3.Row]] = []
                for node in all_nodes:
                    if int(node["id"]) == similar_to:
                        continue
                    c_id = node["source_cluster_id"]
                    if c_id is None:
                        continue
                    centroid = _compute_centroid(
                        connection, int(c_id), model_name, model_version
                    )
                    if centroid is None:
                        continue
                    score = _cosine_similarity(ref_centroid, centroid)
                    scored.append((score, node))
                scored.sort(key=lambda t: t[0], reverse=True)
                top = scored[:limit]
                results = []
                for score, node in top:
                    node_id = int(node["id"])
                    results.append({
                        "style_node_id": node_id,
                        "style_name": str(node["style_name"]),
                        "cluster_id": (
                            int(node["source_cluster_id"])
                            if node["source_cluster_id"] is not None else None
                        ),
                        "codes": [],
                        "score": float(score),
                    })
                return {"results": results}

            if query is not None:
                nodes = db.search_style_nodes(connection, query, limit=limit)
                results = []
                for node in nodes:
                    node_id = int(node["id"])
                    results.append({
                        "style_node_id": node_id,
                        "style_name": str(node["style_name"]),
                        "cluster_id": (
                            int(node["source_cluster_id"])
                            if node["source_cluster_id"] is not None else None
                        ),
                        "codes": [],
                        "score": None,
                    })
                return {"results": results}

            raise HTTPException(
                status_code=400,
                detail="Provide query or similar_to.",
            )

    @app.post("/ingest/assign-clusters")
    def assign_to_nearest_clusters(
        threshold: float = Query(0.7, ge=0.0, le=1.0),
        limit: int = Query(500, ge=1, le=5000),
    ) -> dict[str, object]:
        from stylevault.embeddings import deserialize_embedding

        model_name = settings.get("embeddings", {}).get("primary_model", "siglip2")

        with db.connect(db_path) as connection:
            try:
                model_version = db.fetch_model_version(connection, model_name)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

            unassigned_ids = db.fetch_unassigned_asset_ids(connection, limit=limit)
            total_checked = len(unassigned_ids)
            if not unassigned_ids:
                return {"assigned": 0, "unassigned": 0, "total_checked": 0}

            all_clusters = db.fetch_clusters(connection)
            cluster_centroids: dict[int, list[float] | None] = {}
            for cluster in all_clusters:
                cid = int(cluster["id"])
                cluster_centroids[cid] = _compute_centroid(
                    connection, cid, model_name, model_version
                )

            valid_clusters = [
                (cid, centroid)
                for cid, centroid in cluster_centroids.items()
                if centroid is not None
            ]

            assigned_count = 0
            unassigned_count = 0

            for asset_id in unassigned_ids:
                emb_rows = db.fetch_embeddings_for_assets(
                    connection, model_name, model_version, [asset_id]
                )
                if not emb_rows:
                    unassigned_count += 1
                    continue
                vec = deserialize_embedding(emb_rows[0]["embedding"])
                best_cluster: int | None = None
                best_score = -1.0
                for cid, centroid in valid_clusters:
                    score = _cosine_similarity(vec, centroid)
                    if score > best_score:
                        best_score = score
                        best_cluster = cid
                if best_cluster is not None and best_score >= threshold:
                    db.add_assets_to_cluster(connection, best_cluster, [asset_id])
                    assigned_count += 1
                else:
                    unassigned_count += 1

            connection.commit()

        return {
            "assigned": assigned_count,
            "unassigned": unassigned_count,
            "total_checked": total_checked,
        }

    @app.get("/styles/{style_id}/evolution")
    def get_style_evolution(style_id: int) -> dict[str, object]:
        with db.connect(db_path) as connection:
            node = db.fetch_style_node_by_id(connection, style_id)
            if node is None:
                raise HTTPException(status_code=404, detail="Style node not found.")

            variants = db.fetch_style_variants_with_runs(connection, style_id)
            iterations = []
            for variant in variants:
                run_id = int(variant["run_id"])
                artifacts = db.fetch_lora_artifacts_for_run(connection, run_id)
                iterations.append({
                    "run_id": run_id,
                    "variant_name": str(variant["variant_name"]),
                    "model_family": str(variant["model_family"]),
                    "status": str(variant["status"]),
                    "started_at": (
                        str(variant["started_at"]) if variant["started_at"] else None
                    ),
                    "ended_at": (
                        str(variant["ended_at"]) if variant["ended_at"] else None
                    ),
                    "artifacts": [
                        {
                            "id": int(a["id"]),
                            "type": str(a["artifact_type"]),
                            "path": str(a["path"]),
                        }
                        for a in artifacts
                    ],
                })

        return {
            "style_id": style_id,
            "style_name": str(node["style_name"]),
            "iterations": iterations,
        }

    @app.post("/lora/train/multi")
    def start_multi_base_training(
        payload: MultiBaseTrainRequest,
    ) -> dict[str, object]:
        from stylevault.trainers import (
            build_dataset_manifest,
            build_train_plan,
            collect_artifacts,
            load_trainer_adapters,
            build_trainer_routes,
            run_train,
            find_adapter,
        )
        import threading
        from datetime import datetime, timezone

        resolved_cluster_id = payload.cluster_id
        if resolved_cluster_id is None and payload.style_node_id is not None:
            with db.connect(db_path) as connection:
                node = db.fetch_style_node_by_id(connection, payload.style_node_id)
                if node is None:
                    raise HTTPException(status_code=404, detail="Style node not found.")
                resolved_cluster_id = node["source_cluster_id"]
        if resolved_cluster_id is None:
            raise HTTPException(
                status_code=400,
                detail="Provide cluster_id or style_node_id with a linked cluster.",
            )

        with db.connect(db_path) as connection:
            member_ids = db.fetch_cluster_member_asset_ids(connection, resolved_cluster_id)
            if not member_ids:
                raise HTTPException(status_code=400, detail="Cluster has no members.")
            assets = db.fetch_assets_by_ids(connection, member_ids)
        image_paths = [
            Path(str(a["source_path"])) for a in assets
            if Path(str(a["source_path"])).exists()
        ]
        if not image_paths:
            raise HTTPException(status_code=400, detail="No valid image files in cluster.")

        dataset_root = paths.get("exports_dir", paths["data_dir"]) / "training_datasets"

        # Build one shared dataset manifest (first family used for naming)
        first_family = payload.model_families[0] if payload.model_families else "z-image-turbo"
        manifest_path = build_dataset_manifest(
            output_root=dataset_root,
            image_paths=image_paths,
            model_family=first_family,
            cluster_id=resolved_cluster_id,
        )

        adapters = load_trainer_adapters(settings, config_path)
        routes = build_trainer_routes(settings)
        training_runs: list[dict[str, object]] = []

        for family in payload.model_families:
            base_model = (
                (payload.base_models or {}).get(family) if payload.base_models else None
            )
            try:
                plan = build_train_plan(
                    settings=settings,
                    config_path=config_path,
                    adapters=adapters,
                    routes=routes,
                    model_family=family,
                    dataset_manifest_path=manifest_path,
                    output_dir=dataset_root / "output",
                    base_model=base_model,
                    dry_run=False,
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

            with db.connect(db_path) as connection:
                run_id = db.insert_lora_training_run(
                    connection,
                    method="lora",
                    trainer_name=plan.trainer_name,
                    model_family=family,
                    status="running",
                    command=plan.command,
                    metadata={
                        "style_node_id": payload.style_node_id,
                        "cluster_id": resolved_cluster_id,
                        "config_overrides": payload.config_overrides,
                        "multi_base": True,
                    },
                    base_model=base_model,
                    dataset_manifest_path=str(manifest_path),
                    config_path=(
                        str(plan.rendered_config_path)
                        if plan.rendered_config_path
                        else None
                    ),
                )
                connection.commit()

            adapter = find_adapter(adapters, plan.trainer_name)

            def _make_runner(
                _run_id: int,
                _plan: object,
                _adapter: object,
                _family: str,
                _base_model: str | None,
            ):
                def _run() -> None:
                    try:
                        returncode, _stdout, _stderr = run_train(
                            _plan, adapter=_adapter, dry_run=False
                        )
                        end_time = datetime.now(timezone.utc).isoformat()
                        output_dir = dataset_root / "output"
                        with db.connect(db_path) as conn:
                            if returncode == 0:
                                artifacts = collect_artifacts(output_dir)
                                for ap in artifacts:
                                    if ap.suffix in (".safetensors", ".pt", ".ckpt"):
                                        db.insert_lora_artifact(
                                            conn,
                                            run_id=_run_id,
                                            artifact_type="lora",
                                            path=str(ap),
                                            metadata={
                                                "model_family": _family,
                                                "base_model": _base_model,
                                            },
                                        )
                                db.update_lora_training_run_status(
                                    conn, _run_id, "completed", ended_at=end_time
                                )
                                conn.commit()
                                _auto_deploy_lora_artifacts(artifacts, _family)
                            else:
                                db.update_lora_training_run_status(
                                    conn, _run_id, "failed", ended_at=end_time
                                )
                                conn.commit()
                    except Exception:
                        end_time = datetime.now(timezone.utc).isoformat()
                        with db.connect(db_path) as conn:
                            db.update_lora_training_run_status(
                                conn, _run_id, "failed", ended_at=end_time
                            )
                            conn.commit()

                return _run

            thread = threading.Thread(
                target=_make_runner(run_id, plan, adapter, family, base_model),
                daemon=True,
            )
            thread.start()
            training_runs.append({
                "run_id": run_id,
                "model_family": family,
                "status": "running",
            })

        return {"training_runs": training_runs}

    @app.post("/lora/compare")
    def compare_loras(payload: LoraCompareRequest) -> dict[str, object]:
        def _build_lora_info(
            artifact: object,
            run: object,
            lora_dir: Path,
        ) -> dict[str, object]:
            artifact_path = Path(str(artifact["path"]))
            artifact_meta = (
                json.loads(artifact["metadata_json"]) if artifact["metadata_json"] else {}
            )
            run_meta = json.loads(run["metadata_json"]) if run["metadata_json"] else {}
            deployed = False
            deployed_path: str | None = None
            if str(lora_dir) != ".":
                candidate = lora_dir / artifact_path.name
                if candidate.exists() or candidate.is_symlink():
                    deployed = True
                    deployed_path = str(candidate)
            trigger_words = artifact_meta.get(
                "trigger_words", run_meta.get("trigger_words", [])
            )
            return {
                "id": int(artifact["id"]),
                "path": str(artifact["path"]),
                "model_family": str(artifact["model_family"]),
                "base_model": (
                    str(artifact["base_model"]) if artifact["base_model"] else None
                ),
                "status": str(artifact["status"]),
                "deployed": deployed,
                "deployed_path": deployed_path,
                "trigger_words": trigger_words,
                "training_run": {
                    "id": int(run["id"]),
                    "started_at": (
                        str(run["started_at"]) if run["started_at"] else None
                    ),
                    "status": str(run["status"]),
                },
            }

        comfyui_cfg = settings.get("comfyui", {})
        comfyui_path_str = comfyui_cfg.get("path", "")
        subdir = comfyui_cfg.get("lora_output_subdir", "stylevault")
        if comfyui_path_str:
            lora_dir: Path = (
                Path(comfyui_path_str).expanduser() / "models" / "loras" / subdir
            )
        else:
            lora_dir = Path(".")

        with db.connect(db_path) as connection:
            artifact_a = db.fetch_lora_artifact_by_id(connection, payload.lora_a_id)
            if artifact_a is None:
                raise HTTPException(
                    status_code=404, detail=f"LoRA {payload.lora_a_id} not found."
                )
            artifact_b = db.fetch_lora_artifact_by_id(connection, payload.lora_b_id)
            if artifact_b is None:
                raise HTTPException(
                    status_code=404, detail=f"LoRA {payload.lora_b_id} not found."
                )
            run_a = db.fetch_lora_training_run_by_id(
                connection, int(artifact_a["run_id"])
            )
            run_b = db.fetch_lora_training_run_by_id(
                connection, int(artifact_b["run_id"])
            )

        if run_a is None:
            raise HTTPException(
                status_code=404,
                detail=f"Training run for LoRA {payload.lora_a_id} not found.",
            )
        if run_b is None:
            raise HTTPException(
                status_code=404,
                detail=f"Training run for LoRA {payload.lora_b_id} not found.",
            )

        info_a = _build_lora_info(artifact_a, run_a, lora_dir)
        info_b = _build_lora_info(artifact_b, run_b, lora_dir)

        compatible = info_a["model_family"] == info_b["model_family"]
        if compatible:
            if info_a["base_model"] and info_a["base_model"] == info_b["base_model"]:
                notes = "Same base model, directly comparable"
            else:
                notes = "Same base model family, comparable"
        else:
            notes = (
                f"Different model families ({info_a['model_family']} vs "
                f"{info_b['model_family']}), may not be directly comparable"
            )

        return {
            "lora_a": info_a,
            "lora_b": info_b,
            "compatible": compatible,
            "comparison_notes": notes,
        }

    return app


def create_app_from_env() -> FastAPI:
    return create_app(default_config_path())


def __getattr__(name: str) -> FastAPI:
    # Built on first use so importing this module never creates a data dir.
    if name == "app":
        built = create_app_from_env()
        globals()["app"] = built
        return built
    raise AttributeError(name)

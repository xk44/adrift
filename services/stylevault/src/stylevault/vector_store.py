from __future__ import annotations

from dataclasses import dataclass
import importlib.util
import json
import logging
import math
from pathlib import Path

from stylevault import db
from stylevault.embeddings import EmbeddingModel, deserialize_embedding


@dataclass(frozen=True)
class VectorSearchResult:
    asset_id: int
    score: float


class VectorStore:
    def search(
        self,
        query_embedding: list[float],
        model: EmbeddingModel,
        limit: int = 5,
    ) -> list[VectorSearchResult]:
        raise NotImplementedError

    def sync_embeddings(self, model: EmbeddingModel) -> None:
        raise NotImplementedError


class SqliteVectorStore(VectorStore):
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path

    @staticmethod
    def _cosine_similarity(lhs: list[float], rhs: list[float]) -> float:
        dot = sum(a * b for a, b in zip(lhs, rhs))
        lhs_norm = math.sqrt(sum(a * a for a in lhs))
        rhs_norm = math.sqrt(sum(b * b for b in rhs))
        if lhs_norm == 0.0 or rhs_norm == 0.0:
            return 0.0
        return dot / (lhs_norm * rhs_norm)

    def search(
        self,
        query_embedding: list[float],
        model: EmbeddingModel,
        limit: int = 5,
    ) -> list[VectorSearchResult]:
        results: list[VectorSearchResult] = []
        with db.connect(self._db_path) as connection:
            rows = db.fetch_embeddings_for_model(connection, model.name, model.version)
            for row in rows:
                embedding = deserialize_embedding(row["embedding"])
                score = self._cosine_similarity(query_embedding, embedding)
                results.append(VectorSearchResult(asset_id=row["asset_id"], score=score))
        results.sort(key=lambda item: item.score, reverse=True)
        return results[:limit]

    def sync_embeddings(self, model: EmbeddingModel) -> None:
        return


class FaissVectorStore(VectorStore):
    def __init__(self, db_path: Path, index_dir: Path, config: dict) -> None:
        self._db_path = db_path
        self._index_dir = index_dir
        self._config = config

    def _index_path(self, model: EmbeddingModel) -> Path:
        safe_version = model.version.replace("/", "_")
        return self._index_dir / f"{model.name}_{safe_version}.faiss"

    def _build_index(self, vectors, asset_ids):
        import faiss

        index_type = str(self._config.get("index_type", "hnsw")).lower()
        dim = vectors.shape[1]
        if index_type == "hnsw":
            m = int(self._config.get("m", 32))
            base = faiss.IndexHNSWFlat(dim, m)
            base.hnsw.efConstruction = int(self._config.get("ef_construction", 200))
        else:
            base = faiss.IndexFlatIP(dim)
        index = faiss.IndexIDMap2(base)
        index.add_with_ids(vectors, asset_ids)
        return index

    def sync_embeddings(self, model: EmbeddingModel) -> None:
        import faiss
        import numpy as np

        with db.connect(self._db_path) as connection:
            rows = db.fetch_embeddings_for_model(connection, model.name, model.version)
            if not rows:
                return
            embeddings = [deserialize_embedding(row["embedding"]) for row in rows]
            asset_ids = [row["asset_id"] for row in rows]
            vectors = np.array(embeddings, dtype="float32")
            faiss.normalize_L2(vectors)
            ids = np.array(asset_ids, dtype="int64")
            index = self._build_index(vectors, ids)
            self._index_dir.mkdir(parents=True, exist_ok=True)
            faiss.write_index(index, str(self._index_path(model)))
            db.mark_vector_sync_state(connection, "faiss", model.name, model.version)
            connection.commit()

    def search(
        self,
        query_embedding: list[float],
        model: EmbeddingModel,
        limit: int = 5,
    ) -> list[VectorSearchResult]:
        import faiss
        import numpy as np

        index_path = self._index_path(model)
        if not index_path.exists():
            raise RuntimeError(
                "FAISS index is missing. Run `stylevault vector-sync` for this model."
            )
        index = faiss.read_index(str(index_path))
        if hasattr(index, "hnsw"):
            index.hnsw.efSearch = int(self._config.get("ef_search", 64))

        query = np.array([query_embedding], dtype="float32")
        faiss.normalize_L2(query)
        scores, ids = index.search(query, limit)
        results: list[VectorSearchResult] = []
        for score, asset_id in zip(scores[0], ids[0], strict=False):
            if asset_id == -1:
                continue
            results.append(VectorSearchResult(asset_id=int(asset_id), score=float(score)))
        return results


class QdrantVectorStore(VectorStore):
    def __init__(self, db_path: Path, config: dict, checkpoint_dir: Path | None = None) -> None:
        from qdrant_client import QdrantClient

        self._db_path = db_path
        self._config = config
        self._collection_prefix = config.get("collection_prefix", "stylevault")
        self._checkpoint_dir = checkpoint_dir or (
            Path(config["checkpoint_dir"])
            if config.get("checkpoint_dir")
            else db_path.parent / "indices" / "vector_sync"
        )
        if "url" in config:
            self._client = QdrantClient(url=config["url"], api_key=config.get("api_key"))
        elif "path" in config:
            self._client = QdrantClient(path=Path(config["path"]))
        else:
            self._client = QdrantClient(":memory:")

    def _collection_name(self, model: EmbeddingModel) -> str:
        safe_version = model.version.replace("/", "_")
        return f"{self._collection_prefix}_{model.name}_{safe_version}"

    def _ensure_collection(self, model: EmbeddingModel, vector_size: int) -> str:
        from qdrant_client.http.models import Distance, VectorParams

        collection = self._collection_name(model)
        if not self._client.collection_exists(collection):
            self._client.create_collection(
                collection_name=collection,
                vectors_config=VectorParams(size=vector_size, distance=Distance.COSINE),
            )
        return collection

    def _checkpoint_path(self, model: EmbeddingModel) -> Path:
        safe_version = model.version.replace("/", "_")
        return self._checkpoint_dir / f"qdrant_{model.name}_{safe_version}.json"

    def _load_checkpoint(self, model: EmbeddingModel) -> int:
        if not self._checkpoint_dir.exists():
            return 0
        path = self._checkpoint_path(model)
        if not path.exists():
            return 0
        try:
            payload = json.loads(path.read_text())
        except json.JSONDecodeError:
            return 0
        return int(payload.get("last_asset_id", 0))

    def _write_checkpoint(self, model: EmbeddingModel, last_asset_id: int) -> None:
        self._checkpoint_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "model": model.name,
            "version": model.version,
            "last_asset_id": last_asset_id,
        }
        self._checkpoint_path(model).write_text(json.dumps(payload, indent=2))

    def sync_embeddings(self, model: EmbeddingModel) -> None:
        from qdrant_client.http.models import PointStruct

        resume = bool(self._config.get("resume", True))
        batch_size = int(self._config.get("batch_size", 256))
        start_after = self._load_checkpoint(model) if resume else 0
        has_rows = False

        with db.connect(self._db_path) as connection:
            for rows in db.iter_embeddings_for_model(
                connection,
                model.name,
                model.version,
                batch_size=batch_size,
                start_after=start_after,
            ):
                has_rows = True
                embeddings = [deserialize_embedding(row["embedding"]) for row in rows]
                vector_size = len(embeddings[0])
                collection = self._ensure_collection(model, vector_size)
                points: list[PointStruct] = []
                last_asset_id = 0
                for row, vector in zip(rows, embeddings, strict=False):
                    last_asset_id = int(row["asset_id"])
                    points.append(
                        PointStruct(
                            id=int(row["asset_id"]),
                            vector=vector,
                            payload={"asset_id": int(row["asset_id"])},
                        )
                    )
                if points:
                    self._client.upsert(
                        collection_name=collection,
                        points=points,
                    )
                    if resume and last_asset_id:
                        self._write_checkpoint(model, last_asset_id)
        if not has_rows:
            with db.connect(self._db_path) as connection:
                pending = connection.execute(
                    """
                    SELECT 1
                    FROM embeddings
                    WHERE model_name = ? AND model_version = ? AND asset_id > ?
                    LIMIT 1
                    """,
                    (model.name, model.version, start_after),
                ).fetchone()
                if pending is None and start_after > 0:
                    db.mark_vector_sync_state(connection, "qdrant", model.name, model.version)
                    connection.commit()
                    if resume:
                        checkpoint_path = self._checkpoint_path(model)
                        if checkpoint_path.exists():
                            checkpoint_path.unlink()
            return
        with db.connect(self._db_path) as connection:
            db.mark_vector_sync_state(connection, "qdrant", model.name, model.version)
            connection.commit()
        if resume:
            checkpoint_path = self._checkpoint_path(model)
            if checkpoint_path.exists():
                checkpoint_path.unlink()

    def search(
        self,
        query_embedding: list[float],
        model: EmbeddingModel,
        limit: int = 5,
    ) -> list[VectorSearchResult]:
        with db.connect(self._db_path) as connection:
            synced = db.fetch_vector_sync_state(connection, "qdrant", model.name, model.version)
        if not synced:
            raise RuntimeError(
                "Qdrant collection is not synced. Run `stylevault vector-sync` for this model."
            )
        collection = self._collection_name(model)
        results = self._client.search(
            collection_name=collection,
            query_vector=query_embedding,
            limit=limit,
        )
        return [
            VectorSearchResult(
                asset_id=int(result.payload.get("asset_id", result.id)),
                score=float(result.score),
            )
            for result in results
        ]

class UnavailableVectorStore(VectorStore):
    def __init__(self, backend: str, detail: str) -> None:
        self._backend = backend
        self._detail = detail

    def search(
        self,
        query_embedding: list[float],
        model: EmbeddingModel,
        limit: int = 5,
    ) -> list[VectorSearchResult]:
        raise RuntimeError(f"Vector store '{self._backend}' is unavailable: {self._detail}")

    def sync_embeddings(self, model: EmbeddingModel) -> None:
        raise RuntimeError(f"Vector store '{self._backend}' is unavailable: {self._detail}")


def _module_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def build_vector_store(settings: dict, db_path: Path, index_dir: Path | None = None) -> VectorStore:
    vector_cfg = settings.get("vector_store", {})
    backend = vector_cfg.get("backend", "sqlite").lower()
    if backend == "sqlite":
        return SqliteVectorStore(db_path)
    if backend == "qdrant":
        if _module_available("qdrant_client"):
            return QdrantVectorStore(db_path, vector_cfg.get("qdrant", {}), checkpoint_dir=index_dir)
        detail = "Install qdrant-client and configure the endpoint or local path."
    elif backend == "faiss":
        if _module_available("faiss"):
            faiss_cfg = vector_cfg.get("faiss", {})
            index_dir = index_dir or Path("indices")
            return FaissVectorStore(db_path, index_dir, faiss_cfg)
        detail = "Install faiss to enable the FAISS vector store."
    else:
        detail = "Unknown backend configured."
    logging.getLogger(__name__).warning(
        "Vector store backend '%s' is not available (%s); falling back to sqlite.",
        backend,
        detail,
    )
    return SqliteVectorStore(db_path)


def sync_vector_store(
    settings: dict,
    db_path: Path,
    index_dir: Path | None,
    models: list[dict[str, str | None]],
) -> list[dict[str, object]]:
    store = build_vector_store(settings, db_path, index_dir=index_dir)
    results: list[dict[str, object]] = []
    with db.connect(db_path) as connection:
        db.migrate_connection(connection)
        for model_spec in models:
            model_name = str(model_spec["name"])
            model_version = model_spec.get("version")
            if not model_version:
                model_version = db.fetch_model_version(connection, model_name)
            model = EmbeddingModel(name=model_name, version=str(model_version), description="")
            try:
                store.sync_embeddings(model)
            except RuntimeError as error:
                results.append(
                    {
                        "model": model_name,
                        "version": model_version,
                        "status": "error",
                        "detail": str(error),
                    }
                )
                continue
            results.append(
                {
                    "model": model_name,
                    "version": model_version,
                    "status": "synced",
                }
            )
    return results

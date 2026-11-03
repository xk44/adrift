from __future__ import annotations

import tempfile
from pathlib import Path

from stylevault import db
from stylevault.embeddings import ColorHistogramEmbedding, serialize_embedding
from stylevault.vector_store import SqliteVectorStore


def _setup_db_with_embeddings(
    db_path: Path,
    embeddings: dict[str, list[float]],
    model_name: str = "test-model",
    model_version: str = "v1",
) -> dict[str, int]:
    db.init_db(db_path)
    asset_ids = {}
    with db.connect(db_path) as conn:
        for name, embedding in embeddings.items():
            aid = db.insert_asset(
                conn,
                source_path=f"/fake/{name}.png",
                sha256=f"sha-{name}",
                media_type="image/png",
                width=32,
                height=32,
            )
            db.insert_embedding(
                conn, aid, model_name, model_version, serialize_embedding(embedding)
            )
            asset_ids[name] = aid
        conn.commit()
    return asset_ids


def test_sqlite_cosine_similarity_identical_vectors() -> None:
    sim = SqliteVectorStore._cosine_similarity([1, 0, 0], [1, 0, 0])
    assert abs(sim - 1.0) < 1e-6


def test_sqlite_cosine_similarity_orthogonal_vectors() -> None:
    sim = SqliteVectorStore._cosine_similarity([1, 0], [0, 1])
    assert abs(sim) < 1e-6


def test_sqlite_cosine_similarity_opposite_vectors() -> None:
    sim = SqliteVectorStore._cosine_similarity([1, 0], [-1, 0])
    assert abs(sim - (-1.0)) < 1e-6


def test_sqlite_cosine_similarity_zero_vector() -> None:
    sim = SqliteVectorStore._cosine_similarity([0, 0, 0], [1, 2, 3])
    assert sim == 0.0


def test_sqlite_vector_store_search_returns_ranked_results() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "sv" / "vault.sqlite"
        model = ColorHistogramEmbedding(bins=2)
        asset_ids = _setup_db_with_embeddings(
            db_path,
            {
                "similar": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                "different": [0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
                "mid": [0.5, 0.5, 0.0, 0.0, 0.0, 0.0],
            },
            model_name=model.name,
            model_version=model.version,
        )

        store = SqliteVectorStore(db_path)
        results = store.search([1.0, 0.0, 0.0, 0.0, 0.0, 0.0], model, limit=3)

        assert len(results) == 3
        assert results[0].asset_id == asset_ids["similar"]
        assert results[0].score > results[1].score
        assert results[1].score > results[2].score


def test_sqlite_vector_store_search_respects_limit() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "sv" / "vault.sqlite"
        model = ColorHistogramEmbedding(bins=2)
        _setup_db_with_embeddings(
            db_path,
            {
                "a": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                "b": [0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
                "c": [0.0, 0.0, 1.0, 0.0, 0.0, 0.0],
            },
            model_name=model.name,
            model_version=model.version,
        )

        store = SqliteVectorStore(db_path)
        results = store.search([1.0, 0.0, 0.0, 0.0, 0.0, 0.0], model, limit=1)

        assert len(results) == 1


def test_sqlite_vector_store_sync_is_noop() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "sv" / "vault.sqlite"
        db.init_db(db_path)
        store = SqliteVectorStore(db_path)
        model = ColorHistogramEmbedding(bins=2)
        store.sync_embeddings(model)

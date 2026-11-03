from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from stylevault import db
from stylevault.clustering import _cosine_similarity


def test_cosine_similarity_identical() -> None:
    assert abs(_cosine_similarity([1, 2, 3], [1, 2, 3]) - 1.0) < 1e-6


def test_cosine_similarity_orthogonal() -> None:
    assert abs(_cosine_similarity([1, 0], [0, 1])) < 1e-6


def test_cosine_similarity_zero_vector() -> None:
    assert _cosine_similarity([0, 0], [1, 2]) == 0.0


def test_cosine_similarity_opposite() -> None:
    assert abs(_cosine_similarity([1, 0], [-1, 0]) + 1.0) < 1e-6


def test_cosine_similarity_scaled_vectors_equal() -> None:
    sim = _cosine_similarity([1, 2, 3], [10, 20, 30])
    assert abs(sim - 1.0) < 1e-6


def test_hdbscan_min_cluster_size_validation() -> None:
    import importlib.util

    if importlib.util.find_spec("hdbscan") is None:
        pytest.skip("hdbscan not installed")
    from stylevault.clustering import run_hdbscan_clustering

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "sv" / "vault.sqlite"
        db.init_db(db_path)
        with pytest.raises(ValueError, match="min_cluster_size must be greater than 1"):
            run_hdbscan_clustering(
                db_path,
                models=["test"],
                weights={"test": 1.0},
                min_cluster_size=1,
            )


def test_recursive_clustering_depth_validation() -> None:
    from stylevault.clustering import run_recursive_hdbscan_clustering

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "sv" / "vault.sqlite"
        db.init_db(db_path)
        with pytest.raises(ValueError, match="max_depth must be at least 1"):
            run_recursive_hdbscan_clustering(
                db_path,
                models=["test"],
                weights={"test": 1.0},
                max_depth=0,
            )


def test_recursive_clustering_min_cluster_size_validation() -> None:
    from stylevault.clustering import run_recursive_hdbscan_clustering

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "sv" / "vault.sqlite"
        db.init_db(db_path)
        with pytest.raises(ValueError, match="min_cluster_size must be greater than 1"):
            run_recursive_hdbscan_clustering(
                db_path,
                models=["test"],
                weights={"test": 1.0},
                min_cluster_size=1,
            )


def test_recursive_clustering_subcluster_size_validation() -> None:
    from stylevault.clustering import run_recursive_hdbscan_clustering

    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "sv" / "vault.sqlite"
        db.init_db(db_path)
        with pytest.raises(ValueError, match="min_subcluster_size must be greater than 1"):
            run_recursive_hdbscan_clustering(
                db_path,
                models=["test"],
                weights={"test": 1.0},
                min_subcluster_size=1,
            )

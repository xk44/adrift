from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from stylevault import indexing
from stylevault.api.app import create_app


def _write_pngs(folder: Path, count: int = 24) -> None:
    """Three colour families, with a gradient so hashes and histograms differ."""
    folder.mkdir(parents=True)
    bases = [(220, 40, 40), (40, 200, 60), (40, 60, 220)]
    for i in range(count):
        base = bases[i % 3]
        image = Image.new("RGB", (64, 64), base)
        for x in range(64):
            for y in range(0, 64, 4):
                image.putpixel((x, y), tuple((c + i * 3 + x) % 256 for c in base))
        image.save(folder / f"img_{i:03d}.png")


def _wait(client: TestClient, timeout: float = 120.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.get("/library/index/status").json()
        if status["state"] in ("done", "error"):
            return status
        time.sleep(0.1)
    raise AssertionError("index job did not finish")


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("STYLEVAULT_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("STYLEVAULT_EMBEDDER", "color-histogram")
    monkeypatch.setenv("STYLEVAULT_ALLOWED_ROOTS", str(tmp_path / "allowed"))
    return TestClient(create_app(tmp_path / "home" / "config.toml"))


def test_empty_library_health(client: TestClient) -> None:
    health = client.get("/health").json()
    assert health == {"status": "ok", "assets": 0, "embedder": "color-histogram"}
    assert client.get("/library/index/status").json()["state"] == "idle"


def test_index_folder_end_to_end(client: TestClient, tmp_path: Path) -> None:
    folder = tmp_path / "allowed" / "set"
    _write_pngs(folder)
    response = client.post("/library/index", json={"folder": str(folder)})
    assert response.status_code == 200
    assert response.json()["job"]

    status = _wait(client)
    assert status["state"] == "done", status
    assert status["error"] is None
    assert status["assets"] == 24

    assert client.get("/health").json()["assets"] == 24

    runs = client.get("/umap/runs").json()
    assert len(runs) == 1
    points = client.get(f"/umap/runs/{runs[0]['id']}/points").json()
    assert len(points["points"] if isinstance(points, dict) else points) == 24

    tree = client.get("/clusters/tree").json()
    assert tree

    listed = client.get("/assets", params={"limit": 5}).json()
    assert listed["total_count"] == 24
    assert len(listed["results"]) == 5
    assert listed["results"][0]["asset_id"] > listed["results"][1]["asset_id"]

    found = client.get("/search", params={"query": "img_001"}).json()
    results = found["results"] if isinstance(found, dict) else found
    assert results
    first = results[0]
    asset_id = first.get("id", first.get("asset_id"))

    thumb = client.get(f"/assets/{asset_id}/thumb")
    assert thumb.status_code == 200
    assert client.get(f"/assets/{asset_id}/file").status_code == 200
    assert client.get("/assets/999999/thumb").status_code == 404
    assert client.get("/assets/999999/file").status_code == 404


def test_reindex_adds_new_images_and_keeps_one_tree(client: TestClient, tmp_path: Path) -> None:
    folder = tmp_path / "allowed" / "set"
    _write_pngs(folder)
    client.post("/library/index", json={"folder": str(folder)})
    assert _wait(client)["state"] == "done"
    first_ids = _tree_ids(client.get("/clusters/tree").json())

    Image.new("RGB", (64, 64), (9, 9, 9)).save(folder / "new.png")
    client.post("/library/index", json={"folder": str(folder)})
    status = _wait(client)
    assert status["state"] == "done", status
    assert status["assets"] == 25

    latest = max(client.get("/umap/runs").json(), key=lambda run: run["id"])
    points = client.get(f"/umap/runs/{latest['id']}/points").json()
    assert len(points["points"] if isinstance(points, dict) else points) == 25
    assert _tree_ids(client.get("/clusters/tree").json()).isdisjoint(first_ids)


def _tree_ids(tree: object) -> set[int]:
    nodes = tree["clusters"] if isinstance(tree, dict) and "clusters" in tree else tree
    ids: set[int] = set()
    stack = list(nodes)
    while stack:
        node = stack.pop()
        ids.add(node["id"])
        stack.extend(node.get("children", []))
    return ids


def test_few_images_skip_the_map(client: TestClient, tmp_path: Path) -> None:
    folder = tmp_path / "allowed" / "few"
    _write_pngs(folder, count=3)
    client.post("/library/index", json={"folder": str(folder)})
    status = _wait(client)
    assert status["state"] == "done", status
    assert client.get("/umap/runs").json() == []


def test_empty_folder_reports_error(client: TestClient, tmp_path: Path) -> None:
    folder = tmp_path / "allowed" / "empty"
    folder.mkdir(parents=True)
    client.post("/library/index", json={"folder": str(folder)})
    status = _wait(client)
    assert status["state"] == "error"
    assert "No images" in status["error"]


@pytest.mark.parametrize("name", ["outside", "allowed/../outside", "allowed-sibling"])
def test_folder_outside_allowed_roots_refused(
    client: TestClient, tmp_path: Path, name: str
) -> None:
    (tmp_path / "allowed").mkdir(exist_ok=True)
    folder = tmp_path / name
    folder.mkdir(parents=True, exist_ok=True)
    response = client.post("/library/index", json={"folder": str(folder)})
    assert response.status_code == 403
    assert "STYLEVAULT_ALLOWED_ROOTS" in response.json()["detail"]


def test_symlink_out_of_allowed_root_refused(client: TestClient, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (tmp_path / "allowed").mkdir()
    link = tmp_path / "allowed" / "link"
    link.symlink_to(outside)
    assert client.post("/library/index", json={"folder": str(link)}).status_code == 403


def test_relative_and_unset_roots_refused(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert client.post("/library/index", json={"folder": "relative/path"}).status_code == 403
    folder = tmp_path / "allowed"
    folder.mkdir()
    monkeypatch.delenv("STYLEVAULT_ALLOWED_ROOTS")
    response = client.post("/library/index", json={"folder": str(folder)})
    assert response.status_code == 403
    assert "STYLEVAULT_ALLOWED_ROOTS" in response.json()["detail"]


def test_second_job_gets_409(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder = tmp_path / "allowed" / "set"
    folder.mkdir(parents=True)
    release = threading.Event()
    started = threading.Event()

    def blocked(*args: object, **kwargs: object) -> int:
        started.set()
        release.wait(10)
        return 0

    monkeypatch.setattr(indexing, "run_index", blocked)
    assert client.post("/library/index", json={"folder": str(folder)}).status_code == 200
    assert started.wait(5)
    assert client.post("/library/index", json={"folder": str(folder)}).status_code == 409
    assert client.get("/library/index/status").json()["state"] == "running"
    release.set()
    assert _wait(client)["state"] == "done"


def test_removed_routes_are_gone(client: TestClient) -> None:
    paths = set(client.app.openapi()["paths"])
    for path in ("/styles/mix", "/styles/by-code/{code}"):
        assert path not in paths


def test_defaults_need_no_setup(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from stylevault.config import default_config_path, load_config, stylevault_home

    monkeypatch.delenv("STYLEVAULT_EMBEDDER", raising=False)
    monkeypatch.delenv("STYLEVAULT_CONFIG", raising=False)
    monkeypatch.setenv("STYLEVAULT_HOME", str(tmp_path))
    assert stylevault_home() == tmp_path
    assert default_config_path() == tmp_path / "config.toml"
    settings = load_config(default_config_path())
    assert settings["embeddings"]["primary_model"] == "siglip2"
    assert set(settings["fusion"]["weights"]) == {"siglip2", "color-histogram"}
    monkeypatch.delenv("STYLEVAULT_HOME")
    assert stylevault_home() == Path.home() / ".adrift" / "stylevault"


def test_config_fusion_weights_replace_the_defaults(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from stylevault.config import load_config

    monkeypatch.delenv("STYLEVAULT_EMBEDDER", raising=False)
    config = tmp_path / "config.toml"
    config.write_text('[fusion]\nweights = { "color-histogram" = 1.0 }\n', encoding="utf-8")
    assert load_config(config)["fusion"]["weights"] == {"color-histogram": 1.0}

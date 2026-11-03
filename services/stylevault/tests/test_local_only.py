"""Host and Origin checks, plus the training and scan path rules."""

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from stylevault.scan import iter_image_files

api_module = importlib.import_module("stylevault.api.app")


def _client(tmp_path: Path, base_url: str = "http://127.0.0.1:8000") -> TestClient:
    return TestClient(api_module.create_app(tmp_path / "config.toml"), base_url=base_url)


@pytest.fixture(autouse=True)
def _no_extra_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("STYLEVAULT_ALLOWED_HOSTS", raising=False)


@pytest.mark.parametrize("host", ["127.0.0.1:8000", "localhost:8000", "[::1]:8000", "LOCALHOST"])
def test_loopback_hosts_are_allowed(tmp_path: Path, host: str) -> None:
    assert _client(tmp_path).get("/health", headers={"Host": host}).status_code == 200


def test_foreign_host_is_refused(tmp_path: Path) -> None:
    client = _client(tmp_path)
    assert client.get("/health", headers={"Host": "evil.example"}).status_code == 403
    assert client.get("/health", headers={"Host": "127.0.0.1.evil.example:8000"}).status_code == 403


@pytest.mark.parametrize("origin", ["https://evil.example", "null"])
def test_foreign_origin_is_refused(tmp_path: Path, origin: str) -> None:
    assert _client(tmp_path).get("/health", headers={"Origin": origin}).status_code == 403


def test_loopback_origin_is_allowed(tmp_path: Path) -> None:
    client = _client(tmp_path)
    assert client.get("/health", headers={"Origin": "http://localhost:3000"}).status_code == 200


def test_extra_host_setting(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STYLEVAULT_ALLOWED_HOSTS", "203.0.113.50")
    client = _client(tmp_path, "http://203.0.113.50:8000")
    assert client.get("/health").status_code == 200


def _job(images_dir: Path, **changes: object) -> dict:
    body: dict = {
        "backend": "ai-toolkit",
        "model_family": "krea2",
        "run_name": "r",
        "dataset": {"images_dir": str(images_dir)},
        "params": {"auto_caption": True},
    }
    body.update(changes)
    return body


def _image_dir(root: Path) -> Path:
    root.mkdir(parents=True)
    Image.new("RGB", (8, 8)).save(root / "a.png")
    return root


def test_images_dir_outside_roots_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STYLEVAULT_ALLOWED_ROOTS", str(tmp_path / "allowed"))
    outside = _image_dir(tmp_path / "outside")
    res = _client(tmp_path).post("/training/jobs", json=_job(outside))
    assert res.status_code == 403
    assert "STYLEVAULT_ALLOWED_ROOTS" in res.json()["detail"]
    assert sorted(p.name for p in outside.iterdir()) == ["a.png"]


def test_bad_caption_ext_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STYLEVAULT_ALLOWED_ROOTS", str(tmp_path))
    images = _image_dir(tmp_path / "images")
    body = _job(images)
    body["dataset"]["caption_ext"] = ".command"
    res = _client(tmp_path).post("/training/jobs", json=body)
    assert res.status_code == 400
    assert sorted(p.name for p in images.iterdir()) == ["a.png"]
    body = _job(images, params={"auto_caption": True, "caption_ext": ".command"})
    assert _client(tmp_path).post("/training/jobs", json=body).status_code == 400
    assert sorted(p.name for p in images.iterdir()) == ["a.png"]


def test_no_captions_written_when_trainer_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("STYLEVAULT_ALLOWED_ROOTS", str(tmp_path))
    images = _image_dir(tmp_path / "images")
    res = _client(tmp_path).post("/training/jobs", json=_job(images))
    assert res.status_code == 400
    assert sorted(p.name for p in images.iterdir()) == ["a.png"]


@pytest.mark.parametrize("family", ["x/../../../../evil", "..", "a/b", "a b", ""])
def test_model_family_cannot_traverse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, family: str
) -> None:
    monkeypatch.setenv("STYLEVAULT_ALLOWED_ROOTS", str(tmp_path))
    images = _image_dir(tmp_path / "images")
    client = _client(tmp_path)
    assert client.post("/training/jobs", json=_job(images, model_family=family)).status_code == 422
    assert client.post("/lora/train", json={"cluster_id": 1, "model_family": family}).status_code == 422
    assert (
        client.post("/lora/train/preview", json={"cluster_id": 1, "model_family": family}).status_code
        == 422
    )
    assert (
        client.post("/lora/train/multi", json={"cluster_id": 1, "model_families": [family]}).status_code
        == 422
    )


def test_scan_skips_symlinks_out_of_the_folder(tmp_path: Path) -> None:
    root = _image_dir(tmp_path / "allowed")
    outside = _image_dir(tmp_path / "outside")
    (root / "link.png").symlink_to(outside / "a.png")
    (root / "inside.png").symlink_to(root / "a.png")
    assert sorted(p.name for p in iter_image_files(root)) == ["a.png", "inside.png"]

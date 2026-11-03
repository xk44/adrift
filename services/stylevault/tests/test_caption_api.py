from __future__ import annotations

from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image
import pytest

from stylevault.api import caption as caption_module
from stylevault.api.app import create_app


def _image_bytes() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (8, 8), color=(20, 40, 60)).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.mark.anyio
async def test_caption_image_uses_omnitag_model(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeModel:
        name = "fake-qwen"
        version = "test"

        def generate(self, image: Image.Image, source_path: Path, prompt: str | None = None) -> str:
            return f"caption for {source_path.stem}"

    monkeypatch.setattr(caption_module, "_module_available", lambda name: True)
    monkeypatch.setattr(caption_module, "get_omnitag_model", lambda model_id: FakeModel())

    transport = httpx.ASGITransport(app=create_app(tmp_path / "missing-config.toml"))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/caption/image?filename=sample.png",
            content=_image_bytes(),
            headers={"Content-Type": "image/png"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "caption": "caption for sample",
        "model": "fake-qwen",
        "model_version": "test",
    }


@pytest.mark.anyio
async def test_caption_image_reuses_resident_model_and_maps_load_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    built: list[str] = []
    fail = {"on": False}

    class FakeModel:
        name = "fake-qwen"
        version = "cfg"
        _loaded_id = "Qwen/Qwen3-VL-4B-Instruct"

        def __init__(self, model_id: str) -> None:
            self.model_id = model_id

        def generate(self, image: Image.Image, source_path: Path, prompt: str | None = None) -> str:
            if fail["on"]:
                raise RuntimeError("No OmniTag caption model could be loaded: gated")
            return "a harbor"

    def factory(model_id: str) -> FakeModel:
        built.append(model_id)
        return FakeModel(model_id)

    monkeypatch.setattr(caption_module, "_module_available", lambda name: True)
    monkeypatch.setattr(caption_module, "get_omnitag_model", factory)

    transport = httpx.ASGITransport(app=create_app(tmp_path / "missing-config.toml"))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        for _ in range(2):
            ok = await client.post("/caption/image", content=_image_bytes())
            assert ok.status_code == 200
            assert ok.json()["model_version"] == "Qwen/Qwen3-VL-4B-Instruct"
        # A caller can't pick the repo: the configured model stays loaded.
        chosen = await client.post("/caption/image?model=a/b", content=_image_bytes())
        assert chosen.status_code == 200
        fail["on"] = True
        bad = await client.post("/caption/image", content=_image_bytes())

    assert built == ["Qwen/Qwen3-VL-4B-Instruct"]
    assert bad.status_code == 503
    assert "gated" in bad.json()["detail"]


def test_omnitag_fallback_candidates_never_download() -> None:
    from stylevault.omnitag import FALLBACK_MODEL_ID, _load_candidates

    cands = _load_candidates("org/gated", {"cache_dir": Path("/vault/models")})
    assert cands[0] == ("org/gated", {"cache_dir": Path("/vault/models")})
    assert [c[0] for c in cands[1:]] == [FALLBACK_MODEL_ID, FALLBACK_MODEL_ID]
    assert all(c[1]["local_files_only"] is True for c in cands[1:])
    assert cands[2][1]["cache_dir"] == Path.home() / ".cache" / "huggingface" / "hub"
    assert _load_candidates(FALLBACK_MODEL_ID, {}) == [(FALLBACK_MODEL_ID, {})]

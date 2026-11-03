from __future__ import annotations

import importlib
import asyncio
from pathlib import Path
import sys

import httpx
from PIL import Image
import pytest

from stylevault import db

api_module = importlib.import_module("stylevault.api.app")
training_module = importlib.import_module("stylevault.api.training")


@pytest.fixture(autouse=True)
def _allow_tmp_datasets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STYLEVAULT_ALLOWED_ROOTS", str(tmp_path))


def _write_fake_trainer(repo: Path) -> None:
    repo.mkdir(parents=True)
    script = repo / "train.py"
    script.write_text(
        "\n".join(
            [
                "from pathlib import Path",
                "import re",
                "import sys",
                "config = Path(sys.argv[-1]).read_text()",
                "match = re.search(r'training_folder = \"([^\"]+)\"', config)",
                "out = Path(match.group(1))",
                "out.mkdir(parents=True, exist_ok=True)",
                "print('step 1/2', flush=True)",
                "(out / 'fake_lora.safetensors').write_bytes(b'fake')",
                "print('step 2/2', flush=True)",
            ]
        ),
        encoding="utf-8",
    )


def test_training_log_loss_metrics_and_divergence() -> None:
    metadata = {"log_tail": []}
    for index in range(61):
        training_module._append_training_log(
            metadata,
            f"step {index + 1}/70 avr_loss={index + 0.5} pred_std=1.64e+6",
        )
    assert metadata["last_loss"] == 60.5
    assert metadata["last_pred_std"] == 1.64e6
    assert metadata["max_loss"] == 60.5
    assert len(metadata["loss_history"]) == 60
    assert metadata["loss_history"][0] == 1.5
    assert training_module._loss_exceeded_threshold(metadata, 60.0) is True
    assert training_module._loss_exceeded_threshold(metadata, 0.0) is False


def test_auto_caption_missing_sidecars_writes_trigger_and_skips_existing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image_a = tmp_path / "first.png"
    image_b = tmp_path / "second.png"
    Image.new("RGB", (4, 4)).save(image_a)
    Image.new("RGB", (4, 4)).save(image_b)
    image_b.with_suffix(".txt").write_text("keep me\n", encoding="utf-8")

    class FakeModel:
        def generate(self, image: Image.Image, source_path: Path, prompt: str | None = None) -> str:
            return f"caption for {source_path.stem}"

    monkeypatch.setattr(training_module, "_module_available", lambda name: True)
    monkeypatch.setattr(training_module, "get_omnitag_model", lambda model_id: FakeModel())

    training_module._auto_caption_missing_sidecars(
        [image_a, image_b],
        {"auto_caption": True, "trigger_word": "ohwx", "caption_ext": ".txt"},
        {},
    )

    assert image_a.with_suffix(".txt").read_text(encoding="utf-8") == "ohwx, caption for first\n"
    assert image_b.with_suffix(".txt").read_text(encoding="utf-8") == "keep me\n"


@pytest.mark.anyio
async def test_training_api_job_lifecycle_with_fake_trainer(tmp_path: Path) -> None:
    db_path = tmp_path / "vault.sqlite"
    db.init_db(db_path)
    image_dir = tmp_path / "images"
    image_dir.mkdir()
    (image_dir / "a.png").write_bytes(b"fake")
    fake_repo = tmp_path / "ai-toolkit"
    _write_fake_trainer(fake_repo)
    template_dir = tmp_path / "templates"
    template_dir.mkdir()
    (template_dir / "krea2.toml").write_text(
        "\n".join(
            [
                "[config]",
                'name = "{{run_name}}"',
                'process = [{type = "train", training_folder = "{{output_dir}}"}]',
            ]
        ),
        encoding="utf-8",
    )
    deploy_dir = tmp_path / "loras"
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        "\n".join(
            [
                "[paths]",
                f'data_dir = "{(tmp_path / "data").as_posix()}"',
                f'db_path = "{db_path.as_posix()}"',
                f'exports_dir = "{(tmp_path / "exports").as_posix()}"',
                "",
                "[trainers]",
                f'default_output_dir = "{(tmp_path / "trainer-runs").as_posix()}"',
                "",
                "[trainers.routing]",
                'krea2 = { trainer = "ai-toolkit", entrypoint = "train.py" }',
                "",
                '[trainers.adapters."ai-toolkit"]',
                f'path_to_repo = "{fake_repo.as_posix()}"',
                f'python_bin = "{sys.executable}"',
                "extra_env = {}",
                'accelerate_config_path = ""',
                f'template_config_dir = "{template_dir.as_posix()}"',
            ]
        ),
        encoding="utf-8",
    )

    transport = httpx.ASGITransport(app=api_module.create_app(config_path))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        backends = await client.get("/training/backends")
        assert backends.status_code == 200
        assert backends.json()["backends"][0]["model_families"] == ["krea2"]

        created = await client.post(
            "/training/jobs",
            json={
                "backend": "ai-toolkit",
                "model_family": "krea2",
                "run_name": "fake",
                "dataset": {"images_dir": str(image_dir), "caption_ext": ".txt"},
                "params": {"steps": 2, "rank": 4, "resolution": 64},
            },
        )
        assert created.status_code == 200
        job_id = created.json()["job_id"]

        detail = {}
        for _ in range(50):
            response = await client.get(f"/training/jobs/{job_id}")
            assert response.status_code == 200
            detail = response.json()
            if detail["status"] == "done":
                break
            await asyncio.sleep(0.05)

        assert detail["status"] == "done"
        assert detail["progress"] == 1.0
        assert detail["output_lora_path"].endswith("fake_lora.safetensors")

        jobs = await client.get("/training/jobs")
        assert jobs.status_code == 200
        assert jobs.json()[0]["job_id"] == job_id

        deployed = await client.post(
            f"/training/jobs/{job_id}/deploy",
            json={"lora_dir": str(deploy_dir), "name": "deployed"},
        )
        assert deployed.status_code == 200
        assert Path(deployed.json()["deployed_path"]).exists()
        assert deployed.json()["lora_name"] == "deployed"


def test_moss_image_scaffold_template_and_routing():
    """moss_image is UNTESTED scaffolding: template exists, routes to ai-toolkit."""
    from pathlib import Path

    from stylevault.config import DEFAULT_CONFIG

    root = Path(__file__).resolve().parents[1]
    template = (root / "trainer_templates/ai-toolkit/moss_image.toml").read_text()
    assert "arch: moss_image" in template
    assert "UNTESTED" in template
    assert "train_text_encoder: false" in template
    assert "dtype: bf16" in template
    routing = DEFAULT_CONFIG["trainers"]["routing"]
    assert routing["moss_image"] == {"trainer": "ai-toolkit", "entrypoint": "run.py"}

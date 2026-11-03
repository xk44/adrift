from __future__ import annotations

import asyncio
import importlib
import sys
import time
from pathlib import Path

import httpx
import pytest

from stylevault import db, trainers

api_module = importlib.import_module("stylevault.api.app")


@pytest.fixture(autouse=True)
def _allow_tmp_datasets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STYLEVAULT_ALLOWED_ROOTS", str(tmp_path))


def _write_config(tmp_path: Path, db_path: Path, fake_repo: Path, template_dir: Path) -> Path:
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
    return config_path


def _setup(tmp_path: Path, trainer_body: str) -> tuple[Path, Path, Path]:
    db_path = tmp_path / "vault.sqlite"
    db.init_db(db_path)
    image_dir = tmp_path / "images"
    image_dir.mkdir()
    (image_dir / "a.png").write_bytes(b"fake")
    fake_repo = tmp_path / "ai-toolkit"
    fake_repo.mkdir()
    (fake_repo / "train.py").write_text(trainer_body, encoding="utf-8")
    template_dir = tmp_path / "templates"
    template_dir.mkdir()
    (template_dir / "krea2.toml").write_text(
        '[config]\nname = "{{run_name}}"\n'
        'process = [{type = "train", training_folder = "{{output_dir}}"}]\n',
        encoding="utf-8",
    )
    return db_path, image_dir, _write_config(tmp_path, db_path, fake_repo, template_dir)


# Trainer that swallows SIGTERM and exits 0 -- the case that used to resurrect a cancelled
# job as "done". It also writes a LoRA so a non-sticky cancel would visibly "succeed".
_SIGTERM_ZERO_TRAINER = """
import re, signal, sys, time
from pathlib import Path
config = Path(sys.argv[-1]).read_text()
out = Path(re.search(r'training_folder = "([^"]+)"', config).group(1))
out.mkdir(parents=True, exist_ok=True)
stop = []
signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
print("step 1/2", flush=True)
deadline = time.time() + 20
while not stop and time.time() < deadline:
    time.sleep(0.02)
(out / "fake_lora.safetensors").write_bytes(b"fake")
print("step 2/2", flush=True)
sys.exit(0)
"""

_FAST_TRAINER = """
import re, sys
from pathlib import Path
config = Path(sys.argv[-1]).read_text()
out = Path(re.search(r'training_folder = "([^"]+)"', config).group(1))
out.mkdir(parents=True, exist_ok=True)
(out / "fake_lora.safetensors").write_bytes(b"fake")
print("step 1/1", flush=True)
"""


async def _poll(client: httpx.AsyncClient, job_id: int, want: set[str], tries: int = 200) -> dict:
    detail: dict = {}
    for _ in range(tries):
        detail = (await client.get(f"/training/jobs/{job_id}")).json()
        if detail["status"] in want:
            return detail
        await asyncio.sleep(0.05)
    return detail


def _job_payload(image_dir: Path) -> dict:
    return {
        "backend": "ai-toolkit",
        "model_family": "krea2",
        "run_name": "fake",
        "dataset": {"images_dir": str(image_dir), "caption_ext": ".txt"},
        "params": {"steps": 2, "rank": 4, "resolution": 64},
    }


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM trap is POSIX-only")
@pytest.mark.anyio
async def test_cancel_is_sticky_even_when_trainer_exits_zero(tmp_path: Path) -> None:
    _, image_dir, config_path = _setup(tmp_path, _SIGTERM_ZERO_TRAINER)
    transport = httpx.ASGITransport(app=api_module.create_app(config_path))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        job_id = (await client.post("/training/jobs", json=_job_payload(image_dir))).json()["job_id"]
        running = await _poll(client, job_id, {"running"})
        assert running["status"] == "running"
        # wait until the trainer has actually started (and installed its SIGTERM trap)
        for _ in range(200):
            if "step 1/2" in (await client.get(f"/training/jobs/{job_id}")).json()["log_tail"]:
                break
            await asyncio.sleep(0.05)
        assert (await client.post(f"/training/jobs/{job_id}/cancel")).json()["ok"] is True
        # give the worker time to observe the (zero) exit and finish up
        for _ in range(100):
            if job_id not in importlib.import_module("stylevault.api.training")._PROCESSES:
                break
            await asyncio.sleep(0.05)
        detail = (await client.get(f"/training/jobs/{job_id}")).json()
        assert detail["status"] == "error"
        assert detail["output_lora_path"] is None


@pytest.mark.anyio
async def test_cancel_on_finished_job_keeps_done_status(tmp_path: Path) -> None:
    _, image_dir, config_path = _setup(tmp_path, _FAST_TRAINER)
    transport = httpx.ASGITransport(app=api_module.create_app(config_path))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        job_id = (await client.post("/training/jobs", json=_job_payload(image_dir))).json()["job_id"]
        assert (await _poll(client, job_id, {"done", "error"}))["status"] == "done"
        response = await client.post(f"/training/jobs/{job_id}/cancel")
        assert response.status_code == 200
        assert (await client.get(f"/training/jobs/{job_id}")).json()["status"] == "done"
        assert (await client.post("/training/jobs/999999/cancel")).status_code == 404


def _run_status(db_path: Path, run_id: int) -> str:
    with db.connect(db_path) as conn:
        return str(db.fetch_lora_training_run_by_id(conn, run_id)["status"])


def _seed_lora_artifact(db_path: Path, lora_path: Path) -> int:
    with db.connect(db_path) as conn:
        run_id = db.insert_lora_training_run(
            conn, method="test", trainer_name="ai-toolkit", model_family="krea2",
            status="done", command=["x"], metadata={},
        )
        artifact_id = db.insert_lora_artifact(
            conn, run_id=run_id, artifact_type="lora", path=str(lora_path), metadata={}
        )
        conn.commit()
    return artifact_id


def _deploy_app(tmp_path: Path, auto_symlink: bool = True) -> tuple[Path, Path, object]:
    db_path = tmp_path / "vault.sqlite"
    db.init_db(db_path)
    comfy = tmp_path / "ComfyUI"
    (comfy / "models" / "loras").mkdir(parents=True)
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        "\n".join(
            [
                "[paths]",
                f'data_dir = "{(tmp_path / "data").as_posix()}"',
                f'db_path = "{db_path.as_posix()}"',
                "",
                "[comfyui]",
                f'path = "{comfy.as_posix()}"',
                f"auto_symlink = {'true' if auto_symlink else 'false'}",
            ]
        ),
        encoding="utf-8",
    )
    return db_path, comfy, api_module.create_app(config_path)


@pytest.mark.anyio
@pytest.mark.parametrize("subdir", ["../../../outside", "<ABS>", "a/../../../../outside"])
async def test_lora_deploy_rejects_subdir_escape(tmp_path: Path, subdir: str) -> None:
    db_path, comfy, app = _deploy_app(tmp_path)
    victim_dir = tmp_path / "outside"
    if subdir == "<ABS>":  # absolute path, kept under tmp_path so a regression can't touch /
        subdir = str(victim_dir)
    victim_dir.mkdir()
    lora = tmp_path / "trained" / "style.safetensors"
    lora.parent.mkdir()
    lora.write_bytes(b"lora")
    victim = victim_dir / "style.safetensors"
    victim.write_bytes(b"precious")  # same name: the old code unlinked this
    artifact_id = _seed_lora_artifact(db_path, lora)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(f"/loras/{artifact_id}/deploy", json={"target_subdir": subdir})
    assert response.status_code == 400
    assert victim.read_bytes() == b"precious"


@pytest.mark.anyio
async def test_lora_deploy_allows_nested_subdir(tmp_path: Path) -> None:
    db_path, comfy, app = _deploy_app(tmp_path)
    lora = tmp_path / "trained" / "style.safetensors"
    lora.parent.mkdir()
    lora.write_bytes(b"lora")
    artifact_id = _seed_lora_artifact(db_path, lora)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            f"/loras/{artifact_id}/deploy", json={"target_subdir": "stylevault/krea2"}
        )
    assert response.status_code == 200, response.text
    dest = comfy / "models" / "loras" / "stylevault" / "krea2" / "style.safetensors"
    assert dest.is_symlink() and dest.read_bytes() == b"lora"


@pytest.mark.anyio
@pytest.mark.parametrize("auto_symlink", [True, False])
async def test_lora_deploy_does_not_clobber_source_already_in_place(
    tmp_path: Path, auto_symlink: bool
) -> None:
    db_path, comfy, app = _deploy_app(tmp_path, auto_symlink=auto_symlink)
    in_place = comfy / "models" / "loras" / "stylevault" / "style.safetensors"
    in_place.parent.mkdir(parents=True)
    in_place.write_bytes(b"only-copy")
    artifact_id = _seed_lora_artifact(db_path, in_place)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(f"/loras/{artifact_id}/deploy", json={})
    assert response.status_code == 200, response.text
    assert not in_place.is_symlink()
    assert in_place.read_bytes() == b"only-copy"

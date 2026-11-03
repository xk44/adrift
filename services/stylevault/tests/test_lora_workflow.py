from __future__ import annotations

import re
import shutil

from pathlib import Path
import tempfile
import unittest

from typer.testing import CliRunner

from stylevault import db
from stylevault.cli import app
from stylevault.config import DEFAULT_CONFIG_TOML
from stylevault.trainers import (
    TrainerAdapterInfo,
    build_train_plan,
)

TEMPLATES = Path(__file__).resolve().parents[1] / "trainer_templates"


class LoraWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runner = CliRunner()

    def test_lora_training_run_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "vault.sqlite"
            db.init_db(db_path)
            with db.connect(db_path) as connection:
                run_id = db.insert_lora_training_run(
                    connection,
                    method="lora",
                    trainer_name="sd-scripts",
                    model_family="sdxl",
                    status="planned",
                    command=["python", "train.py"],
                    metadata={"note": "test"},
                )
                db.insert_lora_artifact(
                    connection,
                    run_id=run_id,
                    artifact_type="weights",
                    path="/tmp/model.safetensors",
                    metadata={},
                )
                node_id = db.upsert_style_node(
                    connection,
                    style_name="style_cluster_0042",
                    source_cluster_id=42,
                    metadata={"source": "test"},
                )
                db.upsert_style_variant(
                    connection,
                    style_node_id=node_id,
                    run_id=run_id,
                    model_family="sdxl",
                    base_model="sdxl-base",
                    variant_name="style_cluster_0042_sdxl_v1",
                    metadata={"status": "planned"},
                )
                connection.commit()
                rows = db.fetch_lora_training_runs(connection, limit=5)
                styles = db.fetch_style_nodes(connection)
                variants = db.fetch_style_variants_for_node(connection, node_id)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["trainer_name"], "sd-scripts")
            self.assertEqual(len(styles), 1)
            self.assertEqual(styles[0]["style_name"], "style_cluster_0042")
            self.assertEqual(len(variants), 1)
            self.assertEqual(variants[0]["base_model"], "sdxl-base")

    def test_lora_list_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            config_path = root / "config.toml"
            config_path.write_text(DEFAULT_CONFIG_TOML, encoding="utf-8")
            db_path = root / "vault.sqlite"
            db.init_db(db_path)
            with db.connect(db_path) as connection:
                run_id = db.insert_lora_training_run(
                    connection,
                    method="lora",
                    trainer_name="ai-toolkit",
                    model_family="sdxl",
                    status="planned",
                    command=["python", "trainer.py"],
                    metadata={},
                )
                node_id = db.upsert_style_node(
                    connection,
                    style_name="style_cluster_0001",
                    source_cluster_id=1,
                    metadata={},
                )
                db.upsert_style_variant(
                    connection,
                    style_node_id=node_id,
                    run_id=run_id,
                    model_family="sdxl",
                    base_model=None,
                    variant_name="style_cluster_0001_sdxl_v1",
                    metadata={},
                )
                connection.commit()

            result = self.runner.invoke(app, ["lora", "list", "--config", str(config_path)])
            self.assertEqual(result.exit_code, 0)
            self.assertIn("ai-toolkit", result.stdout)

            style_result = self.runner.invoke(app, ["style", "list", "--config", str(config_path)])
            self.assertEqual(style_result.exit_code, 0)
            self.assertIn("style_cluster_0001", style_result.stdout)
            self.assertIn("sdxl", style_result.stdout)


    def _adapter(self, name: str, root: Path) -> TrainerAdapterInfo:
        repo = root / name
        repo.mkdir(parents=True, exist_ok=True)
        (repo / "train.py").write_text("print('ok')", encoding="utf-8")
        (repo / "train_network.py").write_text("print('ok')", encoding="utf-8")
        (repo / "sdxl_train_network.py").write_text("print('ok')", encoding="utf-8")
        (repo / "flux_train_network.py").write_text("print('ok')", encoding="utf-8")
        return TrainerAdapterInfo(
            name=name,
            path=repo,
            python_bin=None,
            accelerate_config_path=None,
            template_config_dir=None,
            extra_env={},
            exists=True,
            version=None,
        )

    def test_train_plan_sd_scripts_entrypoint_and_args(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            adapter = self._adapter("sd-scripts", root)
            manifest = root / "dataset.json"
            manifest.write_text("{}", encoding="utf-8")
            plan = build_train_plan(
                settings={"trainers": {"default_trainer": "sd-scripts"}},
                config_path=root / "config.toml",
                adapters=[adapter],
                routes={"flux1": {"trainer": "sd-scripts", "entrypoint": ""}},
                model_family="flux1",
                dataset_manifest_path=manifest,
                output_dir=root / "out",
                base_model="my-base",
                dry_run=False,
            )
            joined = " ".join(plan.command)
            self.assertIn("flux_train_network.py", joined)
            self.assertIn("--dataset_config", joined)
            self.assertIn("--pretrained_model_name_or_path", joined)

    def test_train_plan_ai_toolkit_renders_template(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            adapter = self._adapter("ai-toolkit", root)
            template_dir = root / "templates"
            template_dir.mkdir(parents=True, exist_ok=True)
            (template_dir / "sdxl.toml").write_text(
                "dataset={{dataset_manifest}}\noutput={{output_dir}}\nbase={{base_model}}\n",
                encoding="utf-8",
            )
            adapter = TrainerAdapterInfo(
                name=adapter.name,
                path=adapter.path,
                python_bin=adapter.python_bin,
                accelerate_config_path=adapter.accelerate_config_path,
                template_config_dir=template_dir,
                extra_env=adapter.extra_env,
                exists=adapter.exists,
                version=adapter.version,
            )
            manifest = root / "dataset.json"
            manifest.write_text("{}", encoding="utf-8")
            plan = build_train_plan(
                settings={"trainers": {"default_trainer": "ai-toolkit"}},
                config_path=root / "config.toml",
                adapters=[adapter],
                routes={"sdxl": {"trainer": "ai-toolkit", "entrypoint": "train.py"}},
                model_family="sdxl",
                dataset_manifest_path=manifest,
                output_dir=root / "out",
                base_model="base-x",
                dry_run=False,
            )
            self.assertIsNotNone(plan.rendered_config_path)
            assert plan.rendered_config_path is not None
            text = plan.rendered_config_path.read_text(encoding="utf-8")
            self.assertIn("base=base-x", text)
            self.assertIn(str(plan.rendered_config_path), plan.command)

    def test_train_plan_musubi_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            adapter = self._adapter("musubi-tuner", root)
            manifest = root / "dataset.json"
            manifest.write_text("{}", encoding="utf-8")
            plan = build_train_plan(
                settings={"trainers": {"default_trainer": "musubi-tuner"}},
                config_path=root / "config.toml",
                adapters=[adapter],
                routes={"zimage_turbo": {"trainer": "musubi-tuner", "entrypoint": ""}},
                model_family="zimage_turbo",
                dataset_manifest_path=manifest,
                output_dir=root / "out",
                base_model=None,
                dry_run=False,
            )
            self.assertEqual(plan.entrypoint, "train_network.py")
            self.assertIn("--dataset-manifest", " ".join(plan.command))

    def test_train_plan_musubi_krea2_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            repo = root / "musubi-tuner"
            (repo / "src/musubi_tuner").mkdir(parents=True, exist_ok=True)
            for name in (
                "krea2_cache_latents.py",
                "krea2_cache_text_encoder_outputs.py",
                "krea2_train_network.py",
            ):
                (repo / "src/musubi_tuner" / name).write_text("print('ok')", encoding="utf-8")
            template_dir = root / "templates"
            shutil.copytree(TEMPLATES / "musubi-tuner", template_dir)
            filled = (template_dir / "krea2.toml").read_text(encoding="utf-8")
            filled = re.sub(r'= ""\s*# set to a local file path', '= "/models/m.safetensors"', filled)
            (template_dir / "krea2.toml").write_text(filled, encoding="utf-8")
            adapter = TrainerAdapterInfo(
                name="musubi-tuner",
                path=repo,
                python_bin=None,
                accelerate_config_path=None,
                template_config_dir=template_dir,
                extra_env={},
                exists=True,
                version=None,
            )
            manifest = root / "dataset" / "manifest.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text("{}", encoding="utf-8")
            plan = build_train_plan(
                settings={"trainers": {"default_trainer": "musubi-tuner"}},
                config_path=root / "config.toml",
                adapters=[adapter],
                routes={"krea2": {"trainer": "musubi-tuner", "entrypoint": ""}},
                model_family="krea2",
                dataset_manifest_path=manifest,
                output_dir=root / "out",
                base_model=None,
                dry_run=False,
                params={"steps": 10, "rank": 16, "blocks_to_swap": 20},
            )
            self.assertEqual(len(plan.commands), 3)
            joined = "\n".join(" ".join(command) for command in plan.commands)
            self.assertIn("krea2_cache_latents.py", joined)
            self.assertIn("krea2_cache_text_encoder_outputs.py", joined)
            self.assertIn("krea2_train_network.py", joined)
            self.assertIn("--blocks_to_swap 20", joined)
            self.assertIn("networks.lora_krea2", joined)
            self.assertIn("exclude_patterns=", joined)
            self.assertIsNotNone(plan.rendered_config_path)
            self.assertTrue((root / "out" / "musubi-tuner-krea2.dataset.rendered.toml").exists())

            train_all_plan = build_train_plan(
                settings={"trainers": {"default_trainer": "musubi-tuner"}},
                config_path=root / "config.toml",
                adapters=[adapter],
                routes={"krea2": {"trainer": "musubi-tuner", "entrypoint": ""}},
                model_family="krea2",
                dataset_manifest_path=manifest,
                output_dir=root / "out-all",
                base_model=None,
                dry_run=False,
                params={"steps": 10, "rank": 16, "blocks_to_swap": 20, "exclude_shared": False},
            )
            train_all_joined = "\n".join(" ".join(command) for command in train_all_plan.commands)
            self.assertNotIn("exclude_patterns=", train_all_joined)

    def test_train_plan_ai_toolkit_krea2_template_renders(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            adapter = self._adapter("ai-toolkit", root)
            adapter = TrainerAdapterInfo(
                name=adapter.name,
                path=adapter.path,
                python_bin=adapter.python_bin,
                accelerate_config_path=adapter.accelerate_config_path,
                template_config_dir=TEMPLATES / "ai-toolkit",
                extra_env=adapter.extra_env,
                exists=adapter.exists,
                version=adapter.version,
            )
            manifest = root / "dataset" / "manifest.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text("{}", encoding="utf-8")
            plan = build_train_plan(
                settings={"trainers": {"default_trainer": "ai-toolkit"}},
                config_path=root / "config.toml",
                adapters=[adapter],
                routes={"krea2": {"trainer": "ai-toolkit", "entrypoint": "train.py"}},
                model_family="krea2",
                dataset_manifest_path=manifest,
                output_dir=root / "out",
                base_model="/models/krea2_turbo.safetensors",
                dry_run=False,
                params={"steps": 10, "lr": "2e-4", "rank": 16, "resolution": 1024},
            )
            assert plan.rendered_config_path is not None
            text = plan.rendered_config_path.read_text(encoding="utf-8")
            self.assertEqual(plan.rendered_config_path.suffix, ".yaml")
            self.assertIn("arch: krea2", text)
            self.assertIn("steps: 10", text)
            self.assertIn("linear: 16", text)
            self.assertIn('name_or_path: "/models/krea2_turbo.safetensors"', text)
            self.assertIn("krea2_turbo_training_adapter_v1.safetensors", text)
            self.assertNotIn("{{", text)
            # upstream run.py argparse only accepts config files; --base-model would exit 2
            self.assertNotIn("--base-model", plan.command)
            self.assertEqual(plan.command[-1], str(plan.rendered_config_path))


if __name__ == "__main__":
    unittest.main()

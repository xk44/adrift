from __future__ import annotations

import random
from pathlib import Path

from PIL import Image
from typer.testing import CliRunner

from stylevault.cli import app, resolve_fusion_models


def test_resolve_fusion_models_returns_weight_mapping() -> None:
    settings = {"fusion": {"weights": {"model-a": 0.5, "siglip2": 0.3, "color-histogram": 0.2}}}
    models, weights = resolve_fusion_models(settings, None, None)
    assert models == ["model-a", "siglip2", "color-histogram"]
    assert weights == {"model-a": 0.5, "siglip2": 0.3, "color-histogram": 0.2}
    assert resolve_fusion_models(settings, ["siglip2", "model-a"], None)[1] == {
        "siglip2": 0.3,
        "model-a": 0.5,
    }
    assert resolve_fusion_models({}, ["a", "b"], [2, 1])[1] == {"a": 2.0, "b": 1.0}


def test_cli_knn_graph_and_cluster_tree_run_on_fused_weights(tmp_path: Path) -> None:
    # Regression: the CLI passed a positional weight *list* where fusion expects a dict,
    # so knn-graph/cluster/cluster-tree/umap always died with "Missing fusion weights".
    images = tmp_path / "imgs"
    images.mkdir()
    rng = random.Random(0)
    for index in range(18):
        base = [(200, 30, 30), (30, 200, 30), (30, 30, 200)][index % 3]
        color = tuple(max(0, min(255, c + rng.randint(-20, 20))) for c in base)
        Image.new("RGB", (32, 32), color).save(images / f"{index}.png")
    config = tmp_path / "config.toml"
    config.write_text(
        "[paths]\n"
        + "".join(
            f'{key} = "{(tmp_path / value).as_posix()}"\n'
            for key, value in {
                "data_dir": "data",
                "db_path": "data/v.sqlite",
                "thumbs_dir": "thumbs",
                "exports_dir": "exp",
                "logs_dir": "logs",
                "indices_dir": "idx",
                "models_dir": "models",
            }.items()
        )
        + '\n[fusion]\nweights = { "color-histogram" = 1.0 }\n',
        encoding="utf-8",
    )
    runner = CliRunner()
    for args in (
        ["init"],
        ["scan", str(images)],
        ["embed", "--model", "color-histogram"],
        ["knn-graph", "--k", "4"],
        ["cluster-tree", "--min-cluster-size", "3"],
    ):
        result = runner.invoke(app, [*args, "--config", str(config)])
        assert result.exit_code == 0, (args, result.output, result.exception)

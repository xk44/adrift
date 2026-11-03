from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

import stylevault.cli as cli
from stylevault import db


def _config(tmp_path: Path, init: bool) -> Path:
    db_path = tmp_path / "data" / "vault.sqlite"
    config = tmp_path / "config.toml"
    config.write_text(
        f'[paths]\ndata_dir = "{(tmp_path / "data").as_posix()}"\n'
        f'db_path = "{db_path.as_posix()}"\n',
        encoding="utf-8",
    )
    if init:
        db_path.parent.mkdir(parents=True)
        db.init_db(db_path)
    return config


@pytest.mark.parametrize(
    "args",
    [
        ["status"],
        ["facets"],
        ["search-index-rebuild"],
        ["export-clusters", "1"],
        ["cluster-assign", "1"],
        ["export-by-tag", "t", "TARGET"],
        ["lora", "list"],
        ["style", "list"],
        ["text-search", "x"],
    ],
)
def test_db_commands_exit_cleanly_before_init(tmp_path: Path, args: list[str]) -> None:
    config = _config(tmp_path, init=False)
    args = [a.replace("TARGET", str(tmp_path / "tgt")) for a in args]
    result = CliRunner().invoke(cli.app, [*args, "--config", str(config)])
    assert result.exit_code == 1, (result.output, result.exception)
    assert not isinstance(result.exception, Exception) or isinstance(result.exception, SystemExit)
    assert "Database not found" in result.output
    assert not (tmp_path / "data" / "vault.sqlite").exists()

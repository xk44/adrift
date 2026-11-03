from __future__ import annotations

from pathlib import Path

import pytest

from stylevault.config import resolve_config_paths, validate_config


def test_paths_expand_user_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    config_path = tmp_path / "cfg" / "config.toml"
    settings = {"paths": {"db_path": "~/sv/vault.sqlite", "thumbs_dir": "rel/thumbs"}}
    paths = resolve_config_paths(settings, config_path)
    assert paths["db_path"] == home / "sv" / "vault.sqlite"  # not <cfg>/~/sv/...
    assert paths["thumbs_dir"] == tmp_path / "cfg" / "rel" / "thumbs"


def test_validate_config_expands_user_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    (home / "notadir").parent.mkdir(parents=True)
    (home / "notadir").write_text("x")
    monkeypatch.setenv("HOME", str(home))
    errors, _ = validate_config({"paths": {"thumbs_dir": "~/notadir"}}, tmp_path / "config.toml")
    assert any("thumbs_dir must point to a directory" in e for e in errors)

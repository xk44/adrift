from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from typer.testing import CliRunner

from stylevault import db
from stylevault.cli import app as cli_app


def _seed(db_path: Path, index: int, caption: str) -> int:
    with db.connect(db_path) as connection:
        asset_id = db.insert_asset(
            connection,
            source_path=str(db_path.parent / f"asset-{index}.png"),
            sha256=f"sha-{index}",
            media_type="image",
            width=8,
            height=8,
        )
        db.insert_caption(
            connection,
            asset_id=asset_id,
            model_name="test-model",
            model_version="1",
            caption_type="short",
            caption=caption,
        )
        connection.commit()
    return asset_id


@pytest.fixture
def seeded(tmp_path: Path) -> tuple[Path, int, int]:
    db_path = tmp_path / "vault.sqlite"
    db.init_db(db_path)
    first = _seed(db_path, 1, "blue-green water at dusk style:anime")
    second = _seed(db_path, 2, "red desert c++ it's 100% dry")
    return db_path, first, second


def test_connect_context_manager_closes_connection(tmp_path: Path) -> None:
    db_path = tmp_path / "vault.sqlite"
    db.init_db(db_path)
    with db.connect(db_path) as connection:
        connection.execute("SELECT 1")
    with pytest.raises(sqlite3.ProgrammingError):
        connection.execute("SELECT 1")


def test_connect_context_manager_commits_then_closes(tmp_path: Path) -> None:
    db_path = tmp_path / "vault.sqlite"
    db.init_db(db_path)
    with db.connect(db_path) as connection:
        connection.execute("CREATE TABLE probe(x INTEGER)")
        connection.execute("INSERT INTO probe VALUES (1)")
    with db.connect(db_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM probe").fetchone()[0] == 1


def test_connect_context_manager_rolls_back_on_error(tmp_path: Path) -> None:
    db_path = tmp_path / "vault.sqlite"
    db.init_db(db_path)
    with db.connect(db_path) as connection:
        connection.execute("CREATE TABLE probe(x INTEGER)")
    with pytest.raises(RuntimeError):
        with db.connect(db_path) as connection:
            connection.execute("INSERT INTO probe VALUES (1)")
            raise RuntimeError("boom")
    with db.connect(db_path) as connection:
        assert connection.execute("SELECT COUNT(*) FROM probe").fetchone()[0] == 0


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("blue-green water", "first"),  # raw: "no such column: green"
        ("style:anime", "first"),  # raw: "no such column: style"
        ('say "dusk', None),  # raw: "unterminated string"
        ("c++", "second"),  # raw: fts5 syntax error near "+"
        ("it's", "second"),  # raw: fts5 syntax error near "'"
        ("100%", "second"),
        ("AND", None),
        ("(", None),
    ],
)
def test_search_falls_back_to_literal_on_fts_syntax_errors(
    seeded: tuple[Path, int, int], query: str, expected: str | None
) -> None:
    db_path, first, second = seeded
    with db.connect(db_path) as connection:
        results = db.search_assets(connection, query)
        count = db.count_search_assets(connection, query)
    ids = [asset_id for asset_id, _ in results]
    if expected == "first":
        assert ids == [first]
    elif expected == "second":
        assert ids == [second]
    else:
        assert ids == []
    assert count == len(ids)


def test_search_keeps_raw_fts_syntax_for_power_users(seeded: tuple[Path, int, int]) -> None:
    db_path, first, second = seeded
    with db.connect(db_path) as connection:
        assert {a for a, _ in db.search_assets(connection, "dusk OR desert")} == {first, second}
        assert [a for a, _ in db.search_assets(connection, "des*")] == [second]
        assert db.count_search_assets(connection, "dusk OR desert") == 2


def test_search_blank_query_returns_empty(seeded: tuple[Path, int, int]) -> None:
    db_path, _, _ = seeded
    with db.connect(db_path) as connection:
        assert db.search_assets(connection, "   ") == []
        assert db.count_search_assets(connection, "") == 0


def test_search_real_errors_still_propagate(tmp_path: Path) -> None:
    db_path = tmp_path / "empty.sqlite"
    sqlite3.connect(db_path).close()  # no schema -> "no such table", must not be swallowed
    with db.connect(db_path) as connection:
        with pytest.raises(sqlite3.OperationalError, match="no such table"):
            db.search_assets(connection, "anything")


def test_cli_text_search_natural_query_and_missing_db(
    seeded: tuple[Path, int, int], tmp_path: Path
) -> None:
    db_path, first, _ = seeded
    config_path = tmp_path / "config.toml"
    config_path.write_text(f'[paths]\ndb_path = "{db_path.as_posix()}"\n')
    runner = CliRunner()

    result = runner.invoke(
        cli_app, ["text-search", "blue-green water", "--json", "--config", str(config_path)]
    )
    assert result.exit_code == 0, result.output
    assert f'"asset_id": {first}' in result.output

    missing_cfg = tmp_path / "missing.toml"
    missing_db = tmp_path / "nope" / "vault.sqlite"
    missing_cfg.write_text(f'[paths]\ndb_path = "{missing_db.as_posix()}"\n')
    result = runner.invoke(cli_app, ["text-search", "x", "--config", str(missing_cfg)])
    assert result.exit_code == 1
    assert "Database not found" in result.output
    assert not missing_db.exists()

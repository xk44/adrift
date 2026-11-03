from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from stylevault import db
from stylevault.curation import undo_manifest


class MigrationAndUndoTests(unittest.TestCase):
    def test_migrate_adds_columns(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "vault.sqlite"
            connection = sqlite3.connect(db_path)
            connection.execute(
                "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE assets (id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT NOT NULL UNIQUE, "
                "sha256 TEXT NOT NULL UNIQUE, media_type TEXT NOT NULL, width INTEGER, height INTEGER, "
                "created_at TEXT NOT NULL DEFAULT (datetime('now')), "
                "updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
            )
            connection.execute(
                "CREATE TABLE clusters (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_id INTEGER, "
                "created_at TEXT NOT NULL DEFAULT (datetime('now')))"
            )
            connection.execute(
                "INSERT INTO metadata(key, value) VALUES(?, ?)",
                ("schema_version", "1"),
            )
            connection.commit()
            connection.close()

            with db.connect(db_path) as conn:
                applied = db.migrate_connection(conn)
                self.assertIn("v2", applied)
                columns = {
                    row["name"] for row in conn.execute("PRAGMA table_info(assets)").fetchall()
                }
                self.assertIn("file_size", columns)
                self.assertIn("mtime", columns)

    def test_undo_manifest_restore_and_remove(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "vault.sqlite"
            db.init_db(db_path)

            source = root / "source.jpg"
            source.write_text("data")
            with db.connect(db_path) as connection:
                asset_id = db.insert_asset(
                    connection,
                    source_path=str(source),
                    sha256="abc",
                    media_type="jpg",
                    width=1,
                    height=1,
                )
                connection.commit()

            moved = root / "moved.jpg"
            manifest_path = root / "manifest.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "undo": {
                            "remove_targets": [str(root / "remove.me")],
                            "restore_paths": [
                                {
                                    "asset_id": asset_id,
                                    "source_path": str(source),
                                    "target_path": str(moved),
                                }
                            ],
                        }
                    }
                ),
                encoding="utf-8",
            )
            remove_target = root / "remove.me"
            remove_target.write_text("remove")

            stats = undo_manifest(db_path, manifest_path, dry_run=False)
            self.assertEqual(stats["removed"], 1)
            self.assertEqual(stats["restored"], 1)
            self.assertTrue(moved.exists())

            with db.connect(db_path) as connection:
                asset = db.fetch_asset_by_id(connection, asset_id)
            self.assertEqual(Path(asset["source_path"]), moved)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from stylevault import db


class EmbeddingModelVersioningTests(unittest.TestCase):
    def test_embeddings_are_versioned_per_asset_and_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "stylevault" / "vault.sqlite"
            db.init_db(db_path)

            with db.connect(db_path) as connection:
                asset_id = db.insert_asset(
                    connection,
                    source_path=str(root / "asset.png"),
                    sha256="abc123",
                    media_type="image/png",
                    width=32,
                    height=32,
                )
                db.insert_embedding(connection, asset_id, "model-a", "v1", b"old-v1")
                db.insert_embedding(connection, asset_id, "model-a", "v2", b"v2")
                db.insert_embedding(connection, asset_id, "model-a", "v1", b"new-v1")
                connection.commit()

                rows = connection.execute(
                    """
                    SELECT model_name, model_version, embedding
                    FROM embeddings
                    WHERE asset_id = ?
                    ORDER BY model_version
                    """,
                    (asset_id,),
                ).fetchall()

            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["model_name"], "model-a")
            self.assertEqual(rows[0]["model_version"], "v1")
            self.assertEqual(rows[0]["embedding"], b"new-v1")
            self.assertEqual(rows[1]["model_version"], "v2")
            self.assertEqual(rows[1]["embedding"], b"v2")


if __name__ == "__main__":
    unittest.main()

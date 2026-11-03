from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from stylevault import db
from stylevault.embeddings import serialize_embedding
from stylevault.fusion import build_fused_embeddings


class FusionWeightsTests(unittest.TestCase):
    def test_fusion_weights_are_user_configurable_and_normalized(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "stylevault" / "vault.sqlite"
            db.init_db(db_path)

            with db.connect(db_path) as connection:
                asset_id = db.insert_asset(
                    connection,
                    source_path=str(root / "asset.png"),
                    sha256="asset-a",
                    media_type="image/png",
                    width=32,
                    height=32,
                )
                db.insert_embedding(
                    connection,
                    asset_id,
                    "model-a",
                    "v1",
                    serialize_embedding([1.0, 2.0]),
                )
                db.insert_embedding(
                    connection,
                    asset_id,
                    "model-b",
                    "v1",
                    serialize_embedding([10.0, 20.0]),
                )
                connection.commit()

            fused = build_fused_embeddings(
                db_path,
                models=["model-a", "model-b"],
                weights={"model-a": 2.0, "model-b": 1.0},
            )

            self.assertEqual(fused.asset_ids, [asset_id])
            self.assertEqual(fused.model_versions, {"model-a": "v1", "model-b": "v1"})
            self.assertEqual(fused.weights, {"model-a": 2.0 / 3.0, "model-b": 1.0 / 3.0})
            self.assertEqual(
                fused.embeddings[0],
                [
                    1.0 * (2.0 / 3.0),
                    2.0 * (2.0 / 3.0),
                    10.0 * (1.0 / 3.0),
                    20.0 * (1.0 / 3.0),
                ],
            )

    def test_missing_weight_raises_clear_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "stylevault" / "vault.sqlite"
            db.init_db(db_path)

            with self.assertRaisesRegex(ValueError, "Missing fusion weights"):
                build_fused_embeddings(
                    db_path,
                    models=["model-a", "model-b"],
                    weights={"model-a": 1.0},
                )


if __name__ == "__main__":
    unittest.main()


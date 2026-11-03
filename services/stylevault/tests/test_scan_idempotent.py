from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from PIL import Image

from stylevault import db
from stylevault.scan import scan_directory


class ScanIdempotencyTests(unittest.TestCase):
    def _create_image(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (32, 32), color=(120, 45, 200)).save(path)

    def test_scan_is_idempotent_for_same_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "stylevault" / "vault.sqlite"
            thumbs_dir = root / "stylevault" / "thumbs"
            image_path = root / "images" / "sample.png"
            self._create_image(image_path)

            db.init_db(db_path)

            first = scan_directory(
                root=image_path.parent,
                db_path=db_path,
                thumbs_dir=thumbs_dir,
                workers=1,
            )
            second = scan_directory(
                root=image_path.parent,
                db_path=db_path,
                thumbs_dir=thumbs_dir,
                workers=1,
            )

            self.assertEqual(first["inserted"], 1)
            self.assertEqual(first["thumbs_created"], 1)
            self.assertEqual(second["inserted"], 0)
            self.assertEqual(second["unchanged"], 1)
            self.assertEqual(second["thumbs_created"], 0)

            with db.connect(db_path) as connection:
                row = connection.execute("SELECT COUNT(*) AS c FROM assets").fetchone()
                self.assertEqual(int(row["c"]), 1)

            self.assertEqual(len(list(thumbs_dir.glob("*.webp"))), 1)

    def test_scan_updates_asset_path_when_file_is_renamed(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            db_path = root / "stylevault" / "vault.sqlite"
            thumbs_dir = root / "stylevault" / "thumbs"
            images_dir = root / "images"
            original_path = images_dir / "sample.png"
            renamed_path = images_dir / "renamed.png"
            self._create_image(original_path)

            db.init_db(db_path)

            first = scan_directory(
                root=images_dir,
                db_path=db_path,
                thumbs_dir=thumbs_dir,
                workers=1,
            )
            self.assertEqual(first["inserted"], 1)

            original_path.rename(renamed_path)

            second = scan_directory(
                root=images_dir,
                db_path=db_path,
                thumbs_dir=thumbs_dir,
                workers=1,
            )

            self.assertEqual(second["relocated"], 1)
            self.assertEqual(second["inserted"], 0)
            self.assertEqual(second["missing_marked"], 0)

            with db.connect(db_path) as connection:
                row = connection.execute(
                    "SELECT id, source_path FROM assets"
                ).fetchone()
                self.assertIsNotNone(row)
                assert row is not None
                self.assertEqual(Path(row["source_path"]), renamed_path.resolve())
                count = connection.execute("SELECT COUNT(*) AS c FROM assets").fetchone()
                assert count is not None
                self.assertEqual(int(count["c"]), 1)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib
from pathlib import Path
from collections.abc import Iterator
import sqlite3

from PIL import Image

from stylevault import db
from stylevault.devices import pick_device


@dataclass
class TextDetectionResult:
    has_text: bool
    has_caption: bool
    has_signature: bool


class OCRTextDetector:
    def __init__(
        self,
        backend: str,
        min_chars: int,
        caption_min_chars: int,
        signature_max_chars: int,
    ) -> None:
        self.backend = backend
        self.min_chars = min_chars
        self.caption_min_chars = caption_min_chars
        self.signature_max_chars = signature_max_chars
        self._reader = None

    def _ensure_backend(self) -> None:
        if self.backend == "tesseract":
            if importlib.util.find_spec("pytesseract") is None:
                raise RuntimeError("Missing dependency: pytesseract")
            return
        if self.backend == "paddleocr":
            if importlib.util.find_spec("paddleocr") is None:
                raise RuntimeError("Missing dependency: paddleocr")
            if self._reader is None:
                paddleocr = importlib.import_module("paddleocr")
                self._reader = paddleocr.PaddleOCR(use_angle_cls=True, lang="en")
            return
        if self.backend == "easyocr":
            if importlib.util.find_spec("easyocr") is None:
                raise RuntimeError("Missing dependency: easyocr")
            if self._reader is None:
                easyocr = importlib.import_module("easyocr")
                self._reader = easyocr.Reader(["en"], gpu=False)
            return
        raise ValueError(f"Unknown OCR backend: {self.backend}")

    def _extract_text(self, image: Image.Image) -> str:
        self._ensure_backend()
        if self.backend == "tesseract":
            pytesseract = importlib.import_module("pytesseract")
            return str(pytesseract.image_to_string(image))
        if self.backend == "paddleocr":
            if self._reader is None:
                raise RuntimeError("PaddleOCR failed to initialize.")
            result = self._reader.ocr(image, cls=True)
            return " ".join(word[1][0] for line in result for word in line)
        if self.backend == "easyocr":
            if self._reader is None:
                raise RuntimeError("EasyOCR failed to initialize.")
            results = self._reader.readtext(image)
            return " ".join(text for _, text, _ in results)
        return ""

    def detect(self, image: Image.Image) -> TextDetectionResult:
        raw_text = self._extract_text(image)
        text = " ".join(raw_text.split())
        char_count = len(text)
        line_count = len([line for line in raw_text.splitlines() if line.strip()])
        has_text = char_count >= self.min_chars
        has_caption = has_text and (char_count >= self.caption_min_chars or line_count >= 2)
        has_signature = has_text and char_count <= self.signature_max_chars
        return TextDetectionResult(has_text=has_text, has_caption=has_caption, has_signature=has_signature)


class VisionTextDetector:
    def __init__(
        self,
        model_name: str,
        pretrained: str,
        prompt_text: str,
        prompt_caption: str,
        prompt_signature: str,
        text_threshold: float,
        caption_threshold: float,
        signature_threshold: float,
    ) -> None:
        self.model_name = model_name
        self.pretrained = pretrained
        self.prompt_text = prompt_text
        self.prompt_caption = prompt_caption
        self.prompt_signature = prompt_signature
        self.text_threshold = text_threshold
        self.caption_threshold = caption_threshold
        self.signature_threshold = signature_threshold
        self._model = None
        self._preprocess = None
        self._text_features = None
        self._device = None

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        if importlib.util.find_spec("torch") is None:
            raise RuntimeError("Missing dependency: torch")
        if importlib.util.find_spec("open_clip") is None:
            raise RuntimeError("Missing dependency: open_clip_torch")

        torch = importlib.import_module("torch")
        open_clip = importlib.import_module("open_clip")
        self._device = pick_device(torch)
        model, _, preprocess = open_clip.create_model_and_transforms(
            self.model_name,
            pretrained=self.pretrained,
        )
        model.eval()
        model.to(self._device)
        for param in model.parameters():
            param.requires_grad_(False)
        tokenizer = open_clip.get_tokenizer(self.model_name)
        prompts = [self.prompt_text, self.prompt_caption, self.prompt_signature]
        tokens = tokenizer(prompts).to(self._device)
        with torch.inference_mode():
            text_features = model.encode_text(tokens)
            text_features = text_features / text_features.norm(dim=-1, keepdim=True)
        self._model = model
        self._preprocess = preprocess
        self._text_features = text_features

    def detect(self, image: Image.Image) -> TextDetectionResult:
        self._ensure_loaded()
        torch = importlib.import_module("torch")

        if self._model is None or self._preprocess is None or self._text_features is None:
            raise RuntimeError("Vision text detector failed to load.")
        image_tensor = self._preprocess(image).unsqueeze(0).to(self._device)
        with torch.inference_mode():
            image_features = self._model.encode_image(image_tensor)
            image_features = image_features / image_features.norm(dim=-1, keepdim=True)
            scores = (image_features @ self._text_features.T).squeeze().detach().cpu().tolist()
        text_score, caption_score, signature_score = (float(score) for score in scores)
        return TextDetectionResult(
            has_text=text_score >= self.text_threshold,
            has_caption=caption_score >= self.caption_threshold,
            has_signature=signature_score >= self.signature_threshold,
        )


def detect_text_assets(
    db_path: Path,
    methods: list[str],
    *,
    settings: dict,
    limit: int | None = None,
    batch_size: int = 200,
    commit_every: int = 500,
    shard_index: int = 0,
    shard_total: int = 1,
    overwrite: bool = False,
    sample_rate: float | None = None,
    sample_seed: int | None = None,
) -> dict[str, int]:
    stats = {"scanned": 0, "flagged": 0, "skipped": 0, "sampled_out": 0}
    text_settings = settings.get("text_detection", {})
    if sample_rate is None:
        sample_rate = float(text_settings.get("sample_rate", 1.0))
    if sample_seed is None:
        sample_seed = int(text_settings.get("sample_seed", 0))
    if sample_rate < 0 or sample_rate > 1:
        raise ValueError("sample_rate must be between 0 and 1.")
    ocr_detector = None
    vision_detector = None
    if "ocr" in methods:
        ocr_detector = OCRTextDetector(
            backend=str(text_settings.get("ocr_backend", "tesseract")),
            min_chars=int(text_settings.get("ocr_min_chars", 6)),
            caption_min_chars=int(text_settings.get("caption_min_chars", 30)),
            signature_max_chars=int(text_settings.get("signature_max_chars", 16)),
        )
    if "vision" in methods:
        vision_detector = VisionTextDetector(
            model_name=str(text_settings.get("vision_model", "ViT-L-14")),
            pretrained=str(text_settings.get("vision_pretrained", "openai")),
            prompt_text=str(
                text_settings.get(
                    "vision_prompt_text",
                    "text overlay, caption, subtitle, handwriting, watermark, signature",
                )
            ),
            prompt_caption=str(
                text_settings.get(
                    "vision_prompt_caption",
                    "image contains a caption or subtitle",
                )
            ),
            prompt_signature=str(
                text_settings.get(
                    "vision_prompt_signature",
                    "artist signature or signed artwork",
                )
            ),
            text_threshold=float(text_settings.get("vision_text_threshold", 0.24)),
            caption_threshold=float(text_settings.get("vision_caption_threshold", 0.26)),
            signature_threshold=float(text_settings.get("vision_signature_threshold", 0.23)),
        )

    with db.connect(db_path) as connection:
        pending = 0
        limit_remaining = limit

        def iter_assets() -> Iterator[sqlite3.Row]:
            if not overwrite:
                yield from db.iter_assets_missing_text_detection(
                    connection,
                    methods=methods,
                    batch_size=batch_size,
                    shard_total=shard_total,
                    shard_index=shard_index,
                )
                return
            last_id = 0
            while True:
                conditions = ["id > ?"]
                params: list[object] = [last_id]
                if shard_total > 1:
                    conditions.append("(id % ?) = ?")
                    params.extend([shard_total, shard_index])
                query = f"""
                    SELECT *
                    FROM assets
                    WHERE {' AND '.join(conditions)}
                    ORDER BY id
                    LIMIT ?
                """
                params.append(batch_size)
                rows = connection.execute(query, params).fetchall()
                if not rows:
                    break
                last_id = int(rows[-1]["id"])
                for row in rows:
                    yield row

        for asset in iter_assets():
            if limit_remaining is not None and limit_remaining <= 0:
                break
            asset_id = int(asset["id"])
            if sample_rate < 1.0:
                token = f"{sample_seed}:{asset_id}".encode("utf-8")
                digest = hashlib.blake2b(token, digest_size=8).digest()
                threshold = int.from_bytes(digest, "big") / 2**64
                if threshold >= sample_rate:
                    stats["sampled_out"] += 1
                    continue
            source_path = asset["source_path"]
            stats["scanned"] += 1
            if limit_remaining is not None:
                limit_remaining -= 1
            try:
                with Image.open(source_path) as image:
                    image = image.convert("RGB")
                    ocr_result = ocr_detector.detect(image) if ocr_detector else None
                    vision_result = vision_detector.detect(image) if vision_detector else None
            except OSError:
                stats["skipped"] += 1
                continue

            text_detected_ocr = int(ocr_result.has_text) if ocr_result else None
            text_detected_vision = int(vision_result.has_text) if vision_result else None
            if ocr_result or vision_result:
                has_caption = (ocr_result.has_caption if ocr_result else False) or (
                    vision_result.has_caption if vision_result else False
                )
                has_signature = (ocr_result.has_signature if ocr_result else False) or (
                    vision_result.has_signature if vision_result else False
                )
                existing_caption = asset["text_detected_caption"]
                existing_signature = asset["text_detected_signature"]
                text_detected_caption = int(
                    has_caption or (existing_caption is not None and int(existing_caption) == 1)
                )
                text_detected_signature = int(
                    has_signature
                    or (existing_signature is not None and int(existing_signature) == 1)
                )
            else:
                text_detected_caption = None
                text_detected_signature = None

            db.update_asset_text_flags(
                connection,
                asset_id,
                text_detected_ocr=text_detected_ocr,
                text_detected_vision=text_detected_vision,
                text_detected_caption=text_detected_caption,
                text_detected_signature=text_detected_signature,
            )
            stats["flagged"] += 1
            pending += 1
            if pending >= commit_every:
                connection.commit()
                pending = 0
        if pending:
            connection.commit()
    return stats

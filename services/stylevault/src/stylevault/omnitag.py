from __future__ import annotations

from dataclasses import dataclass
import importlib.util
import logging
from pathlib import Path
import shutil
import subprocess

import numpy as np
from PIL import Image

from stylevault.captions import CaptionModel, UnavailableCaptionModel
from stylevault.devices import pick_device
from stylevault.model_cache import get_hf_load_kwargs

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class OmniTagSettings:
    output_path: Path
    trigger_word: str = "ohwx"
    llm_instruction: str = "Describe the scene with clinical, objective detail."
    target_resolution: int = 768
    video_segment_seconds: float = 5.0
    segment_skip: int = 10
    video_max_segments: int = 3
    target_fps: int = 24
    include_audio_in_video: bool = True
    blur_threshold: float = 90.0


@dataclass(frozen=True)
class OmniTagStats:
    images_captioned: int = 0
    videos_processed: int = 0
    clips_exported: int = 0
    frames_exported: int = 0
    blurry_frames_skipped: int = 0


FALLBACK_MODEL_ID = "Qwen/Qwen3-VL-4B-Instruct"  # ungated stock checkpoint


def _load_candidates(model_id: str, hf_kwargs: dict[str, object]) -> list[tuple[str, dict[str, object]]]:
    """Configured model (configured cache), then the stock checkpoint, already-downloaded only,
    from the configured cache or the default Hugging Face cache. The fallback never downloads."""
    candidates: list[tuple[str, dict[str, object]]] = [(model_id, dict(hf_kwargs))]
    if model_id != FALLBACK_MODEL_ID:
        candidates.append((FALLBACK_MODEL_ID, {**hf_kwargs, "local_files_only": True}))
        default_hub = Path.home() / ".cache" / "huggingface" / "hub"
        if Path(str(hf_kwargs.get("cache_dir", ""))) != default_hub:
            candidates.append((FALLBACK_MODEL_ID, {"cache_dir": default_hub, "local_files_only": True}))
    return candidates


class QwenOmniTagCaptionModel(CaptionModel):
    def __init__(self, model_id: str) -> None:
        super().__init__(name="omnitag-qwen3", version=model_id, description="Qwen3-VL OmniTag captioner")
        self._model_id = model_id
        self._model = None
        self._processor = None
        self._device = None
        self._loaded_id: str | None = None
        # Batch tagging samples for variety; the interactive API sets this False (greedy) since
        # bf16 sampling occasionally emits stray CJK tokens mid-sentence.
        self.do_sample = True

    def _load(self) -> None:
        if self._model is not None:
            return
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor

        self._device = pick_device(torch)
        dtype = torch.bfloat16 if self._device.type in {"cuda", "mps"} else torch.float32
        errors: list[str] = []
        for model_id, hf_kwargs in _load_candidates(self._model_id, get_hf_load_kwargs()):
            try:
                processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=False, **hf_kwargs)
                # Auto class: the default checkpoints are Qwen3-VL; older configs may name Qwen2.5-VL.
                model = AutoModelForImageTextToText.from_pretrained(
                    model_id, trust_remote_code=False, dtype=dtype, **hf_kwargs
                )
            except (OSError, ValueError) as exc:  # gated / not cached / unknown architecture
                errors.append(f"{model_id}: {str(exc).splitlines()[0]}")
                continue
            if model_id != self._model_id:
                LOGGER.warning("OmniTag: %s unavailable, captioning with %s", self._model_id, model_id)
            self._processor = processor
            self._model = model.to(self._device)
            self._model.eval()
            self._loaded_id = model_id
            return
        raise RuntimeError("No OmniTag caption model could be loaded: " + "; ".join(errors))

    def generate(self, image: Image.Image, source_path: Path, prompt: str | None = None) -> str:
        self._load()
        if self._model is None or self._processor is None or self._device is None:
            raise RuntimeError("Qwen OmniTag model failed to initialize")
        import torch

        instruction = prompt or "Describe the image in detail."
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": instruction},
                ],
            }
        ]
        text_in = self._processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = self._processor(text=[text_in], images=[image], return_tensors="pt", padding=True).to(self._device)
        with torch.inference_mode():
            sampling = {"do_sample": True, "temperature": 0.7, "top_p": 0.9} if self.do_sample else {"do_sample": False}
            generated = self._model.generate(**inputs, max_new_tokens=512, **sampling)
        trimmed = [output[len(input_ids) :] for input_ids, output in zip(inputs.input_ids, generated, strict=False)]
        caption = self._processor.batch_decode(trimmed, skip_special_tokens=True)[0].strip()
        return caption or source_path.stem


class FilenameOmniTagCaptionModel(CaptionModel):
    def __init__(self) -> None:
        super().__init__(name="omnitag-filename", version="v1", description="Fallback OmniTag caption model")

    def generate(self, image: Image.Image, source_path: Path, prompt: str | None = None) -> str:
        return source_path.stem.replace("_", " ").replace("-", " ").strip() or "untitled"


def _module_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def get_omnitag_model(model_id: str) -> CaptionModel:
    if _module_available("torch") and _module_available("transformers"):
        return QwenOmniTagCaptionModel(model_id)
    return UnavailableCaptionModel(
        name="omnitag-qwen3",
        version=model_id,
        description="Qwen3 OmniTag captioning",
        detail="OmniTag Qwen model requires torch+transformers. Install dependencies or use --model filename.",
    )


def _ensure_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is required for OmniTag video workflows.")


def _ensure_cv2():
    if not _module_available("cv2"):
        raise RuntimeError("opencv-python is required for OmniTag video workflows.")
    import cv2

    return cv2


def _smart_resize(frame: np.ndarray, target_resolution: int, cv2_module) -> np.ndarray:
    height, width = frame.shape[:2]
    scale = target_resolution / max(height, width)
    new_w, new_h = max(1, int(width * scale)), max(1, int(height * scale))
    return cv2_module.resize(frame, (new_w, new_h), interpolation=cv2_module.INTER_LANCZOS4)


def _blur_score(frame: np.ndarray, cv2_module) -> float:
    gray = cv2_module.cvtColor(frame, cv2_module.COLOR_BGR2GRAY)
    laplacian = cv2_module.Laplacian(gray, cv2_module.CV_64F)
    return float(laplacian.var())


def _caption_text(caption: str, trigger_word: str) -> str:
    cleaned = caption.strip()
    if not cleaned.lower().startswith(trigger_word.lower()):
        cleaned = f"{trigger_word}, {cleaned}" if cleaned else trigger_word
    return cleaned


def _write_caption(path: Path, caption: str) -> None:
    path.write_text(caption + "\n", encoding="utf-8")


def _collect_batch_files(input_path: Path) -> tuple[list[Path], list[Path]]:
    images: list[Path] = []
    videos: list[Path] = []
    for candidate in sorted(input_path.iterdir()):
        if not candidate.is_file():
            continue
        suffix = candidate.suffix.lower()
        if suffix in IMAGE_EXTENSIONS:
            images.append(candidate)
        elif suffix in VIDEO_EXTENSIONS:
            videos.append(candidate)
    return images, videos


def _export_video_clip(source: Path, output_path: Path, start_seconds: float, duration_seconds: float, target_fps: int, include_audio: bool) -> None:
    command = [
        "ffmpeg",
        "-y",
        "-ss",
        f"{start_seconds:.3f}",
        "-t",
        f"{duration_seconds:.3f}",
        "-i",
        str(source),
        "-vf",
        f"fps={target_fps}",
        "-pix_fmt",
        "yuv420p",
    ]
    if not include_audio:
        command.append("-an")
    else:
        command.extend(["-c:a", "aac"])
    command.extend(["-c:v", "libx264", str(output_path)])
    subprocess.run(command, check=True, capture_output=True)




def run_omnitag_mode(
    mode: str,
    input_path: Path,
    settings: OmniTagSettings,
    model: CaptionModel,
    caption_video_targets: str,
) -> OmniTagStats:
    _ensure_ffmpeg()
    cv2 = _ensure_cv2()
    settings.output_path.mkdir(parents=True, exist_ok=True)
    instruction = f"{settings.llm_instruction}\n\nStart the response with: {settings.trigger_word}"

    stats = OmniTagStats()

    def process_image(image_path: Path, prefix: str = "") -> OmniTagStats:
        with Image.open(image_path) as image:
            caption = model.generate(image.convert("RGB"), image_path, prompt=instruction)
        caption = _caption_text(caption, settings.trigger_word)
        base_name = f"{prefix}{image_path.stem}" if prefix else image_path.stem
        _write_caption(settings.output_path / f"{base_name}.txt", caption)
        return OmniTagStats(images_captioned=1)

    def process_video(video_path: Path) -> OmniTagStats:
        capture = cv2.VideoCapture(str(video_path))
        if not capture.isOpened():
            LOGGER.warning("Skipping unreadable video: %s", video_path)
            return OmniTagStats()
        fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
        frames_per_segment = max(1, int(fps * settings.video_segment_seconds))
        local = OmniTagStats(videos_processed=1)

        for segment_index in range(settings.video_max_segments):
            seek_frame = segment_index * frames_per_segment * settings.segment_skip
            capture.set(cv2.CAP_PROP_POS_FRAMES, seek_frame)
            frames = []
            for _ in range(frames_per_segment):
                ok, frame = capture.read()
                if not ok:
                    break
                frames.append(_smart_resize(frame, settings.target_resolution, cv2))
            if not frames:
                break
            mid_frame = frames[len(frames) // 2]
            blur = _blur_score(mid_frame, cv2)
            if blur < settings.blur_threshold:
                local = OmniTagStats(
                    images_captioned=local.images_captioned,
                    videos_processed=local.videos_processed,
                    clips_exported=local.clips_exported,
                    frames_exported=local.frames_exported,
                    blurry_frames_skipped=local.blurry_frames_skipped + 1,
                )
                continue

            rgb_frame = cv2.cvtColor(mid_frame, cv2.COLOR_BGR2RGB)
            pil_frame = Image.fromarray(rgb_frame)
            caption = model.generate(pil_frame, video_path, prompt=instruction)
            caption = _caption_text(caption, settings.trigger_word)
            stem = f"{video_path.stem}_seg_{segment_index:04d}"

            if caption_video_targets in {"clips", "both"}:
                start_seconds = seek_frame / fps
                clip_path = settings.output_path / f"{stem}.mp4"
                _export_video_clip(
                    source=video_path,
                    output_path=clip_path,
                    start_seconds=start_seconds,
                    duration_seconds=settings.video_segment_seconds,
                    target_fps=settings.target_fps,
                    include_audio=settings.include_audio_in_video,
                )
                local = OmniTagStats(
                    images_captioned=local.images_captioned,
                    videos_processed=local.videos_processed,
                    clips_exported=local.clips_exported + 1,
                    frames_exported=local.frames_exported,
                    blurry_frames_skipped=local.blurry_frames_skipped,
                )
            if caption_video_targets in {"frames", "both"}:
                frame_path = settings.output_path / f"{stem}.png"
                pil_frame.save(frame_path)
                local = OmniTagStats(
                    images_captioned=local.images_captioned,
                    videos_processed=local.videos_processed,
                    clips_exported=local.clips_exported,
                    frames_exported=local.frames_exported + 1,
                    blurry_frames_skipped=local.blurry_frames_skipped,
                )
            _write_caption(settings.output_path / f"{stem}.txt", caption)
        capture.release()
        return local

    image_inputs: list[Path] = []
    video_inputs: list[Path] = []

    if mode == "batch-folder":
        image_inputs, video_inputs = _collect_batch_files(input_path)
    elif mode == "single-video":
        video_inputs = [input_path]
    elif mode == "images":
        image_inputs = [input_path]

    for image_path in image_inputs:
        current = process_image(image_path)
        stats = OmniTagStats(
            images_captioned=stats.images_captioned + current.images_captioned,
            videos_processed=stats.videos_processed,
            clips_exported=stats.clips_exported,
            frames_exported=stats.frames_exported,
            blurry_frames_skipped=stats.blurry_frames_skipped,
        )

    for video_path in video_inputs:
        current = process_video(video_path)
        stats = OmniTagStats(
            images_captioned=stats.images_captioned + current.images_captioned,
            videos_processed=stats.videos_processed + current.videos_processed,
            clips_exported=stats.clips_exported + current.clips_exported,
            frames_exported=stats.frames_exported + current.frames_exported,
            blurry_frames_skipped=stats.blurry_frames_skipped + current.blurry_frames_skipped,
        )

    return stats

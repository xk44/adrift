"""Local node: pass-through that writes each relay window's decoded frames to an mp4 preview.

Wire it between VAEDecode and H3RelayAppendWindow so it runs once per loop iteration; frames are
returned unchanged. Files: output/<prefix>_w<NN>_<HHMMSS>.mp4 (counter per prefix, resets per server start)."""
import itertools
import logging
import os
import time
from fractions import Fraction

import av
from av.video.reformatter import ColorPrimaries, ColorRange, Colorspace, ColorTrc
import numpy as np
import folder_paths

_COUNTERS = {}  # per filename_prefix, so each run numbers its windows from 01


def write_mp4(frames, fps, path, crf=18):
    arr = (frames.clamp(0, 1).mul(255).round().to("cpu").numpy()).astype(np.uint8)
    n, h, w, _ = arr.shape
    w2, h2 = w - w % 2, h - h % 2
    with av.open(path, "w") as c:
        s = c.add_stream("libx264", rate=Fraction(float(fps)).limit_denominator(1001))
        s.width, s.height, s.pix_fmt = w2, h2, "yuv420p"
        s.options = {"crf": str(crf)}
        # BT.709 matrix + tags (PyAV's default rgb->yuv is BT.601, untagged; browsers read that as 709).
        cc = s.codec_context
        cc.colorspace, cc.color_primaries, cc.color_trc = Colorspace.ITU709, ColorPrimaries.BT709, ColorTrc.BT709
        cc.color_range = ColorRange.MPEG
        for i in range(n):
            f = av.VideoFrame.from_ndarray(arr[i, :h2, :w2], format="rgb24").reformat(
                format="yuv420p", dst_colorspace=Colorspace.ITU709, dst_color_range=ColorRange.MPEG)
            for p in s.encode(f):
                c.mux(p)
        for p in s.encode():
            c.mux(p)
    return n


class CJWindowPreview:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"frames": ("IMAGE",),
                             "fps": ("FLOAT", {"default": 30.0, "min": 1.0, "max": 240.0, "forceInput": True}),
                             "filename_prefix": ("STRING", {"default": "h3-relay/window-preview"})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = "image/video"

    def run(self, frames, fps, filename_prefix):
        idx = next(_COUNTERS.setdefault(filename_prefix, itertools.count(1)))
        path = os.path.join(folder_paths.get_output_directory(), f"{filename_prefix}_w{idx:02d}_{time.strftime('%H%M%S')}.mp4")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            n = write_mp4(frames, fps, path)
            logging.info("CJWindowPreview: wrote %s (%d frames)", path, n)
        except Exception:  # preview must never kill the render
            logging.exception("CJWindowPreview: failed to write %s", path)
        return (frames,)


NODE_CLASS_MAPPINGS = {"CJWindowPreview": CJWindowPreview}
NODE_DISPLAY_NAME_MAPPINGS = {"CJWindowPreview": "Save Window Preview (pass-through)"}

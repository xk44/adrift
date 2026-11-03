"""CJSampleFrames / CJFindSubjectFrame: find the frame of a clip to start tracking a subject from.

A tracker seeded on frame 0 fails when the subject walks in later. SAM 3.1 runs on an evenly spaced
sample of the clip instead, and the seed is the earliest sampled frame with a confident detection
that is no longer growing fast, so not a sliver of someone still entering the frame. SAM scores a
blank background around 0.55-0.67, hence the floor. A subject visible only between two samples is
missed.
"""
import torch

MIN_FRAME_AREA = 0.002    # share of the frame: below this a detection is a speck
MIN_SCORE = 0.7           # below this SAM 3.1 also "finds" people in an empty gradient
MIN_SCORE_RATIO = 0.8     # of the best detection score in the clip
ENTERING_GROWTH = 1.5     # area ratio to the next sample: above this they are still coming in


def sample_step(length, samples):
    """Stride that takes at most `samples` frames, starting at frame 0."""
    return max(1, -(-length // max(1, samples)))


def find_subject_frame(masks, bboxes, step):
    """(N, H, W) masks of every detection + per-frame box lists -> ((1, H, W) mask, source frame index)."""
    counts = [len(frame) for frame in bboxes]
    if sum(counts) != masks.shape[0]:
        raise ValueError(f"{masks.shape[0]} masks for {sum(counts)} detections")
    if not masks.shape[0]:
        raise ValueError("Subject not found in the clip. Try describing them differently.")
    frame_area = float(masks.shape[-2] * masks.shape[-1])
    best = []                 # (sampled frame, mask index, area, score): the largest detection per frame
    at = 0
    for i, frame in enumerate(bboxes):
        if frame:
            areas = [float((masks[at + j] > 0.5).sum()) for j in range(len(frame))]
            j = max(range(len(frame)), key=areas.__getitem__)
            best.append((i, at + j, areas[j], float(frame[j].get("score", 1.0))))
        at += len(frame)
    top_score = max(b[3] for b in best)
    good = [b for b in best if b[3] >= max(MIN_SCORE, MIN_SCORE_RATIO * top_score) and b[2] >= MIN_FRAME_AREA * frame_area]
    if not good:
        raise ValueError("Subject not found in the clip. Try describing them differently.")
    area_of = {b[0]: b[2] for b in best}
    for i, m, area, _ in good:
        if area_of.get(i + 1, 0.0) <= ENTERING_GROWTH * area:
            return masks[m].unsqueeze(0), i * step
    i, m, _, _ = good[-1]
    return masks[m].unsqueeze(0), i * step


class CJSampleFrames:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "samples": ("INT", {"default": 32, "min": 1, "max": 256, "tooltip": "Most frames to look at, evenly spaced from frame 0."}),
        }}

    RETURN_TYPES = ("IMAGE", "INT")
    RETURN_NAMES = ("images", "step")
    FUNCTION = "run"
    CATEGORY = "cj/h3"

    def run(self, images, samples):
        step = sample_step(images.shape[0], samples)
        return (images[::step], step)


class CJFindSubjectFrame:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "masks": ("MASK",),
            "bboxes": ("BOUNDING_BOX", {"forceInput": True}),
            "step": ("INT", {"default": 1, "min": 1, "max": 100000, "forceInput": True}),
        }}

    RETURN_TYPES = ("MASK", "INT")
    RETURN_NAMES = ("mask", "frame_index")
    FUNCTION = "run"
    CATEGORY = "cj/h3"

    def run(self, masks, bboxes, step):
        return find_subject_frame(masks, bboxes, step)


NODE_CLASS_MAPPINGS = {"CJSampleFrames": CJSampleFrames, "CJFindSubjectFrame": CJFindSubjectFrame}
NODE_DISPLAY_NAME_MAPPINGS = {
    "CJSampleFrames": "Sample frames (evenly spaced)",
    "CJFindSubjectFrame": "Find subject frame",
}

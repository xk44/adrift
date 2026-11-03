"""Frame choice for cj_subject_frame on synthetic detections. Run: python tests/test_subject_frame.py"""
import importlib.util
import os

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("cj_subject_frame", os.path.join(HERE, "..", "cj_subject_frame.py"))
X = importlib.util.module_from_spec(spec)
spec.loader.exec_module(X)
H, W = 100, 100


def det(frames):
    """frames: per sampled frame, a list of (side in pixels, score)."""
    masks, boxes = [], []
    for frame in frames:
        row = []
        for side, score in frame:
            m = torch.zeros(H, W)
            m[:side, :side] = 1
            masks.append(m)
            row.append({"score": score})
        boxes.append(row)
    return (torch.stack(masks) if masks else torch.zeros(0, H, W)), boxes


def pick(frames, step=5):
    m, b = det(frames)
    return X.find_subject_frame(m, b, step)


def raises(frames):
    try:
        pick(frames)
    except ValueError as e:
        assert "not found" in str(e)
        return
    raise AssertionError("expected not found")


def main():
    assert X.sample_step(100, 32) == 4 and X.sample_step(10, 32) == 1 and X.sample_step(96, 32) == 3
    assert pick([[(40, .9)], [(40, .9)]])[1] == 0                         # already there
    assert pick([[], [], [(40, .9)], [(40, .9)]])[1] == 10                # walks in
    assert pick([[(5, .9)], [(10, .9)], [(40, .9)]])[1] == 10             # sliver at the edge is skipped
    assert pick([[(12, .9)], [(12, .9)], [(60, .98)]])[1] == 0            # a later close-up does not move the seed
    assert pick([[(40, .4)], [(40, .9)]])[1] == 5                         # stray low score is skipped
    assert pick([[(90, .5)], [(20, .9)]])[1] == 5                         # big low-score miss does not set the size
    m, _ = pick([[], [(10, .9), (40, .9)]])
    assert m.shape == (1, H, W) and m.sum() == 1600                       # largest detection in that frame
    raises([[], [], []])
    raises([[(2, .9)]])                                                   # speck
    raises([[(98, .66)], [(98, .67)]])                                    # SAM on an empty background
    try:
        X.find_subject_frame(torch.zeros(2, H, W), [[{"score": 1}]], 1)
    except ValueError as e:
        assert "masks for" in str(e)
    else:
        raise AssertionError("expected a count mismatch")
    print("PASS")


if __name__ == "__main__":
    main()

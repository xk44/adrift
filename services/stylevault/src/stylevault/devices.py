"""Torch device selection (cuda > mps > cpu)."""

from __future__ import annotations


def pick_device(torch: object) -> object:
    """Return the best available torch.device: CUDA, then Apple MPS, else CPU."""
    if torch.cuda.is_available():
        return torch.device("cuda")
    mps = getattr(getattr(torch, "backends", None), "mps", None)
    if mps is not None and mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")

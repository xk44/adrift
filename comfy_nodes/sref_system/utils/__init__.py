"""
SREF System Utilities
=====================
Common utility functions for the SREF system.
"""

import hashlib
import torch
from typing import Union


def compute_tensor_hash(tensor: torch.Tensor, prefix: str = "") -> str:
    """
    Compute a stable hash of a tensor for caching purposes.
    
    Args:
        tensor: Input tensor to hash
        prefix: Optional prefix for the hash
        
    Returns:
        16-character hexadecimal hash string
    """
    # Hash raw bytes via a uint8 view: numpy has no bfloat16/fp8, so
    # .numpy() would raise on those dtypes. Byte-identical for numpy dtypes.
    flat = tensor.detach().cpu().contiguous().reshape(-1)
    data = flat.view(torch.uint8).numpy().tobytes() if flat.numel() else b""
    hash_obj = hashlib.sha256()
    if prefix:
        hash_obj.update(prefix.encode())
    hash_obj.update(data)
    return hash_obj.hexdigest()[:16]


def clamp(value: Union[int, float], min_val: Union[int, float], max_val: Union[int, float]) -> Union[int, float]:
    """
    Clamp a value between min and max.
    """
    return max(min_val, min(value, max_val))


__all__ = [
    "compute_tensor_hash",
    "clamp",
]

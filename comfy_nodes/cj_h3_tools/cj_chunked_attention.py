"""Local node: exact query-chunked SDPA for MPS.

PyTorch SDPA on MPS materializes the full (heads x Nq x Nk) score matrix; H3 relay windows
(~46k tokens) need ~162 GiB and fail with "Invalid buffer size". Softmax is per query row, so
splitting along the query dim is mathematically exact and keeps the fused kernel per slab.
"""
import logging
import torch
import comfy.ldm.modules.attention as A

_TARGET_BYTES = 3 * 2**30

_FAST = {}
try:  # comfy-kitchen native kernels (no build needed): INT8 sage-style attention + Sol-Attn sparse
    import comfy_kitchen as _ck
    _FAST["ck_int8"] = _ck.int8_attention
    if hasattr(_ck, "sol_attn"):
        _FAST["sol"] = _ck.sol_attn
except Exception as e:
    logging.warning("CJChunkedAttention: comfy_kitchen attention unavailable (%s)", e)
_SOL_TAU = 1.0
_SEEN = set()  # log each distinct (path, q, k, mask) once


def _probe(path, q, k, mask):
    key = (path, tuple(q.shape), tuple(k.shape), None if mask is None else tuple(mask.shape))
    if key not in _SEEN:
        _SEEN.add(key)
        logging.info("CJChunkedAttention probe: path=%s q=%s k=%s mask=%s dtype=%s", *key[:3],
                     key[3], q.dtype)
try:
    from sageattention import sageattn as _sageattn
    _FAST["sage"] = _sageattn
except Exception as e:  # not built yet -> sdpa fallback
    logging.warning("CJChunkedAttention: sageattention unavailable (%s); sage mode -> sdpa", e)
try:
    from flash_attn import flash_attn_func as _flash
    _FAST["flash"] = _flash
except Exception as e:
    logging.warning("CJChunkedAttention: flash_attn unavailable (%s); flash mode -> sdpa", e)


def _matmul_attn(q, k, v, chunk, scale):
    """Chunked softmax(QK^T)V via fp16 matmuls: ~4x faster than MPS SDPA (math path) at H3 sizes.
    Scores live in fp16 (10-bit mantissa) -- bf16 scores were 4x less accurate; mean abs err vs fp32 ~2.5e-3."""
    dt = q.dtype
    qh = (q * scale).half()
    kt = k.half().transpose(-1, -2)
    vh = v.half()
    nq = q.shape[2]
    outs = [torch.matmul(torch.matmul(qh[:, :, i:i + chunk], kt).softmax(-1), vh) for i in range(0, nq, chunk)]
    return torch.cat(outs, 2).to(dt)


def _make(target_bytes, mode="fp16_matmul", tau=None):
    tau = _SOL_TAU if tau is None else float(tau)
    def attention_chunked_sdpa(q, k, v, heads, mask=None, attn_precision=None, skip_reshape=False, skip_output_reshape=False, **kwargs):
        if mask is not None:
            _probe("sub_quad(mask)", q, k, mask)
            return A.attention_sub_quad(q, k, v, heads, mask=mask, attn_precision=attn_precision, skip_reshape=skip_reshape,
                                        skip_output_reshape=skip_output_reshape, **kwargs)
        if skip_reshape:
            b, _, nq, dim_head = q.shape
        else:
            b, nq, dim_head = q.shape
            dim_head //= heads
            q, k, v = A._reshape_qkv_to_heads(q, k, v, b, heads, dim_head, kwargs.get("enable_gqa", False), expand_kv=False)
            q, k, v = map(lambda t: t.transpose(1, 2), (q, k, v))
        nk = k.shape[2]
        per_row = b * q.shape[1] * nk * 4  # fp32-sized score row, conservative
        chunk = max(256, min(nq, target_bytes // max(per_row, 1)))
        sdpa_extra = {kk: vv for kk, vv in kwargs.items() if kk in ("scale", "enable_gqa")}
        _probe(mode if (mode in _FAST or mode in ("sdpa", "fp16_matmul")) else "sdpa(fallback)", q, k, None)
        if (q.is_cuda and mode == "sol" and "sol" in _FAST and q.dtype in (torch.float16, torch.bfloat16)
                and dim_head == 128 and q.shape == k.shape == v.shape):
            out = _FAST["sol"](q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2), tau=tau,
                               scale=kwargs.get("scale")).transpose(1, 2)
        elif q.is_cuda and mode == "ck_int8" and "ck_int8" in _FAST and q.dtype in (torch.float16, torch.bfloat16):
            out = _FAST["ck_int8"](q, k, v, scale=kwargs.get("scale"), attn_mask=None)
        elif q.is_cuda and mode in ("sage", "flash") and mode in _FAST and q.dtype in (torch.float16, torch.bfloat16):
            # Speed path: SageAttention2 (INT8 QK / FP8 PV on Ada) or flash-attn 2.
            if mode == "sage":
                out = _FAST["sage"](q, k, v, tensor_layout="HND", is_causal=False, sm_scale=kwargs.get("scale"))
            else:
                out = _FAST["flash"](q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2),
                                     softmax_scale=kwargs.get("scale")).transpose(1, 2)
        elif q.is_cuda and mode in ("sdpa", "sage", "flash", "ck_int8", "sol"):
            # CUDA flash/mem-efficient SDPA is O(n) memory: one direct call, no chunking and no
            # sdpa_kernel() context (segfaulted in _cur_sdpa_kernel_backends on torch 2.11/py3.14).
            out = torch.nn.functional.scaled_dot_product_attention(q, k, v, attn_mask=None, dropout_p=0.0, is_causal=False, **sdpa_extra)
        elif mode == "fp16_matmul" and k.shape[1] == q.shape[1]:
            out = _matmul_attn(q, k, v, chunk, kwargs.get("scale") or dim_head ** -0.5)
        elif chunk >= nq:
            out = A.comfy.ops.scaled_dot_product_attention(q, k, v, attn_mask=None, dropout_p=0.0, is_causal=False, **sdpa_extra)
        else:
            out = torch.cat([A.comfy.ops.scaled_dot_product_attention(
                q[:, :, i:i + chunk], k, v, attn_mask=None, dropout_p=0.0, is_causal=False, **sdpa_extra)
                for i in range(0, nq, chunk)], 2)
        if not skip_output_reshape:
            out = out.transpose(1, 2).reshape(b, -1, heads * dim_head)
        return out
    return attention_chunked_sdpa


class CJChunkedAttention:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",),
                             "slab_gib": ("FLOAT", {"default": 3.0, "min": 0.25, "max": 32.0, "step": 0.25})},
                "optional": {"mode": (["fp16_matmul", "sdpa", "sage", "flash", "ck_int8", "sol"], {"default": "fp16_matmul"}),
                             "sol_tau": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.05})}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "model/patch"

    def patch(self, model, slab_gib, mode="fp16_matmul", sol_tau=1.0):
        m = model.clone()
        m.set_model_optimized_attention(_make(int(slab_gib * 2**30), mode, sol_tau))
        if mode in ("sage", "flash", "ck_int8", "sol") and mode not in _FAST:
            logging.warning("CJChunkedAttention: %s requested but not installed -> sdpa", mode)
        logging.info("CJChunkedAttention: query-chunked %s, slab %.2f GiB, sol_tau %.2f", mode, slab_gib, sol_tau)
        return (m,)


NODE_CLASS_MAPPINGS = {"CJChunkedAttention": CJChunkedAttention}
NODE_DISPLAY_NAME_MAPPINGS = {"CJChunkedAttention": "Chunked SDPA Attention (MPS)"}

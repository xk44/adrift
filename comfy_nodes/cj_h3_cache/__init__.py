"""Conservative first-block cache for ComfyUI's native MiniMax H3 model."""

from dataclasses import dataclass, field
from typing import Any

import torch

import comfy.patcher_extension


WRAPPER_KEY = "cj_minimax_h3_timestep_cache"


def _latent_signature(value):
    if isinstance(value, (list, tuple)):
        return tuple(_latent_signature(item) for item in value)
    if not torch.is_tensor(value):
        return None
    return (tuple(value.shape), str(value.dtype), str(value.device))


def _step_position(transformer_options):
    sigma = transformer_options.get("sigmas")
    sample_sigmas = transformer_options.get("sample_sigmas")
    if not torch.is_tensor(sigma) or sigma.numel() == 0:
        return 0, 0.0, False
    if not torch.is_tensor(sample_sigmas) or sample_sigmas.numel() < 2:
        return 0, 0.0, True

    current = sigma.detach().flatten()[0].to(dtype=torch.float32)
    schedule = sample_sigmas.detach().flatten().to(dtype=torch.float32)
    index = int(torch.argmin((schedule - current).abs()).item())
    last = max(1, int(schedule.numel()) - 1)
    first_tolerance = float(schedule[0].abs().item()) * 1e-5 + 1e-7
    is_first = float((current - schedule[0]).abs().item()) <= first_tolerance
    return index, 100.0 * index / last, is_first


def _relative_l1(current, reference):
    if current.shape != reference.shape:
        return float("inf")
    numerator = (current - reference).abs().mean(dtype=torch.float32)
    denominator = reference.abs().mean(dtype=torch.float32).clamp_min(1e-6)
    return float((numerator / denominator).item())


@dataclass
class _CacheState:
    threshold: float
    start_percent: float
    end_percent: float
    max_consecutive_skips: int
    num_blocks: int
    run_key: Any = None
    step_index: int = 0
    progress: float = 0.0
    is_first_sigma: bool = False
    saw_nonfirst_sigma: bool = False
    skip_active: bool = False
    consecutive_skips: int = 0
    calls: int = 0
    full_calls: int = 0
    cache_hits: int = 0
    summary_printed: bool = False
    rel_l1_values: list[float] = field(default_factory=list)
    anchor_input: Any = None
    anchor_first_residual: Any = None
    remaining_residual: Any = None
    pending_input: Any = None
    pending_first_output: Any = None
    pending_first_residual: Any = None

    def clear_tensors(self):
        self.anchor_input = None
        self.anchor_first_residual = None
        self.remaining_residual = None
        self.pending_input = None
        self.pending_first_output = None
        self.pending_first_residual = None
        self.skip_active = False
        self.consecutive_skips = 0

    def print_summary(self):
        if self.summary_printed or self.calls == 0:
            return
        rel_text = "n/a"
        if self.rel_l1_values:
            rel_text = f"{min(self.rel_l1_values):.5f}..{max(self.rel_l1_values):.5f}"
        print(
            f"[CJ H3 Cache] summary calls={self.calls} full={self.full_calls} "
            f"hits={self.cache_hits} rel_l1={rel_text}",
            flush=True,
        )
        self.summary_printed = True

    def reset(self, run_key):
        self.print_summary()
        self.clear_tensors()
        self.run_key = run_key
        self.step_index = 0
        self.progress = 0.0
        self.is_first_sigma = False
        self.saw_nonfirst_sigma = False
        self.calls = 0
        self.full_calls = 0
        self.cache_hits = 0
        self.summary_printed = False
        self.rel_l1_values.clear()

    @property
    def cache_window(self):
        return self.start_percent <= self.progress < self.end_percent


def _is_minimax_h3(diffusion_model, num_blocks):
    return (
        hasattr(diffusion_model, "video_patch_proj")
        and hasattr(diffusion_model, "audio_patch_proj")
        and hasattr(diffusion_model, "blocks")
        and len(diffusion_model.blocks) == num_blocks
    )


def _call_block(previous_patch, args, extra_options):
    if previous_patch is not None:
        return previous_patch(args, extra_options)
    return extra_options["original_block"](args)


def _make_block_wrapper(state, block_index, previous_patch):
    def block_wrapper(args, extra_options):
        if state.threshold <= 0.0:
            return _call_block(previous_patch, args, extra_options)

        if block_index > 0 and state.skip_active:
            return {"img": args["img"]}

        if block_index > 0:
            out = _call_block(previous_patch, args, extra_options)
            if block_index == state.num_blocks - 1 and state.pending_first_output is not None:
                state.anchor_input = state.pending_input
                state.anchor_first_residual = state.pending_first_residual
                state.remaining_residual = out["img"].detach() - state.pending_first_output
                state.pending_input = None
                state.pending_first_output = None
                state.pending_first_residual = None
            return out

        state.skip_active = False
        state.calls += 1

        if state.progress >= state.end_percent:
            state.clear_tensors()
            state.full_calls += 1
            return _call_block(previous_patch, args, extra_options)

        block_input = args["img"].detach().clone()
        out = _call_block(previous_patch, args, extra_options)
        first_output = out["img"]
        first_residual = first_output.detach() - block_input

        input_rel = float("inf")
        first_rel = float("inf")
        anchors_ready = (
            state.anchor_input is not None
            and state.anchor_first_residual is not None
            and state.remaining_residual is not None
        )
        if state.cache_window and anchors_ready:
            input_rel = _relative_l1(block_input, state.anchor_input)
            first_rel = _relative_l1(first_residual, state.anchor_first_residual)
            rel_l1 = max(input_rel, first_rel)
            state.rel_l1_values.append(rel_l1)
            can_skip = (
                rel_l1 < state.threshold
                and state.consecutive_skips < state.max_consecutive_skips
                and state.remaining_residual.shape == first_output.shape
            )
            if can_skip:
                first_output.add_(state.remaining_residual)
                state.skip_active = True
                state.consecutive_skips += 1
                state.cache_hits += 1
                print(
                    f"[CJ H3 Cache] step={state.step_index} progress={state.progress:.1f}% "
                    f"rel_l1={rel_l1:.5f} input={input_rel:.5f} first={first_rel:.5f} hit",
                    flush=True,
                )
                return out

            print(
                f"[CJ H3 Cache] step={state.step_index} progress={state.progress:.1f}% "
                f"rel_l1={rel_l1:.5f} input={input_rel:.5f} first={first_rel:.5f} full",
                flush=True,
            )

        state.consecutive_skips = 0
        state.full_calls += 1
        state.pending_input = block_input
        state.pending_first_output = first_output.detach().clone()
        state.pending_first_residual = first_residual
        return out

    return block_wrapper


def _make_diffusion_wrapper(state):
    def diffusion_wrapper(
        executor,
        x,
        timestep,
        context,
        transformer_options=None,
        minimax_payload=None,
        **kwargs,
    ):
        transformer_options = transformer_options or {}
        diffusion_model = executor.class_obj
        if not _is_minimax_h3(diffusion_model, state.num_blocks):
            raise TypeError("MiniMaxH3TimestepCache requires the native MiniMax H3 diffusion model")
        if state.threshold <= 0.0:
            return executor(
                x,
                timestep,
                context,
                transformer_options=transformer_options,
                minimax_payload=minimax_payload,
                **kwargs,
            )

        payload = minimax_payload if isinstance(minimax_payload, dict) else {}
        conditioning_ids = tuple(str(item) for item in transformer_options.get("uuids", ()))
        run_key = (
            int(payload.get("seed", 0)),
            conditioning_ids,
            _latent_signature(x),
        )
        step_index, progress, is_first = _step_position(transformer_options)
        new_run = state.run_key != run_key or (is_first and state.saw_nonfirst_sigma)
        if new_run:
            state.reset(run_key)

        state.step_index = step_index
        state.progress = progress
        state.is_first_sigma = is_first
        if not is_first:
            state.saw_nonfirst_sigma = True

        try:
            return executor(
                x,
                timestep,
                context,
                transformer_options=transformer_options,
                minimax_payload=minimax_payload,
                **kwargs,
            )
        finally:
            state.pending_input = None
            state.pending_first_output = None
            state.pending_first_residual = None
            state.skip_active = False
            if progress >= state.end_percent:
                state.clear_tensors()
                state.print_summary()

    return diffusion_wrapper


class MiniMaxH3TimestepCache:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "rel_l1_threshold": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.005},
                ),
                "start_percent": (
                    "FLOAT",
                    {"default": 15.0, "min": 0.0, "max": 100.0, "step": 1.0},
                ),
                "end_percent": (
                    "FLOAT",
                    {"default": 80.0, "min": 0.0, "max": 100.0, "step": 1.0},
                ),
                "max_consecutive_skips": (
                    "INT",
                    {"default": 1, "min": 1, "max": 10, "step": 1},
                ),
            }
        }

    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "apply"
    CATEGORY = "Adrift/cache"

    def apply(
        self,
        model,
        rel_l1_threshold,
        start_percent,
        end_percent,
        max_consecutive_skips,
    ):
        diffusion_model = model.get_model_object("diffusion_model")
        blocks = getattr(diffusion_model, "blocks", None)
        if blocks is None or not _is_minimax_h3(diffusion_model, len(blocks)):
            raise TypeError("MiniMaxH3TimestepCache requires the native MiniMax H3 diffusion model")

        start = max(0.0, min(float(start_percent), 100.0))
        end = max(start, min(float(end_percent), 100.0))
        state = _CacheState(
            threshold=max(0.0, float(rel_l1_threshold)),
            start_percent=start,
            end_percent=end,
            max_consecutive_skips=max(1, int(max_consecutive_skips)),
            num_blocks=len(blocks),
        )

        patched = model.clone()
        existing = (
            patched.model_options.get("transformer_options", {})
            .get("patches_replace", {})
            .get("dit", {})
        )
        previous_patches = {
            ("double_block", index): existing.get(("double_block", index))
            for index in range(state.num_blocks)
        }
        for index in range(state.num_blocks):
            patched.set_model_patch_replace(
                _make_block_wrapper(state, index, previous_patches[("double_block", index)]),
                "dit",
                "double_block",
                index,
            )

        patched.remove_wrappers_with_key(
            comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL,
            WRAPPER_KEY,
        )
        patched.add_wrapper_with_key(
            comfy.patcher_extension.WrappersMP.DIFFUSION_MODEL,
            WRAPPER_KEY,
            _make_diffusion_wrapper(state),
        )
        print(
            f"[CJ H3 Cache] attached blocks={state.num_blocks} threshold={state.threshold:.5f} "
            f"window={state.start_percent:.1f}..{state.end_percent:.1f}% "
            f"max_skips={state.max_consecutive_skips}",
            flush=True,
        )
        return (patched,)


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3TimestepCache": MiniMaxH3TimestepCache,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3TimestepCache": "MiniMax H3 Timestep Cache",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

"""CJTorchCompileBlocks: torch.compile only the transformer blocks of the diffusion model.

Stock TorchCompileModel compiles the whole diffusion_model, so dynamo traces MiniMaxH3Model.forward,
which calls comfy.model_prefetch.malloc_graph_begin (comfy_aimdo dynamic-VRAM allocator) and dies on
'torch.Stream has no attribute cuda_stream'. Compiling each blocks.N leaves the prefetch/malloc loop eager.
"""
import logging

from comfy_api.torch_helpers import set_torch_compile_wrapper


class CJTorchCompileBlocks:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",),
                             "backend": (["inductor", "cudagraphs"], {"default": "inductor"}),
                             "blocks_attr": ("STRING", {"default": "blocks"}),
                             "dynamic": (["auto", "true", "false"], {"default": "auto"})}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "model/patch"

    def patch(self, model, backend, blocks_attr="blocks", dynamic="auto"):
        m = model.clone()
        dm = m.get_model_object("diffusion_model")
        n = len(getattr(dm, blocks_attr))
        keys = [f"diffusion_model.{blocks_attr}.{i}" for i in range(n)]
        dyn = {"auto": None, "true": True, "false": False}[dynamic]
        set_torch_compile_wrapper(model=m, backend=backend, dynamic=dyn, keys=keys)
        logging.info("CJTorchCompileBlocks: %d x %s.%s compiled (%s, dynamic=%s)", n, "diffusion_model", blocks_attr, backend, dynamic)
        return (m,)


NODE_CLASS_MAPPINGS = {"CJTorchCompileBlocks": CJTorchCompileBlocks}
NODE_DISPLAY_NAME_MAPPINGS = {"CJTorchCompileBlocks": "CJ torch.compile (blocks only)"}

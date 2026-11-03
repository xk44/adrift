"""Shared helpers for the CPU tests: load a node module by path and stub ComfyUI's folder_paths."""
import importlib.util
import os
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.dirname(HERE)


def load(module_file):
    spec = importlib.util.spec_from_file_location(module_file[:-3], os.path.join(PACK, module_file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fake_folder_paths():
    out = tempfile.mkdtemp(prefix="cj_image_tools_test_")
    fp = types.ModuleType("folder_paths")
    fp.get_output_directory = lambda: out

    def get_save_image_path(prefix, output_dir, w=0, h=0):
        sub, name = os.path.split(prefix)
        full = os.path.join(output_dir, sub)
        os.makedirs(full, exist_ok=True)
        return full, name, 1, sub, prefix

    fp.get_save_image_path = get_save_image_path
    sys.modules["folder_paths"] = fp
    return out

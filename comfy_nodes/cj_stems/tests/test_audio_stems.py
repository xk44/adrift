"""CPU test for cj_audio_stems (tiny random weights, no downloads).
usage: CUDA_VISIBLE_DEVICES= python -I test_audio_stems.py path/to/cj_audio_stems.py"""
import importlib.util
import os
import sys
import tempfile
import types

import torch

spec = importlib.util.spec_from_file_location("stems", sys.argv[1])
st = importlib.util.module_from_spec(spec)
spec.loader.exec_module(st)
torch.manual_seed(0)
cpu = torch.device("cpu")


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok", msg)


# --- chunk layout + blend weights
check(st.chunk_starts(100, 200, 150) == [0], "short track = one chunk")
s = st.chunk_starts(1000, 300, 225)
check(s[0] == 0 and s[-1] == 700 and all(b - a <= 225 for a, b in zip(s, s[1:])), "chunks cover the track")
w = st.blend_window(300, 75, False, False)
check(abs(float(w[0]) - 1 / 76) < 1e-6 and float(w[150]) == 1.0, "ramps at both overlaps")
check(float(st.blend_window(300, 75, True, True).min()) == 1.0, "flat window for a lone chunk")


# --- overlap-add is exact for an identity "separator"
class Identity(torch.nn.Module):
    sources = list(st.SOURCES)

    def forward(self, x):
        return x.unsqueeze(1).repeat(1, len(self.sources), 1, 1)


mix = torch.randn(2, 44100 * 3 + 17) * 0.3 + 0.05
out = st.separate(Identity(), mix, segment_seconds=0.7, overlap=0.3, device=cpu)
check(out.shape == (4, 2, mix.shape[-1]), "separate shape [S,2,T]")
check(torch.allclose(out[0], mix, atol=1e-5) and torch.allclose(out[3], mix, atol=1e-5), "chunked overlap-add reconstructs input")
check(st.separate(Identity(), torch.zeros(2, 0), device=cpu).shape == (4, 2, 0), "empty input")

# --- input conditioning
m = st.to_model_input(torch.randn(1, 22050), 22050)
check(m.shape == (2, 44100), "mono 22.05k -> stereo 44.1k")
check(st.to_model_input(torch.randn(6, 100), 44100).shape == (2, 100), ">2 channels keep first two")

# --- tiny random HDemucs through the real load path (weights_only file, custom builder)
from torchaudio.models import HDemucs


def tiny():
    return HDemucs(sources=list(st.SOURCES), channels=4, dconv_attn=99, dconv_lstm=99)


with tempfile.TemporaryDirectory() as d:
    path = os.path.join(d, "tiny.pt")
    torch.save(tiny().state_dict(), path)
    model = st.load_model(path, builder=tiny)
    check(st.load_model(path, builder=tiny) is model, "model cache hit")
    audio = {"waveform": torch.randn(2, 1, 22050 * 2) * 0.1, "sample_rate": 22050}
    stems = st.split_audio(audio, model, segment_seconds=0.5, overlap=0.25, device=cpu)
    check(len(stems) == 4, "four stems")
    for name, a in zip(st.SOURCES, stems):
        check(a["sample_rate"] == 44100 and tuple(a["waveform"].shape) == (2, 2, 88200), f"{name} [B,2,T] at 44.1k")
        check(bool(torch.isfinite(a["waveform"]).all()), f"{name} finite")
    st.unload_all()

    # --- folder registration + weights resolution (fake folder_paths)
    fp = types.SimpleNamespace(models_dir=d, folder_names_and_paths={})
    st.register_demucs_folder(fp)
    check(fp.folder_names_and_paths["demucs"][0] == [os.path.join(d, "demucs")], "registers models/demucs")
    fp.folder_names_and_paths["demucs"] = (["/mnt/x/demucs"], set())
    st.register_demucs_folder(fp)
    check(fp.folder_names_and_paths["demucs"][0] == ["/mnt/x/demucs", os.path.join(d, "demucs")], "keeps yaml path first")
    fp.get_full_path = lambda f, n: path if n == "tiny.pt" else None
    fp.get_filename_list = lambda f: ["tiny.pt"]
    check(st.resolve_weights("tiny.pt", fp) == path, "resolves via folder_paths")
    check(st.weight_choices(fp) == [st.DEFAULT_WEIGHTS, "tiny.pt"], "default weights listed first")
    try:
        st.resolve_weights("missing.pt", fp)
        raise AssertionError("missing weights should raise")
    except FileNotFoundError:
        print("ok missing weights raise (no download)")

src = open(sys.argv[1]).read()
check("get_model(" not in src and "download" not in src.split('"""')[2], "never downloads")
print("ALL OK")

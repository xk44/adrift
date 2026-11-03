from types import SimpleNamespace

from stylevault.devices import pick_device


class _T:
    def __init__(self, cuda, mps):
        self.cuda = SimpleNamespace(is_available=lambda: cuda)
        self.backends = SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps))

    def device(self, name):
        return name


def test_cuda_preferred():
    assert pick_device(_T(True, True)) == "cuda"


def test_mps_fallback():
    assert pick_device(_T(False, True)) == "mps"


def test_cpu_fallback():
    assert pick_device(_T(False, False)) == "cpu"

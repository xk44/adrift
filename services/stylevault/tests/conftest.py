"""Keep every test away from a real library: no default home, no real config."""

import os
import tempfile

import pytest

os.environ["STYLEVAULT_HOME"] = tempfile.mkdtemp(prefix="stylevault-test-")
os.environ.pop("STYLEVAULT_CONFIG", None)
os.environ.pop("STYLEVAULT_EMBEDDER", None)
os.environ.pop("STYLEVAULT_ALLOWED_ROOTS", None)
# The test clients send this Host; test_local_only.py checks the real rule.
os.environ["STYLEVAULT_ALLOWED_HOSTS"] = "testserver"


@pytest.fixture
def anyio_backend() -> str:
    # Runs @pytest.mark.anyio tests on asyncio; trio isn't a dependency.
    return "asyncio"

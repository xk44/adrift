import os
import signal
import subprocess
import sys
import time

import pytest

from stylevault.api.training import _terminate_process

pytestmark = pytest.mark.skipif(os.name != "posix", reason="posix process groups")


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def test_terminate_kills_grandchildren():
    code = (
        "import subprocess,sys,time;"
        "c=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);"
        "print(c.pid,flush=True);time.sleep(60)"
    )
    p = subprocess.Popen(
        [sys.executable, "-c", code], stdout=subprocess.PIPE, text=True, start_new_session=True
    )
    grandchild = int(p.stdout.readline())
    assert _alive(grandchild)
    _terminate_process(p, grace=3)
    for _ in range(30):
        if not _alive(grandchild):
            break
        time.sleep(0.1)
    assert not _alive(grandchild)
    assert p.poll() is not None

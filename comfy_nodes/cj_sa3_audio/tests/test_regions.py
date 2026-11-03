import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from regions import parse_regions, frame_span, keep_spans  # noqa: E402


def test_parse():
    assert parse_regions("4-8; 14.5-18") == [(4.0, 8.0), (14.5, 18.0)]
    assert parse_regions("14 to 18, 2..3") == [(2.0, 3.0), (14.0, 18.0)]
    assert parse_regions("") == []


def test_bad():
    for bad in ("8-4", "x-2", "5"):
        try:
            parse_regions(bad)
        except ValueError:
            continue
        raise AssertionError(bad)


def test_span():
    r = 44100 / 4096
    assert frame_span(4, 8, r, 400) == (43, 87)
    assert frame_span(0, 1000, r, 100) == (0, 100)


def test_keep():
    assert keep_spans([(4, 8)], 30, 30) == [(0.0, 4), (8, 30)]
    assert keep_spans([], 10, 18) == [(0.0, 10)]
    assert keep_spans([(0, 30)], 30, 30) == []

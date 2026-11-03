from __future__ import annotations

from PIL import Image

from stylevault.embeddings import ColorHistogramEmbedding


def test_color_histogram_embedding_is_normalized() -> None:
    model = ColorHistogramEmbedding(bins=8)
    image = Image.new("RGB", (4, 2), color=(255, 0, 0))

    vector = model.encode(image)

    assert len(vector) == 24
    assert abs(sum(vector) - 3.0) < 1e-6


def test_color_histogram_embedding_uses_expected_bins() -> None:
    model = ColorHistogramEmbedding(bins=4)
    image = Image.new("RGB", (2, 1))
    image.putpixel((0, 0), (0, 127, 255))
    image.putpixel((1, 0), (255, 127, 0))

    vector = model.encode(image)

    # r: bins 0 and 3 each get one pixel -> 0.5 each
    assert vector[0] == 0.5
    assert vector[3] == 0.5
    # g: both values map to bin 1 -> 1.0
    assert vector[4 + 1] == 1.0
    # b: bins 3 and 0 each get one pixel -> 0.5 each
    assert vector[8 + 3] == 0.5
    assert vector[8 + 0] == 0.5

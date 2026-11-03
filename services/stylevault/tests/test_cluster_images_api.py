from __future__ import annotations

from pathlib import Path

import httpx
from PIL import Image
import pytest

from stylevault.api.app import create_app


def _write_image(path: Path, color: tuple[int, int, int]) -> None:
    Image.new("RGB", (8, 8), color=color).save(path)


@pytest.mark.anyio
async def test_cluster_images_happy_path_with_tiny_images(tmp_path: Path) -> None:
    image_paths = []
    for index, color in enumerate(
        [(255, 0, 0), (250, 0, 0), (0, 0, 255), (0, 0, 250)]
    ):
        path = tmp_path / f"image-{index}.png"
        _write_image(path, color)
        image_paths.append(path)
    skipped = tmp_path / "not-image.txt"
    skipped.write_text("nope", encoding="utf-8")

    transport = httpx.ASGITransport(app=create_app(tmp_path / "missing-config.toml"))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.post(
            "/cluster/images",
            json={
                "paths": [str(path) for path in image_paths] + [str(skipped)],
                "min_cluster_size": 2,
                "model": "color-histogram",
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["model"] == "color-histogram"
    assert body["skipped"] == [str(skipped)]
    accounted = [
        member
        for cluster in body["clusters"]
        for member in cluster["members"]
    ] + body["noise"]
    assert sorted(accounted) == sorted(str(path) for path in image_paths)


@pytest.mark.anyio
async def test_cluster_images_empty_and_too_few_inputs(tmp_path: Path) -> None:
    one = tmp_path / "one.png"
    _write_image(one, (255, 0, 0))

    transport = httpx.ASGITransport(app=create_app(tmp_path / "missing-config.toml"))
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        empty = await client.post("/cluster/images", json={"paths": []})
        too_few = await client.post(
            "/cluster/images",
            json={"paths": [str(one)], "min_cluster_size": 4},
        )

    assert empty.status_code == 200
    assert empty.json() == {
        "clusters": [],
        "noise": [],
        "skipped": [],
        "model": "color-histogram",
    }
    assert too_few.status_code == 200
    assert too_few.json()["clusters"] == [{"label": 0, "members": [str(one)]}]
    assert too_few.json()["noise"] == []

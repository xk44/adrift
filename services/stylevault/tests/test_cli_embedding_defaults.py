from stylevault.cli import resolve_embedding_models


def test_resolve_embedding_models_prefers_fusion_weights_when_present():
    settings = {
        "embeddings": {"primary_model": "model-a", "secondary_model": "siglip2"},
        "fusion": {"weights": {"model-a": 0.6, "siglip2": 0.3, "color-histogram": 0.1}},
    }
    assert resolve_embedding_models(settings, None) == [
        "model-a",
        "siglip2",
        "color-histogram",
    ]


def test_resolve_embedding_models_falls_back_to_primary_secondary():
    settings = {"embeddings": {"primary_model": "model-a", "secondary_model": "siglip2"}}
    assert resolve_embedding_models(settings, None) == ["model-a", "siglip2"]

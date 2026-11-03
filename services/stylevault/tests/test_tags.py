from __future__ import annotations

from stylevault.tags import extract_tags, normalize_tag, parse_tags_caption


def test_normalize_tag_strips_and_lowercases() -> None:
    assert normalize_tag("  FooBar  ") == "foobar"
    assert normalize_tag("") == ""


def test_extract_tags_removes_stopwords_and_short_tokens() -> None:
    tags = extract_tags("The quick brown fox is a very fast animal")
    assert "the" not in tags
    assert "is" not in tags
    assert "quick" in tags
    assert "brown" in tags
    assert "fox" in tags
    assert "fast" in tags
    assert "animal" in tags


def test_extract_tags_deduplicates() -> None:
    tags = extract_tags("cat cat cat dog dog")
    assert tags == ["cat", "dog"]


def test_extract_tags_respects_min_length() -> None:
    tags = extract_tags("hi go run jump", min_length=4)
    assert tags == ["jump"]


def test_extract_tags_handles_empty_string() -> None:
    assert extract_tags("") == []


def test_extract_tags_handles_special_characters() -> None:
    tags = extract_tags("hello-world foo_bar baz123")
    assert "hello" in tags
    assert "world" in tags
    assert "foo" in tags
    assert "bar" in tags
    assert "baz123" in tags


def test_parse_tags_caption_splits_on_comma() -> None:
    tags = parse_tags_caption("landscape, portrait, abstract")
    assert tags == ["landscape", "portrait", "abstract"]


def test_parse_tags_caption_deduplicates() -> None:
    tags = parse_tags_caption("red, blue, red, green, blue")
    assert tags == ["red", "blue", "green"]


def test_parse_tags_caption_strips_whitespace() -> None:
    tags = parse_tags_caption("  foo  ,  bar  ,  baz  ")
    assert tags == ["foo", "bar", "baz"]


def test_parse_tags_caption_skips_empty_entries() -> None:
    tags = parse_tags_caption(",,,foo,,,bar,,,")
    assert tags == ["foo", "bar"]


def test_parse_tags_caption_empty_string() -> None:
    assert parse_tags_caption("") == []

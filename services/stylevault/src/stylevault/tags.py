from __future__ import annotations

import re

STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "has",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "with",
}


def normalize_tag(tag: str) -> str:
    return tag.strip().lower()


def extract_tags(text: str, min_length: int = 3) -> list[str]:
    tokens = re.findall(r"[a-zA-Z0-9']+", text.lower())
    seen: set[str] = set()
    tags: list[str] = []
    for token in tokens:
        token = normalize_tag(token)
        if len(token) < min_length or token in STOPWORDS:
            continue
        if token not in seen:
            seen.add(token)
            tags.append(token)
    return tags


def parse_tags_caption(text: str) -> list[str]:
    seen: set[str] = set()
    tags: list[str] = []
    for raw_tag in text.split(","):
        tag = normalize_tag(raw_tag)
        if not tag:
            continue
        if tag not in seen:
            seen.add(tag)
            tags.append(tag)
    return tags

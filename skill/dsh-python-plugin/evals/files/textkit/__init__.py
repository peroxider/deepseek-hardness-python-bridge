"""Text utilities: the business code under conversion (no bridge decorators)."""

import re


def word_count(text: str) -> dict:
    words = re.findall(r"\w+", text)
    return {"words": len(words), "chars": len(text), "lines": text.count("\n") + 1}


def slugify(text: str, max_length: int = 60) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:max_length]


def summarize(text: str, sentences: int = 2) -> str:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return " ".join(parts[:sentences])

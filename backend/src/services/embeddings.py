"""Embedding helper used by the hybrid RAG engine.

Uses OpenAI ``text-embedding-3-small`` (1536-d) when an API key is present and
falls back to a deterministic local hashing embedder so the prototype (and the
seed script) work fully offline. Both produce 1536-dim unit vectors, so data
seeded locally stays compatible with a later key being added.
"""

import hashlib
import logging
import math
import re
from typing import List

from src.config import settings

logger = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"[a-z0-9]+")

_STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "if", "then", "of", "to", "in", "on", "for",
    "with", "is", "are", "was", "were", "be", "been", "it", "this", "that", "at", "by",
    "as", "we", "our", "my", "me", "i", "you", "your", "from", "has", "have", "do", "does",
    "not", "no", "can", "cant", "unable", "cannot", "when", "user", "users",
}


def _tokens(text: str) -> List[str]:
    return [t for t in _TOKEN_RE.findall(text.lower()) if t not in _STOPWORDS]


def local_embed(text: str, dim: int = settings.VECTOR_DIMENSION) -> List[float]:
    """Deterministic feature-hashing embedding (offline stand-in)."""
    vec = [0.0] * dim
    tokens = _tokens(text)
    if not tokens:
        tokens = ["empty"]
    for token in tokens:
        for ngram in (token, f"{token}_2") if len(token) > 3 else (token,):
            digest = hashlib.sha1(ngram.encode("utf-8")).digest()
            idx = int.from_bytes(digest[:4], "big") % dim
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vec[idx] += sign
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


async def embed_texts(texts: List[str]) -> List[List[float]]:
    """Batch-embed texts (OpenAI when available, local hashing otherwise)."""
    if not texts:
        return []
    if settings.has_openai:
        try:
            from openai import AsyncOpenAI

            client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
            response = await client.embeddings.create(
                model=settings.OPENAI_EMBEDDING_MODEL, input=texts
            )
            return [item.embedding for item in response.data]
        except Exception as exc:  # noqa: BLE001
            logger.warning("OpenAI embeddings failed, using local embedder: %s", exc)
    return [local_embed(t) for t in texts]


async def embed_text(text: str) -> List[float]:
    return (await embed_texts([text]))[0]

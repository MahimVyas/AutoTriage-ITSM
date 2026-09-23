"""Pipeline 3 — Hybrid RAG engine (pgvector cosine + BM25 lexical, RRF fused).

Given a scrubbed ticket description:
  1. embed it (1536-d),
  2. run a pgvector cosine similarity search over ``kb_documents``,
  3. run BM25 (rank_bm25) over the same corpus in-process,
  4. fuse both rankings with Reciprocal Rank Fusion,
  5. prompt the LLM with the top-k chunks for exactly 3 concise troubleshooting
     steps (deterministic extractor when no LLM key is configured).
"""

import logging
import re
from dataclasses import dataclass, field
from typing import List, Optional, Sequence
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.database import KB_Documents
from src.services.embeddings import embed_text, _tokens
from src.schemas import TroubleshootingSteps

logger = logging.getLogger(__name__)

_RRF_K = 60
_TOKEN_RE = re.compile(r"[a-z0-9]+")


@dataclass
class Citation:
    id: UUID
    title: str
    category: str
    score: float
    snippet: str = ""


@dataclass
class RAGResult:
    steps: List[str]
    citations: List[Citation] = field(default_factory=list)
    used_llm: bool = False


# --------------------------------------------------------------------------- #
# BM25 corpus cache (rebuilt when the KB changes)
# --------------------------------------------------------------------------- #
class _BM25Index:
    def __init__(self, docs: Sequence[KB_Documents], tokenized_corpus: Sequence[Sequence[str]]):
        from rank_bm25 import BM25Okapi

        self.doc_ids = [d.id for d in docs]
        self.docs = list(docs)
        self.bm25 = BM25Okapi([list(t) for t in tokenized_corpus]) if tokenized_corpus else None

    def search(self, query: str, k: int) -> List[int]:
        """Return corpus indices ordered by BM25 score (best first)."""
        if self.bm25 is None:
            return []
        scores = self.bm25.get_scores(_tokens(query))
        ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
        return [i for i in ranked[:k] if scores[i] > 0]


_bm25_cache: dict[str, _BM25Index] = {}


async def _get_bm25_index(session: AsyncSession, docs: List[KB_Documents]) -> _BM25Index:
    corpus_key = f"{len(docs)}:{sum(len(d.content) for d in docs)}"
    cached = _bm25_cache.get(corpus_key)
    if cached is None:
        tokenized = [_tokens(f"{d.title} {d.category} {d.content}") for d in docs]
        cached = _BM25Index(docs, tokenized)
        _bm25_cache.clear()
        _bm25_cache[corpus_key] = cached
        logger.info("Rebuilt BM25 index over %d KB documents", len(docs))
    return cached


# --------------------------------------------------------------------------- #
# Retrieval
# --------------------------------------------------------------------------- #
async def _vector_search(
    session: AsyncSession, query_vector: List[float], k: int
) -> List[tuple[KB_Documents, float]]:
    """Cosine distance search via pgvector's ``<=>`` operator."""
    distance = KB_Documents.embedding.cosine_distance(query_vector)
    stmt = (
        select(KB_Documents, distance.label("distance"))
        .order_by(distance)
        .limit(k)
    )
    try:
        rows = (await session.execute(stmt)).all()
        return [(row[0], float(row[1])) for row in rows if row[0].embedding is not None]
    except Exception as exc:  # noqa: BLE001 — pgvector may be unavailable in dev
        logger.warning("pgvector search unavailable (%s); falling back to BM25 only", exc)
        return []


def _rrf_fuse(rankings: List[List[UUID]], doc_map: dict[UUID, KB_Documents]) -> List[Citation]:
    scores: dict[UUID, float] = {}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (_RRF_K + rank)
    fused = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    return [
        Citation(
            id=doc_id,
            title=doc_map[doc_id].title,
            category=doc_map[doc_id].category,
            score=round(score, 5),
            snippet=doc_map[doc_id].content[:400],
        )
        for doc_id, score in fused
        if doc_id in doc_map
    ]


# --------------------------------------------------------------------------- #
# Step synthesis
# --------------------------------------------------------------------------- #
_STEP_SYSTEM = """You are an L1 support coach for AutoTriage-ITSM.
Using ONLY the knowledge base excerpts provided, output exactly 3 concise,
actionable troubleshooting steps for an L1 agent. Each step <= 25 words,
imperative mood, no preamble.
Return JSON: {"steps": ["...", "...", "..."]}"""


async def _llm_steps(question: str, citations: List[Citation]) -> Optional[List[str]]:
    if not (settings.has_openai or settings.has_gemini):
        return None
    context = "\n\n".join(
        f"[KB: {c.title} ({c.category})]\n{c.snippet}" for c in citations
    )
    user_prompt = f"Knowledge base excerpts:\n{context}\n\nIncident:\n{question}"

    try:
        if settings.has_openai:
            import json

            from openai import AsyncOpenAI

            client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
            response = await client.chat.completions.create(
                model=settings.OPENAI_MODEL,
                max_tokens=600,
                temperature=0.2,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": _STEP_SYSTEM},
                    {"role": "user", "content": user_prompt},
                ],
            )
            payload = json.loads(response.choices[0].message.content)
        else:
            import asyncio

            import google.generativeai as genai

            genai.configure(api_key=settings.GOOGLE_GEMINI_API_KEY)
            model = genai.GenerativeModel(
                settings.GOOGLE_GEMINI_MODEL,
                generation_config={"response_mime_type": "application/json", "temperature": 0.2},
            )
            completion = await model.generate_content_async(
                f"{_STEP_SYSTEM}\n\n{user_prompt}"
            )
            import json as _json

            payload = _json.loads(completion.text)

        parsed = TroubleshootingSteps.model_validate(payload)
        steps = [s.strip() for s in parsed.steps if s.strip()][:3]
        if steps:
            return steps
    except Exception as exc:  # noqa: BLE001
        logger.warning("LLM step synthesis failed, using extractive fallback: %s", exc)
    return None


_ACTIONABLE_RE = re.compile(r"^\s*(?:\d+[\.\)]\s*|[-*•]\s*)?(?P<body>[A-Z].{15,180}?[.!?])\s*$")


def _extractive_steps(citations: List[Citation]) -> List[str]:
    """Deterministic 3-step synthesis: pull the best actionable line per top KB."""
    steps: List[str] = []
    skip_prefixes = ("runbook:", "runbook -", "document", "revision")
    for citation in citations:
        for raw_line in citation.snippet.splitlines():
            line = raw_line.strip()
            if not line or len(line) < 20:
                continue
            if line.lower().startswith(skip_prefixes):
                continue
            match = _ACTIONABLE_RE.match(line)
            body = match.group("body") if match else line
            body = re.sub(r"\s+", " ", body).strip()
            if len(body) > 140:
                body = body[:137].rstrip() + "..."
            if body and body not in steps:
                steps.append(body)
            if len(steps) == 3:
                return steps
        if len(steps) == 3:
            break

    # Pad from whatever the KB gave us so the UI always renders 3 steps
    fallbacks = [
        "Confirm the reported symptom, affected user, device and time window with the requester.",
        "Run the standard diagnostic checks referenced in the matched knowledge-base runbook.",
        "Escalate to the owning engineering queue if diagnostics do not clear the fault.",
    ]
    for pad in fallbacks:
        if len(steps) >= 3:
            break
        steps.append(pad)
    return steps[:3]


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
async def retrieve(
    session: AsyncSession,
    query: str,
    k: Optional[int] = None,
    category: Optional[str] = None,
) -> List[Citation]:
    """Hybrid retrieval only (no generation) — used for provenance display."""
    k = k or settings.KB_SEARCH_K

    all_docs = (await session.execute(select(KB_Documents))).scalars().all()
    if not all_docs:
        logger.warning("Knowledge base is empty — run `python seed.py`")
        return []

    doc_map = {d.id: d for d in all_docs}
    query_vector = await embed_text(query)

    vector_hits = await _vector_search(session, query_vector, k * 2)
    vector_ranking = [doc.id for doc, _ in vector_hits]

    index = await _get_bm25_index(session, all_docs)
    bm25_ranking = [index.doc_ids[i] for i in index.search(query, k * 2)]

    citations = _rrf_fuse([vector_ranking, bm25_ranking], doc_map)

    if category:
        citations.sort(key=lambda c: (c.category != category, -c.score))
    return citations[:k]


async def generate_troubleshooting_steps(
    session: AsyncSession,
    query: str,
    k: Optional[int] = None,
    category: Optional[str] = None,
) -> RAGResult:
    """Full hybrid RAG pass: retrieve → fuse → synthesise 3 L1 steps."""
    citations = await retrieve(session, query, k=k, category=category)
    if not citations:
        return RAGResult(
            steps=_extractive_steps([]),
            citations=[],
            used_llm=False,
        )

    llm_steps = await _llm_steps(query, citations)
    if llm_steps:
        return RAGResult(steps=llm_steps, citations=citations, used_llm=True)
    return RAGResult(steps=_extractive_steps(citations), citations=citations, used_llm=False)

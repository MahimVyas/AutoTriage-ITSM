"""Pipeline 1 — PII scrubbing middleware.

Every user-provided description is sanitized *before* it reaches any LLM,
embedding API or vector store. Detected items are replaced with the
configured token (default ``[REDACTED_SENSITIVE_DATA]``).
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List

from src.config import settings

logger = logging.getLogger(__name__)


@dataclass
class PIIPattern:
    name: str
    description: str
    regex: re.Pattern
    matches: int = 0


@dataclass
class ScrubResult:
    text: str
    detected: Dict[str, int] = field(default_factory=dict)

    @property
    def total_redactions(self) -> int:
        return sum(self.detected.values())

    @property
    def clean(self) -> bool:
        return self.total_redactions == 0


# Ordered: most specific first, generic patterns last.
_BUILTIN_PATTERNS = [
    ("ssn", r"\b\d{3}-\d{2}-\d{4}\b", "Social Security Number"),
    ("credit_card", r"\b(?:\d{4}[ -]?){3}\d{4}\b", "Credit card number"),
    ("email", r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", "Email address"),
    ("ipv4", r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "IPv4 address"),
    ("password", r"(?:password|passwd|pwd)\s*[=:]\s*[^\s,;]+", "Password / credential"),
    ("api_key", r"\b(?:api[_ -]?key|secret|access[_ -]?token|bearer)\s*[=:]\s*[^\s,;]+", "API key / token"),
    ("phone", r"\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b", "Phone number"),
    ("bank_account", r"\b\d{9,17}\b", "Long numeric account identifier"),
]


class PIIScrubber:
    """Regex-driven scrubber used as middleware on the ingestion path."""

    def __init__(self, replacement: str | None = None):
        self.replacement = replacement or settings.PII_REDACTION_TOKEN
        self.patterns: List[PIIPattern] = []
        seen = set()
        for name, pattern, description in _BUILTIN_PATTERNS:
            if name in seen:
                continue
            seen.add(name)
            try:
                self.patterns.append(
                    PIIPattern(name=name, description=description, regex=re.compile(pattern, re.I))
                )
            except re.error as exc:
                logger.warning("Invalid PII regex for %s: %s", name, exc)

        # Extra patterns from settings (deduped against built-ins by pattern text)
        builtin_texts = {p.regex.pattern for p in self.patterns}
        for i, pattern_str in enumerate(settings.PII_REDACTION_PATTERNS):
            if pattern_str in builtin_texts:
                continue
            try:
                self.patterns.append(
                    PIIPattern(
                        name=f"config_{i}",
                        description="Configured sensitive pattern",
                        regex=re.compile(pattern_str, re.I),
                    )
                )
            except re.error as exc:
                logger.warning("Invalid configured PII regex %r: %s", pattern_str, exc)

        logger.info(
            "PII scrubber initialised: %d patterns, replacement=%s",
            len(self.patterns),
            self.replacement,
        )

    # ------------------------------------------------------------------ #
    def scrub(self, text: str) -> ScrubResult:
        if not text:
            return ScrubResult(text=text or "")

        detected: Dict[str, int] = {}
        current = text
        for pattern in self.patterns:
            current, count = pattern.regex.subn(self.replacement, current)
            if count:
                detected[pattern.name] = detected.get(pattern.name, 0) + count

        if detected:
            logger.info("Scrubbed PII from text: %s", detected)
        return ScrubResult(text=current, detected=detected)

    def scrub_text(self, text: str) -> str:
        """Convenience wrapper returning only the scrubbed string."""
        return self.scrub(text).text

    def scrub_ticket_data(self, ticket_data: Dict[str, Any]) -> Dict[str, Any]:
        scrubbed = dict(ticket_data)
        for key in ("title", "raw_description", "description", "notes"):
            if isinstance(scrubbed.get(key), str):
                scrubbed[key] = self.scrub_text(scrubbed[key])
        return scrubbed

    def get_scrubbing_stats(self) -> Dict[str, Any]:
        return {
            "pattern_count": len(self.patterns),
            "replacement_token": self.replacement,
            "patterns": [
                {"name": p.name, "description": p.description, "regex": p.regex.pattern}
                for p in self.patterns
            ],
        }


_scrubber: PIIScrubber | None = None


def get_pii_scrubber() -> PIIScrubber:
    global _scrubber
    if _scrubber is None:
        _scrubber = PIIScrubber()
    return _scrubber

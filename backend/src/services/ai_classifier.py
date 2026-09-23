"""Pipeline 2 — tiered AI classification with strict Pydantic structured output.

Tier 1 : instant keyword / heuristic "local SLM" pass (no network, ~0 ms).
Tier 2 : cloud LLM (OpenAI gpt-4o-mini or Gemini 1.5 Flash) using structured
         JSON output, invoked when Tier 1 confidence < threshold OR the ticket
         is high-risk (SECURITY).
Fallback: deterministic rule engine so the prototype always produces a valid
         ``TicketClassificationResponse`` even without API keys.
"""

import json
import logging
from typing import Optional

from src.config import settings
from src.database import AI_Tier, TicketCategory, TicketSeverity
from src.schemas import TicketClassificationResponse

logger = logging.getLogger(__name__)

# Ordered (keyword -> category/subcategory/severity/confidence). First match wins.
_TIER1_RULES = [
    ("phishing", TicketCategory.SECURITY, "PHISHING", TicketSeverity.P1_CRITICAL, 0.93),
    ("ransomware", TicketCategory.SECURITY, "RANSOMWARE", TicketSeverity.P1_CRITICAL, 0.97),
    ("malware", TicketCategory.SECURITY, "MALWARE", TicketSeverity.P1_CRITICAL, 0.95),
    ("virus", TicketCategory.SECURITY, "MALWARE", TicketSeverity.P1_CRITICAL, 0.93),
    ("breach", TicketCategory.SECURITY, "DATA_BREACH", TicketSeverity.P1_CRITICAL, 0.95),
    ("suspicious login", TicketCategory.SECURITY, "ACCOUNT_COMPROMISE", TicketSeverity.P1_CRITICAL, 0.92),
    ("data leak", TicketCategory.SECURITY, "DATA_EXFILTRATION", TicketSeverity.P1_CRITICAL, 0.94),
    ("hack", TicketCategory.SECURITY, "INTRUSION", TicketSeverity.P1_CRITICAL, 0.92),

    ("cannot access", TicketCategory.IAM_ACCESS, "PERMISSION_DENIED", TicketSeverity.P2_HIGH, 0.88),
    ("access denied", TicketCategory.IAM_ACCESS, "PERMISSION_DENIED", TicketSeverity.P2_HIGH, 0.88),
    ("permission", TicketCategory.IAM_ACCESS, "PERMISSION_DENIED", TicketSeverity.P3_MEDIUM, 0.86),
    ("password reset", TicketCategory.IAM_ACCESS, "PASSWORD_RESET", TicketSeverity.P3_MEDIUM, 0.92),
    ("password", TicketCategory.IAM_ACCESS, "PASSWORD_RESET", TicketSeverity.P3_MEDIUM, 0.87),
    ("mfa", TicketCategory.IAM_ACCESS, "MFA_ISSUE", TicketSeverity.P2_HIGH, 0.87),
    ("locked out", TicketCategory.IAM_ACCESS, "ACCOUNT_LOCKOUT", TicketSeverity.P2_HIGH, 0.90),
    ("login", TicketCategory.IAM_ACCESS, "LOGIN_FAILURE", TicketSeverity.P3_MEDIUM, 0.86),
    ("sso", TicketCategory.IAM_ACCESS, "SSO_FEDERATION", TicketSeverity.P2_HIGH, 0.86),

    ("no internet", TicketCategory.NETWORK, "NO_CONNECTIVITY", TicketSeverity.P2_HIGH, 0.92),
    ("wifi", TicketCategory.NETWORK, "WIRELESS", TicketSeverity.P3_MEDIUM, 0.88),
    ("vpn", TicketCategory.NETWORK, "VPN", TicketSeverity.P2_HIGH, 0.87),
    ("dns", TicketCategory.NETWORK, "DNS", TicketSeverity.P2_HIGH, 0.86),
    ("network", TicketCategory.NETWORK, "CONNECTIVITY", TicketSeverity.P3_MEDIUM, 0.86),
    ("slow", TicketCategory.NETWORK, "PERFORMANCE", TicketSeverity.P3_MEDIUM, 0.84),
    ("latency", TicketCategory.NETWORK, "PERFORMANCE", TicketSeverity.P3_MEDIUM, 0.84),

    ("blue screen", TicketCategory.HARDWARE, "BSOD", TicketSeverity.P2_HIGH, 0.90),
    ("won't turn on", TicketCategory.HARDWARE, "POWER_FAILURE", TicketSeverity.P2_HIGH, 0.91),
    ("wont turn on", TicketCategory.HARDWARE, "POWER_FAILURE", TicketSeverity.P2_HIGH, 0.91),
    ("overheat", TicketCategory.HARDWARE, "THERMAL", TicketSeverity.P2_HIGH, 0.87),
    ("printer", TicketCategory.HARDWARE, "PRINTER", TicketSeverity.P4_LOW, 0.88),
    ("monitor", TicketCategory.HARDWARE, "DISPLAY", TicketSeverity.P3_MEDIUM, 0.86),
    ("laptop", TicketCategory.HARDWARE, "LAPTOP", TicketSeverity.P3_MEDIUM, 0.85),
    ("keyboard", TicketCategory.HARDWARE, "PERIPHERAL", TicketSeverity.P4_LOW, 0.86),
    ("hardware", TicketCategory.HARDWARE, "GENERIC", TicketSeverity.P3_MEDIUM, 0.85),

    ("crash", TicketCategory.SOFTWARE, "APPLICATION_CRASH", TicketSeverity.P2_HIGH, 0.86),
    ("bug", TicketCategory.SOFTWARE, "APPLICATION_BUG", TicketSeverity.P3_MEDIUM, 0.85),
    ("install", TicketCategory.SOFTWARE, "INSTALLATION", TicketSeverity.P3_MEDIUM, 0.85),
    ("update", TicketCategory.SOFTWARE, "PATCHING", TicketSeverity.P4_LOW, 0.85),
    ("outlook", TicketCategory.SOFTWARE, "EMAIL_CLIENT", TicketSeverity.P3_MEDIUM, 0.86),
    ("software", TicketCategory.SOFTWARE, "GENERIC", TicketSeverity.P3_MEDIUM, 0.85),
]

_T2_SYSTEM_PROMPT = """You are an enterprise ITSM triage engine for AutoTriage-ITSM.
Classify the incident ticket you are given.
Return ONLY JSON matching this schema:
{
  "category": "HARDWARE|NETWORK|IAM_ACCESS|SOFTWARE|SECURITY|UNASSIGNED",
  "subcategory": "short_snake_case",
  "severity": "P1_CRITICAL|P2_HIGH|P3_MEDIUM|P4_LOW",
  "confidence_score": 0.0-1.0,
  "reasoning": "one sentence",
  "summary": "one-line executive summary"
}
Severity guide: P1 = outage/security breach, P2 = major degradation, P3 = single user blocked, P4 = cosmetic/request."""


class AI_Classifier:
    """Tiered classifier. Always returns a validated Pydantic response."""

    def __init__(self):
        self.cache: dict[str, TicketClassificationResponse] = {}

    # ------------------------------------------------------------------ #
    # Tier 1 — local, instant
    # ------------------------------------------------------------------ #
    def tier1(self, text: str) -> Optional[TicketClassificationResponse]:
        key = text.lower().strip()
        if key in self.cache:
            return self.cache[key]

        for keyword, category, subcategory, severity, confidence in _TIER1_RULES:
            if keyword in key:
                result = TicketClassificationResponse(
                    category=category,
                    subcategory=subcategory,
                    severity=severity,
                    confidence_score=confidence,
                    reasoning=f"Tier-1 local keyword rule matched '{keyword}'.",
                    summary=f"{severity.value.replace('_', ' ').title()} {category.value} issue: {subcategory.replace('_', ' ').lower()}.",
                    ai_tier_used=AI_Tier.TIER1_LOCAL_SLM,
                )
                self.cache[key] = result
                return result
        return None

    # ------------------------------------------------------------------ #
    # Tier 2 — cloud LLM with structured JSON output
    # ------------------------------------------------------------------ #
    async def tier2(self, text: str) -> Optional[TicketClassificationResponse]:
        if settings.has_openai:
            try:
                return await self._tier2_openai(text)
            except Exception as exc:  # noqa: BLE001
                logger.warning("OpenAI Tier-2 failed, trying Gemini: %s", exc)
        if settings.has_gemini:
            try:
                return await self._tier2_gemini(text)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Gemini Tier-2 failed: %s", exc)
        return None

    async def _tier2_openai(self, text: str) -> TicketClassificationResponse:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)
        response = await client.chat.completions.create(
            model=settings.OPENAI_MODEL,
            max_tokens=settings.T2_MAX_TOKENS,
            response_format={"type": "json_object"},
            temperature=0,
            messages=[
                {"role": "system", "content": _T2_SYSTEM_PROMPT},
                {"role": "user", "content": f"Ticket:\n{text}"},
            ],
        )
        payload = json.loads(response.choices[0].message.content)
        result = TicketClassificationResponse.model_validate({**payload, "ai_tier_used": AI_Tier.TIER2_CLOUD_LLM})
        logger.info("Tier-2 (OpenAI) classification: %s conf=%.2f", result.category, result.confidence_score)
        return result

    async def _tier2_gemini(self, text: str) -> TicketClassificationResponse:
        import google.generativeai as genai

        genai.configure(api_key=settings.GOOGLE_GEMINI_API_KEY)
        model = genai.GenerativeModel(
            settings.GOOGLE_GEMINI_MODEL,
            generation_config={
                "response_mime_type": "application/json",
                "response_schema": None,
                "temperature": 0,
            },
        )
        completion = await model.generate_content_async(f"{_T2_SYSTEM_PROMPT}\n\nTicket:\n{text}")
        payload = json.loads(completion.text)
        result = TicketClassificationResponse.model_validate({**payload, "ai_tier_used": AI_Tier.TIER2_CLOUD_LLM})
        logger.info("Tier-2 (Gemini) classification: %s conf=%.2f", result.category, result.confidence_score)
        return result

    # ------------------------------------------------------------------ #
    # Deterministic fallback (no API keys required — keeps the demo alive)
    # ------------------------------------------------------------------ #
    def rule_fallback(self, text: str) -> TicketClassificationResponse:
        lowered = text.lower()
        buckets = [
            (["hack", "attack", "breach", "compromise", "intrusion", "phish", "exfiltrat"],
             TicketCategory.SECURITY, "INCIDENT", TicketSeverity.P1_CRITICAL, 0.62),
            (["password", "login", "access", "account", "permission", "mfa", "sso"],
             TicketCategory.IAM_ACCESS, "ACCESS_REQUEST", TicketSeverity.P3_MEDIUM, 0.58),
            (["internet", "network", "wifi", "vpn", "slow", "latency", "dns", "connection"],
             TicketCategory.NETWORK, "CONNECTIVITY", TicketSeverity.P3_MEDIUM, 0.57),
            (["laptop", "printer", "monitor", "keyboard", "hardware", "battery", "screen"],
             TicketCategory.HARDWARE, "DEVICE", TicketSeverity.P3_MEDIUM, 0.55),
            (["software", "application", "install", "update", "crash", "bug", "outlook"],
             TicketCategory.SOFTWARE, "APPLICATION", TicketSeverity.P3_MEDIUM, 0.55),
        ]
        for keywords, category, subcategory, severity, confidence in buckets:
            if any(k in lowered for k in keywords):
                return TicketClassificationResponse(
                    category=category,
                    subcategory=subcategory,
                    severity=severity,
                    confidence_score=confidence,
                    reasoning="Rule fallback: keyword bucket scoring below Tier-2 availability.",
                    summary=f"{category.value} issue requiring human review.",
                    ai_tier_used=AI_Tier.RULE_FALLBACK,
                )
        return TicketClassificationResponse(
            category=TicketCategory.UNASSIGNED,
            subcategory="NEEDS_REVIEW",
            severity=TicketSeverity.P4_LOW,
            confidence_score=0.30,
            reasoning="Rule fallback: no keyword bucket matched.",
            summary="Unclassified request routed for manual triage.",
            ai_tier_used=AI_Tier.RULE_FALLBACK,
        )

    # ------------------------------------------------------------------ #
    # Orchestrator
    # ------------------------------------------------------------------ #
    async def classify(self, text: str) -> TicketClassificationResponse:
        t1 = self.tier1(text)
        needs_tier2 = (
            t1 is None
            or t1.confidence_score < settings.CONFIDENCE_THRESHOLD
            or t1.category == TicketCategory.SECURITY  # high-risk always escalates
        )
        if not needs_tier2:
            logger.info("Tier-1 accepted (conf=%.2f): %s", t1.confidence_score, t1.category.value)
            return t1

        logger.info(
            "Routing to Tier-2 (t1=%s conf=%s)",
            t1.category.value if t1 else "none",
            f"{t1.confidence_score:.2f}" if t1 else "n/a",
        )
        t2 = await self.tier2(text)
        if t2 is not None:
            return t2

        fallback = self.rule_fallback(text)
        # Keep the sharper Tier-1 severity hint if it produced something useful
        if t1 is not None and t1.category == fallback.category and t1.severity.value < fallback.severity.value:
            fallback.severity = t1.severity
        logger.info("Tier-2 unavailable — rule fallback: %s", fallback.category.value)
        return fallback


_classifier: AI_Classifier | None = None


async def get_ai_classifier() -> AI_Classifier:
    global _classifier
    if _classifier is None:
        _classifier = AI_Classifier()
    return _classifier

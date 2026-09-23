"""Offline smoke tests — no Postgres/Redis/LLM keys required.

Run:  python tests/test_smoke.py   (or pytest tests/)
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./smoke.db")


def test_pii_scrubber_redacts_everything():
    from src.services.pii_scrubber import get_pii_scrubber

    scrubber = get_pii_scrubber()
    text = (
        "Call me on 555-123-4567 or jane.doe@corp.com. SSN 123-45-6789, "
        "card 4111 1111 1111 1111, server at 192.168.10.24, "
        "password=hunter2, api_key=abc123secret."
    )
    result = scrubber.scrub(text)
    for leaked in ("123-45-6789", "4111", "jane.doe@", "192.168.10.24", "hunter2", "abc123secret"):
        assert leaked not in result.text, f"{leaked} leaked through the scrubber"
    assert scrubber.replacement in result.text
    assert result.total_redactions >= 6


def test_tier1_high_confidence_short_circuits():
    from src.services.ai_classifier import AI_Classifier
    from src.database import AI_Tier, TicketCategory

    classifier = AI_Classifier()
    result = classifier.tier1("I forgot my password and need a reset")
    assert result is not None
    assert result.category == TicketCategory.IAM_ACCESS
    assert result.confidence_score >= 0.85
    assert result.ai_tier_used == AI_Tier.TIER1_LOCAL_SLM


def test_security_always_flags_as_high_risk():
    from src.services.ai_classifier import AI_Classifier
    from src.database import TicketCategory, TicketSeverity

    classifier = AI_Classifier()
    result = classifier.tier1("phishing email harvests credentials")
    assert result.category == TicketCategory.SECURITY
    assert result.severity == TicketSeverity.P1_CRITICAL
    assert result.confidence_score >= 0.85


def test_orchestrator_routes_low_confidence_to_fallback_without_keys():
    from src.services.ai_classifier import AI_Classifier
    from src.database import AI_Tier

    classifier = AI_Classifier()

    async def run():
        return await classifier.classify(
            "something odd happened with the quarterly widget exporter today"
        )

    result = asyncio.run(run())
    # No API keys in CI => RULE_FALLBACK, but still schema-valid
    assert result.ai_tier_used == AI_Tier.RULE_FALLBACK
    assert 0.0 <= result.confidence_score <= 1.0
    assert result.reasoning and result.summary


def test_classification_schema_is_strict():
    from pydantic import ValidationError

    from src.schemas import TicketClassificationResponse

    # Valid payload validates
    ok = TicketClassificationResponse(
        category="NETWORK",
        subcategory="DNS",
        severity="P2_HIGH",
        confidence_score=0.9,
        reasoning="ok",
        summary="ok",
    )
    assert ok.confidence_score == 0.9

    # Out-of-range confidence is clamped, not accepted raw
    clamped = TicketClassificationResponse(
        category="NETWORK",
        subcategory="",
        severity="P3_MEDIUM",
        confidence_score=1.7,
        reasoning="x",
        summary="x",
    )
    assert clamped.confidence_score == 1.0

    # Invalid enum values rejected
    try:
        TicketClassificationResponse(
            category="COFFEE_MACHINE",
            subcategory="",
            severity="P3_MEDIUM",
            confidence_score=0.5,
            reasoning="x",
            summary="x",
        )
    except ValidationError:
        pass
    else:
        raise AssertionError("invalid category should have been rejected")


def test_local_embeddings_are_deterministic_and_similar():
    from src.services.embeddings import local_embed

    a = local_embed("vpn connection keeps dropping dns timeout")
    b = local_embed("vpn connection drops with dns timeout errors")
    c = local_embed("printer toner needs replacement on floor three")
    assert len(a) == 1536
    assert a == local_embed("vpn connection keeps dropping dns timeout")

    def dot(x, y):
        return sum(i * j for i, j in zip(x, y))

    assert dot(a, b) > dot(a, c), "similar texts must be closer than unrelated ones"


def test_sla_windows_match_spec():
    from src.workers.sla_worker import compute_sla_deadline, sla_window_seconds
    from datetime import datetime

    assert sla_window_seconds("P1_CRITICAL") == 900
    assert sla_window_seconds("P2_HIGH") == 3600
    assert sla_window_seconds("P3_MEDIUM") == 14400
    assert sla_window_seconds("P4_LOW") == 86400
    deadline = compute_sla_deadline("P2_HIGH", datetime(2026, 1, 1, 12, 0, 0))
    assert deadline == datetime(2026, 1, 1, 13, 0, 0)


def test_extractive_rag_always_yields_three_steps():
    from src.services.rag_engine import Citation, _extractive_steps

    citations = [
        Citation(
            id=__import__("uuid").uuid4(),
            title="VPN Runbook",
            category="NETWORK",
            score=0.1,
            snippet=(
                "Restart the VPN client service and reconnect to the regional gateway.\n"
                "Flush the DNS cache with ipconfig /flushdns before retrying the tunnel."
            ),
        )
    ]
    steps = _extractive_steps(citations)
    assert len(steps) == 3


def test_sla_breach_semantics():
    """Worker escalation rules: breach flag, P1 bump, ESCALATED status."""
    from types import SimpleNamespace

    from src.database import TicketSeverity, TicketStatus
    from src.workers.sla_worker import _escalate

    ticket = SimpleNamespace(
        is_sla_breached=False,
        severity=TicketSeverity.P3_MEDIUM,
        status=TicketStatus.OPEN,
        sla_deadline=None,
        title="Slow VPN",
    )
    message = _escalate(ticket)
    assert ticket.is_sla_breached is True
    assert ticket.severity == TicketSeverity.P1_CRITICAL
    assert ticket.status == TicketStatus.ESCALATED
    assert "P1_CRITICAL" in message

    # A resolved/closed ticket keeps its status (only open work is escalated)
    ticket2 = SimpleNamespace(
        is_sla_breached=False,
        severity=TicketSeverity.P4_LOW,
        status=TicketStatus.CLOSED,
        sla_deadline=None,
        title="Old request",
    )
    _escalate(ticket2)
    assert ticket2.status == TicketStatus.CLOSED
    assert ticket2.is_sla_breached is True


def test_app_imports_and_routes_registered():
    os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./smoke.db")
    from src.main import app

    paths = set(app.openapi().get("paths", {}))
    assert "/api/tickets" in paths
    assert "/api/tickets/{ticket_id}/override" in paths
    assert "/api/analytics/overview" in paths
    assert "/api/health" in paths


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS  {name}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                import traceback

                print(f"FAIL  {name}: {exc}")
                traceback.print_exc()
    print(f"\n{failures} failing")
    sys.exit(1 if failures else 0)

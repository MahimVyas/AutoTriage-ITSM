"""REST routes: tickets, HITL overrides, analytics, system."""

import logging
from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.config import settings
from src.database import (
    AIAuditLogs,
    AI_Tier,
    KB_Documents,
    SLAEvents,
    TicketCategory,
    TicketSeverity,
    TicketStatus,
    Tickets,
    Users,
    UserRole,
    get_async_db_session,
)
from src.schemas import (
    AnalyticsOverview,
    AnalyticsSummary,
    AuditLogOut,
    CategoryBucket,
    HealthOut,
    HITLOverrideRequest,
    KBCitation,
    TicketCreate,
    TicketDetailOut,
    TicketListOut,
    TicketOut,
    TicketUpdate,
    TierBucket,
    UserOut,
)
from src.services.ai_classifier import get_ai_classifier
from src.services.pii_scrubber import get_pii_scrubber
from src.services.rag_engine import generate_troubleshooting_steps, retrieve
from src.workers.sla_worker import compute_sla_deadline, schedule_sla_check

logger = logging.getLogger(__name__)

tickets_router = APIRouter(prefix="/api/tickets", tags=["tickets"])
analytics_router = APIRouter(prefix="/api/analytics", tags=["analytics"])
system_router = APIRouter(prefix="/api", tags=["system"])


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
async def _resolve_user(
    session: AsyncSession,
    user_id: Optional[UUID] = None,
    email: Optional[str] = None,
    role: UserRole = UserRole.EMPLOYEE,
) -> Users:
    if user_id:
        user = await session.get(Users, user_id)
        if user:
            return user
    if email:
        user = (
            await session.execute(select(Users).where(Users.email == email.lower()))
        ).scalar_one_or_none()
        if user:
            return user
        user = Users(name=email.split("@")[0].title(), email=email.lower(), role=role)
        session.add(user)
        await session.flush()
        return user
    # Default demo employee so the prototype works without auth
    user = (
        await session.execute(select(Users).where(Users.email == "aarav.sharma@autotriage.dev"))
    ).scalar_one_or_none()
    if user:
        return user
    user = Users(name="Aarav Sharma", email="aarav.sharma@autotriage.dev", role=UserRole.EMPLOYEE)
    session.add(user)
    await session.flush()
    return user


def _ticket_out(ticket: Tickets) -> TicketOut:
    payload = TicketOut.model_validate(ticket)
    payload.kb_citations = [
        KBCitation(id=doc.id, title=doc.title, category=doc.category, score=0.0)
        for doc in ticket.kb_documents
    ]
    return payload


# --------------------------------------------------------------------------- #
# Tickets
# --------------------------------------------------------------------------- #
@tickets_router.get("", response_model=TicketListOut)
async def list_tickets(
    category: Optional[TicketCategory] = None,
    severity: Optional[TicketSeverity] = None,
    status: Optional[TicketStatus] = None,
    sla: Optional[str] = Query(None, description="breached | ok | at_risk"),
    q: Optional[str] = None,
    limit: int = Query(100, le=500),
    offset: int = 0,
    session: AsyncSession = Depends(get_async_db_session),
):
    criteria = []
    if category:
        criteria.append(Tickets.category == category)
    if severity:
        criteria.append(Tickets.severity == severity)
    if status:
        criteria.append(Tickets.status == status)
    if q:
        like = f"%{q}%"
        criteria.append(Tickets.title.ilike(like) | Tickets.raw_description.ilike(like))

    now = datetime.utcnow()
    if sla == "breached":
        criteria.append(Tickets.is_sla_breached.is_(True))
    elif sla == "ok":
        criteria.append(
            Tickets.is_sla_breached.is_(False),
        )
        criteria.append(
            (Tickets.sla_deadline.is_(None)) | (Tickets.sla_deadline > now + timedelta(hours=1))
        )
    elif sla == "at_risk":
        criteria.append(Tickets.is_sla_breached.is_(False))
        criteria.append(Tickets.sla_deadline.isnot(None))
        criteria.append(Tickets.sla_deadline <= now + timedelta(hours=1))
        criteria.append(Tickets.sla_deadline > now)

    count_stmt = select(func.count()).select_from(Tickets)
    for criterion in criteria:
        count_stmt = count_stmt.where(criterion)
    total = (await session.execute(count_stmt)).scalar_one()

    stmt = (
        select(Tickets)
        .options(
            selectinload(Tickets.assigned_agent),
            selectinload(Tickets.created_by),
            selectinload(Tickets.kb_documents),
        )
        .order_by(Tickets.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    for criterion in criteria:
        stmt = stmt.where(criterion)

    rows = (await session.execute(stmt)).scalars().all()
    return TicketListOut(total=total, items=[_ticket_out(t) for t in rows])


@tickets_router.post("", response_model=dict, status_code=201)
async def create_ticket(
    payload: TicketCreate,
    session: AsyncSession = Depends(get_async_db_session),
):
    """Full ingestion pipeline: PII scrub → tiered classify → RAG → SLA schedule."""
    creator = await _resolve_user(session, payload.created_by_id, payload.created_by_email)

    # --- Pipeline 1: PII scrubbing -------------------------------------- #
    scrubber = get_pii_scrubber()
    title_result = scrubber.scrub(payload.title)
    desc_result = scrubber.scrub(payload.raw_description)
    scrubbed_text = f"{title_result.text}\n{desc_result.text}"
    redactions = {**title_result.detected, **desc_result.detected}

    # --- Pipeline 2: tiered AI classification --------------------------- #
    classifier = await get_ai_classifier()
    classification = await classifier.classify(scrubbed_text)

    # --- Persist -------------------------------------------------------- #
    deadline = compute_sla_deadline(classification.severity.value)
    ticket = Tickets(
        title=payload.title,
        raw_description=payload.raw_description,
        scrubbed_description=desc_result.text,
        category=classification.category,
        subcategory=classification.subcategory or None,
        severity=classification.severity,
        status=TicketStatus.OPEN,
        confidence_score=classification.confidence_score,
        ai_tier_used=classification.ai_tier_used,
        ai_summary=classification.summary,
        ai_reasoning=classification.reasoning,
        created_by_id=creator.id,
        sla_deadline=deadline,
    )

    # --- Pipeline 3: hybrid RAG (runs before persist; the ticket is still
    #     pending so the kb_documents collection never lazy-loads) -------- #
    rag = await generate_troubleshooting_steps(
        session,
        f"{ticket.title}\n{ticket.scrubbed_description}",
        category=classification.category.value,
    )
    ticket.troubleshooting_steps = rag.steps
    if rag.citations:
        doc_ids = [c.id for c in rag.citations]
        docs = (
            await session.execute(select(KB_Documents).where(KB_Documents.id.in_(doc_ids)))
        ).scalars().all()
        ticket.kb_documents = list(docs)

    session.add(ticket)
    await session.flush()

    # --- Pipeline 4: schedule the delayed SLA check in Redis ------------ #
    sla_task_id = None
    try:
        sla_task_id = schedule_sla_check(ticket.id, classification.severity.value)
        session.add(
            SLAEvents(
                ticket_id=ticket.id,
                event_type="SCHEDULED",
                message=(
                    f"SLA check queued for {deadline.isoformat()} "
                    f"({settings.SLA_DEADLINES[classification.severity.value]}s "
                    f"{classification.severity.value} window)"
                ),
            )
        )
    except Exception as exc:  # noqa: BLE001 — Redis may be down; beat sweep covers it
        logger.warning("Could not schedule SLA check: %s", exc)

    await session.flush()
    await session.refresh(ticket, attribute_names=["assigned_agent", "created_by"])

    return {
        "ticket": _ticket_out(ticket),
        "pipeline": {
            "pii": {
                "scrubbed": True,
                "redactions": redactions,
                "redaction_count": sum(redactions.values()),
                "token": scrubber.replacement,
            },
            "classification": {
                "tier": classification.ai_tier_used.value,
                "confidence": classification.confidence_score,
                "reasoning": classification.reasoning,
                "category": classification.category.value,
                "severity": classification.severity.value,
                "escalated_to_tier2": classification.ai_tier_used != AI_Tier.TIER1_LOCAL_SLM,
            },
            "rag": {
                "documents_retrieved": len(rag.citations),
                "used_llm": rag.used_llm,
                "steps": rag.steps,
                "citations": [
                    {"id": str(c.id), "title": c.title, "category": c.category, "score": c.score}
                    for c in rag.citations
                ],
            },
            "sla": {
                "deadline": deadline.isoformat(),
                "window_seconds": settings.SLA_DEADLINES[classification.severity.value],
                "task_id": sla_task_id,
            },
        },
    }


@tickets_router.get("/{ticket_id}", response_model=TicketDetailOut)
async def get_ticket(ticket_id: UUID, session: AsyncSession = Depends(get_async_db_session)):
    ticket = await _get_ticket_or_404(session, ticket_id)
    detail = TicketDetailOut.model_validate(ticket)
    detail.kb_citations = [
        KBCitation(id=doc.id, title=doc.title, category=doc.category, score=0.0)
        for doc in ticket.kb_documents
    ]
    return detail


@tickets_router.patch("/{ticket_id}", response_model=TicketOut)
async def update_ticket(
    ticket_id: UUID,
    payload: TicketUpdate,
    session: AsyncSession = Depends(get_async_db_session),
):
    ticket = await _get_ticket_or_404(session, ticket_id)
    if payload.status is not None:
        ticket.status = payload.status
    if payload.assigned_agent_id is not None:
        agent = await session.get(Users, payload.assigned_agent_id)
        if agent is None or agent.role not in (UserRole.AGENT, UserRole.ADMIN):
            raise HTTPException(status_code=400, detail="assignee must be an AGENT or ADMIN")
        ticket.assigned_agent_id = agent.id
        if ticket.status == TicketStatus.OPEN:
            ticket.status = TicketStatus.IN_PROGRESS
    await session.flush()
    await session.refresh(ticket, attribute_names=["assigned_agent", "created_by", "kb_documents"])
    return _ticket_out(ticket)


@tickets_router.post("/{ticket_id}/override", response_model=TicketDetailOut)
async def hitl_override(
    ticket_id: UUID,
    payload: HITLOverrideRequest,
    session: AsyncSession = Depends(get_async_db_session),
):
    """One-click human-in-the-loop correction → ai_audit_logs."""
    ticket = await _get_ticket_or_404(session, ticket_id)
    agent = await session.get(Users, payload.agent_id)
    if agent is None or agent.role not in (UserRole.AGENT, UserRole.ADMIN):
        raise HTTPException(status_code=403, detail="Only AGENT/ADMIN roles can override AI")

    original_category = ticket.category.value
    original_severity = ticket.severity.value

    log = AIAuditLogs(
        ticket_id=ticket.id,
        original_category=original_category,
        corrected_category=payload.category.value if payload.category else None,
        original_severity=original_severity,
        corrected_severity=payload.severity.value if payload.severity else None,
        corrected_by_agent_id=agent.id,
        note=payload.note,
    )
    session.add(log)

    changed = False
    if payload.category is not None and payload.category != ticket.category:
        ticket.category = payload.category
        changed = True
    if payload.severity is not None and payload.severity != ticket.severity:
        ticket.severity = payload.severity
        ticket.sla_deadline = compute_sla_deadline(payload.severity.value)
        # Reschedule the delayed SLA check for the new window
        try:
            schedule_sla_check(ticket.id, payload.severity.value)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not reschedule SLA check after override: %s", exc)
        changed = True

    if not changed:
        logger.info("Override submitted with no effective change for ticket %s", ticket_id)

    await session.flush()
    await session.refresh(ticket, attribute_names=[
        "assigned_agent", "created_by", "kb_documents", "audit_logs", "sla_events"
    ])
    return TicketDetailOut.model_validate(ticket)


@tickets_router.post("/{ticket_id}/escalate", response_model=dict)
async def manual_escalate(ticket_id: UUID, session: AsyncSession = Depends(get_async_db_session)):
    ticket = await _get_ticket_or_404(session, ticket_id)
    try:
        from src.workers.sla_worker import escalate_ticket

        task = escalate_ticket.apply_async(args=[str(ticket_id), "Manual agent escalation"])
        return {"ticket_id": str(ticket_id), "queued": True, "task_id": task.id}
    except Exception as exc:  # noqa: BLE001
        logger.warning("Celery unavailable, escalating inline: %s", exc)
        ticket.is_sla_breached = True
        ticket.severity = TicketSeverity.P1_CRITICAL
        ticket.status = TicketStatus.ESCALATED
        session.add(
            SLAEvents(
                ticket_id=ticket.id,
                event_type="MANUAL",
                message="Manual escalation applied inline (queue unavailable)",
            )
        )
        await session.flush()
        return {"ticket_id": str(ticket_id), "queued": False, "result": "escalated_inline"}


@tickets_router.post("/{ticket_id}/troubleshooting", response_model=dict)
async def regenerate_troubleshooting(ticket_id: UUID, session: AsyncSession = Depends(get_async_db_session)):
    """Re-run the hybrid RAG engine on demand."""
    ticket = await _get_ticket_or_404(session, ticket_id)
    rag = await generate_troubleshooting_steps(
        session, f"{ticket.title}\n{ticket.scrubbed_description}", category=ticket.category.value
    )
    ticket.troubleshooting_steps = rag.steps
    if rag.citations:
        docs = (
            await session.execute(
                select(KB_Documents).where(
                    KB_Documents.id.in_([c.id for c in rag.citations])
                )
            )
        ).scalars().all()
        ticket.kb_documents = list(docs)
    await session.flush()
    return {
        "steps": rag.steps,
        "used_llm": rag.used_llm,
        "citations": [{"id": str(c.id), "title": c.title, "score": c.score} for c in rag.citations],
    }


@tickets_router.get("/{ticket_id}/audit", response_model=list[AuditLogOut])
async def ticket_audit(ticket_id: UUID, session: AsyncSession = Depends(get_async_db_session)):
    await _get_ticket_or_404(session, ticket_id)
    rows = (
        await session.execute(
            select(AIAuditLogs)
            .where(AIAuditLogs.ticket_id == ticket_id)
            .order_by(AIAuditLogs.timestamp.desc())
        )
    ).scalars().all()
    return [AuditLogOut.model_validate(r) for r in rows]


async def _get_ticket_or_404(session: AsyncSession, ticket_id: UUID) -> Tickets:
    ticket = (
        await session.execute(
            select(Tickets)
            .where(Tickets.id == ticket_id)
            .options(
                selectinload(Tickets.assigned_agent),
                selectinload(Tickets.created_by),
                selectinload(Tickets.kb_documents),
                selectinload(Tickets.audit_logs),
                selectinload(Tickets.sla_events),
            )
        )
    ).scalar_one_or_none()
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return ticket


# --------------------------------------------------------------------------- #
# Analytics (Admin dashboard)
# --------------------------------------------------------------------------- #
@analytics_router.get("/overview", response_model=AnalyticsOverview)
async def analytics_overview(session: AsyncSession = Depends(get_async_db_session)):
    total = (await session.execute(select(func.count()).select_from(Tickets))).scalar_one() or 0
    open_count = (
        await session.execute(
            select(func.count()).select_from(Tickets).where(
                Tickets.status.in_([TicketStatus.OPEN, TicketStatus.IN_PROGRESS, TicketStatus.ESCALATED])
            )
        )
    ).scalar_one() or 0
    breached = (
        await session.execute(
            select(func.count()).select_from(Tickets).where(Tickets.is_sla_breached.is_(True))
        )
    ).scalar_one() or 0
    overrides = (await session.execute(select(func.count()).select_from(AIAuditLogs))).scalar_one() or 0
    avg_conf = (
        await session.execute(select(func.avg(Tickets.confidence_score)))
    ).scalar_one() or 0.0

    tier_rows = (
        await session.execute(
            select(Tickets.ai_tier_used, func.count()).group_by(Tickets.ai_tier_used)
        )
    ).all()
    tier_counts = {row[0].value: row[1] for row in tier_rows}
    t1 = tier_counts.get(AI_Tier.TIER1_LOCAL_SLM.value, 0)
    t2 = tier_counts.get(AI_Tier.TIER2_CLOUD_LLM.value, 0)
    fb = tier_counts.get(AI_Tier.RULE_FALLBACK.value, 0)

    cost_saved = t1 * max(
        0.0, settings.TIER2_ESTIMATED_COST_USD - settings.TIER1_ESTIMATED_COST_USD
    )
    ai_spend = t1 * settings.TIER1_ESTIMATED_COST_USD + t2 * settings.TIER2_ESTIMATED_COST_USD
    accuracy = round(1.0 - (overrides / total), 4) if total else 1.0

    cat_rows = (
        await session.execute(
            select(
                Tickets.category,
                func.count(),
                func.sum(case((Tickets.is_sla_breached.is_(True), 1), else_=0)),
            ).group_by(Tickets.category)
        )
    ).all()
    by_category = [
        CategoryBucket(category=row[0].value, count=row[1], breached=int(row[2] or 0))
        for row in cat_rows
    ]

    sev_rows = (
        await session.execute(
            select(Tickets.severity, func.count()).group_by(Tickets.severity)
        )
    ).all()
    by_severity = [
        CategoryBucket(category=row[0].value, count=row[1], breached=0) for row in sev_rows
    ]

    week_ago = datetime.utcnow() - timedelta(days=7)
    sla_events = (
        await session.execute(
            select(func.count())
            .select_from(SLAEvents)
            .where(SLAEvents.timestamp >= week_ago, SLAEvents.event_type != "SCHEDULED")
        )
    ).scalar_one() or 0

    summary = AnalyticsSummary(
        total_tickets=total,
        open_tickets=open_count,
        sla_breach_count=breached,
        sla_breach_rate=round((breached / total) * 100, 1) if total else 0.0,
        ai_accuracy_rate=round(accuracy * 100, 1),
        avg_confidence=round(float(avg_conf), 3),
        tier1_count=t1,
        tier2_count=t2,
        rule_fallback_count=fb,
        hitl_override_count=overrides,
        cost_saved_usd=round(cost_saved, 4),
        estimated_ai_spend_usd=round(ai_spend, 4),
    )
    return AnalyticsOverview(
        summary=summary,
        by_category=by_category,
        by_tier=[TierBucket(tier=k, count=v) for k, v in tier_counts.items()],
        by_severity=by_severity,
        sla_events_last_7d=sla_events,
    )


# --------------------------------------------------------------------------- #
# System
# --------------------------------------------------------------------------- #
@system_router.get("/health", response_model=HealthOut)
async def health(session: AsyncSession = Depends(get_async_db_session)):
    db_status = "connected"
    try:
        await session.execute(select(1))
    except Exception:  # noqa: BLE001
        db_status = "unreachable"

    redis_status = "connected"
    try:
        import redis as redis_lib

        client = redis_lib.Redis.from_url(settings.REDIS_URL, socket_connect_timeout=1)
        client.ping()
    except Exception:  # noqa: BLE001
        redis_status = "unreachable"

    return HealthOut(
        status="healthy" if db_status == "connected" else "degraded",
        app=settings.APP_NAME,
        timestamp=datetime.utcnow(),
        database=db_status,
        redis=redis_status,
        tier2_available=settings.has_openai or settings.has_gemini,
    )


@system_router.get("/users", response_model=list[UserOut])
async def list_users(role: Optional[UserRole] = None, session: AsyncSession = Depends(get_async_db_session)):
    stmt = select(Users).order_by(Users.name)
    if role:
        stmt = stmt.where(Users.role == role)
    return [UserOut.model_validate(u) for u in (await session.execute(stmt)).scalars().all()]


@system_router.get("/pii/stats")
async def pii_stats():
    return get_pii_scrubber().get_scrubbing_stats()


@system_router.get("/kb", response_model=list[KBCitation])
async def list_kb(session: AsyncSession = Depends(get_async_db_session)):
    docs = (await session.execute(select(KB_Documents).order_by(KB_Documents.title))).scalars().all()
    return [KBCitation(id=d.id, title=d.title, category=d.category, score=0.0) for d in docs]

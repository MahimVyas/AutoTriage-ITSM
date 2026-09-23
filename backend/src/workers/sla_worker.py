"""Pipeline 4 — async SLA escalation engine on Redis + Celery.

Scheduling: when a ticket is created the API enqueues ``check_sla_deadline``
with a ``countdown`` equal to the severity's SLA budget. Celery keeps the
delayed message in Redis (READY-until-visibility / ETA queue) until the timer
expires.

Execution: the worker reloads the ticket, and if it is *still* OPEN it marks
``is_sla_breached``, bumps severity to P1_CRITICAL, flips status to ESCALATED
and appends an ``sla_events`` audit row.

A periodic ``sweep_sla_deadlines`` (celery beat) task catches tickets whose
deadline passed while the worker/queue was down.
"""

import logging
from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

from celery import Celery

from src.config import settings

logger = logging.getLogger(__name__)

celery_app = Celery(
    "autotriage_sla",
    broker=settings.broker_url,
    backend=settings.result_backend,
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    broker_connection_retry_on_startup=True,
    beat_schedule={
        "sweep-sla-deadlines": {
            "task": "src.workers.sla_worker.sweep_sla_deadlines",
            "schedule": 30.0,  # seconds
        },
    },
)


def sla_window_seconds(severity: str) -> int:
    return int(settings.SLA_DEADLINES.get(severity, settings.SLA_DEADLINES["P4_LOW"]))


def compute_sla_deadline(severity: str, now: Optional[datetime] = None) -> datetime:
    now = now or datetime.utcnow()
    return now + timedelta(seconds=sla_window_seconds(severity))


def schedule_sla_check(ticket_id: UUID | str, severity: str) -> str:
    """Enqueue a delayed SLA check in Redis. Returns the Celery task id."""
    countdown = sla_window_seconds(severity)
    task = check_sla_deadline.apply_async(args=[str(ticket_id)], countdown=countdown)
    logger.info("Scheduled SLA check for ticket %s in %ss (task=%s)", ticket_id, countdown, task.id)
    return task.id


# --------------------------------------------------------------------------- #
# Worker helpers (sync SQLAlchemy — Celery tasks are sync by design)
# --------------------------------------------------------------------------- #
def _session_factory():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from src.database import _normalize_database_url

    url = _normalize_database_url(settings.DATABASE_URL).replace("+asyncpg", "+psycopg2")
    engine = create_engine(url, pool_pre_ping=True, future=True)
    return sessionmaker(bind=engine, expire_on_commit=False)


def _escalate(ticket) -> str:
    """Apply breach semantics to a ticket ORM row (mutates in place)."""
    from src.database import TicketSeverity, TicketStatus

    already_breached = bool(ticket.is_sla_breached)
    ticket.is_sla_breached = True
    ticket.severity = TicketSeverity.P1_CRITICAL
    if ticket.status in (TicketStatus.OPEN, TicketStatus.IN_PROGRESS):
        ticket.status = TicketStatus.ESCALATED
    return (
        f"SLA breached for ticket '{ticket.title}' (was {ticket.sla_deadline}); "
        f"severity escalated to P1_CRITICAL"
        if not already_breached
        else f"SLA re-confirmed breached for ticket '{ticket.title}'"
    )


def _record_event(session, ticket_id, message: str, event_type: str = "BREACH") -> None:
    from src.database import SLAEvents

    session.add(
        SLAEvents(ticket_id=ticket_id, event_type=event_type, message=message)
    )


# --------------------------------------------------------------------------- #
# Tasks
# --------------------------------------------------------------------------- #
@celery_app.task(name="src.workers.sla_worker.check_sla_deadline", bind=True, max_retries=3)
def check_sla_deadline(self, ticket_id: str):
    """Fires when a ticket's SLA timer expires."""
    from src.database import TicketStatus, Tickets, TicketSeverity

    Session = _session_factory()
    with Session() as session:
        ticket = session.get(Tickets, UUID(ticket_id))
        if ticket is None:
            logger.warning("SLA check for unknown ticket %s", ticket_id)
            return {"ticket_id": ticket_id, "result": "missing"}

        if ticket.status not in (TicketStatus.OPEN, TicketStatus.IN_PROGRESS):
            logger.info("SLA check skipped — ticket %s already %s", ticket_id, ticket.status.value)
            return {"ticket_id": ticket_id, "result": "skipped", "status": ticket.status.value}

        if ticket.sla_deadline and ticket.sla_deadline > datetime.utcnow():
            # Deadline moved (e.g. severity downgraded) — reschedule for the remainder
            remaining = (ticket.sla_deadline - datetime.utcnow()).total_seconds()
            check_sla_deadline.apply_async(args=[ticket_id], countdown=max(1, int(remaining)))
            return {"ticket_id": ticket_id, "result": "rescheduled", "remaining_s": int(remaining)}

        message = _escalate(ticket)
        _record_event(session, ticket.id, message, event_type="BREACH")
        session.commit()
        logger.error("SLA BREACH: %s", message)
        return {"ticket_id": ticket_id, "result": "breached"}


@celery_app.task(name="src.workers.sla_worker.sweep_sla_deadlines")
def sweep_sla_deadlines():
    """Safety net: escalate tickets whose deadline already passed."""
    from sqlalchemy import select

    from src.database import TicketSeverity, TicketStatus, Tickets

    now = datetime.utcnow()
    Session = _session_factory()
    with Session() as session:
        overdue = (
            session.execute(
                select(Tickets).where(
                    Tickets.sla_deadline <= now,
                    Tickets.is_sla_breached.is_(False),
                    Tickets.status.in_([TicketStatus.OPEN, TicketStatus.IN_PROGRESS]),
                )
            )
            .scalars()
            .all()
        )
        for ticket in overdue:
            message = _escalate(ticket)
            _record_event(session, ticket.id, message, event_type="SWEEP")
            logger.error("SLA SWEEP BREACH: %s", message)
        session.commit()
        return {"swept": len(overdue)}


@celery_app.task(name="src.workers.sla_worker.escalate_ticket")
def escalate_ticket(ticket_id: str, reason: str = "Manual escalation"):
    """Manual/admin escalation hook used by the API."""
    from src.database import Tickets

    Session = _session_factory()
    with Session() as session:
        ticket = session.get(Tickets, UUID(ticket_id))
        if ticket is None:
            return {"ticket_id": ticket_id, "result": "missing"}
        message = _escalate(ticket)
        _record_event(session, ticket.id, f"{reason}: {message}", event_type="MANUAL")
        session.commit()
        return {"ticket_id": ticket_id, "result": "escalated", "message": message}

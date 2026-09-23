"""SQLAlchemy async models + engine for AutoTriage-ITSM (PostgreSQL + pgvector)."""

import logging
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional

from pgvector.sqlalchemy import Vector
from sqlalchemy import JSON, Boolean, Column, DateTime, Enum, Float, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import UUID as UUIDType
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.orm import DeclarativeBase, relationship, sessionmaker

from src.config import settings

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# Enums (shared across DB + API)
# --------------------------------------------------------------------------- #
class TicketCategory(str, PyEnum):
    HARDWARE = "HARDWARE"
    NETWORK = "NETWORK"
    IAM_ACCESS = "IAM_ACCESS"
    SOFTWARE = "SOFTWARE"
    SECURITY = "SECURITY"
    UNASSIGNED = "UNASSIGNED"


class TicketSeverity(str, PyEnum):
    P1_CRITICAL = "P1_CRITICAL"
    P2_HIGH = "P2_HIGH"
    P3_MEDIUM = "P3_MEDIUM"
    P4_LOW = "P4_LOW"


class TicketStatus(str, PyEnum):
    OPEN = "OPEN"
    IN_PROGRESS = "IN_PROGRESS"
    RESOLVED = "RESOLVED"
    CLOSED = "CLOSED"
    ESCALATED = "ESCALATED"


class AI_Tier(str, PyEnum):
    TIER1_LOCAL_SLM = "TIER1_LOCAL_SLM"
    TIER2_CLOUD_LLM = "TIER2_CLOUD_LLM"
    RULE_FALLBACK = "RULE_FALLBACK"


class UserRole(str, PyEnum):
    EMPLOYEE = "EMPLOYEE"
    AGENT = "AGENT"
    ADMIN = "ADMIN"


class Base(DeclarativeBase):
    """Declarative base for all models."""


# --------------------------------------------------------------------------- #
# Tables
# --------------------------------------------------------------------------- #
class Users(Base):
    """User management table."""

    __tablename__ = "users"

    id = Column(UUIDType(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, nullable=False)
    role = Column(Enum(UserRole, name="user_role", native_enum=True), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    created_tickets = relationship(
        "Tickets", foreign_keys="Tickets.created_by_id", back_populates="created_by"
    )
    assigned_tickets = relationship(
        "Tickets", foreign_keys="Tickets.assigned_agent_id", back_populates="assigned_agent"
    )
    audit_logs = relationship("AIAuditLogs", back_populates="corrected_by_agent")


class Tickets(Base):
    """Ticket lifecycle table."""

    __tablename__ = "tickets"

    id = Column(UUIDType(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title = Column(String, nullable=False)
    raw_description = Column(Text, nullable=False)
    scrubbed_description = Column(Text, nullable=True)

    category = Column(
        Enum(TicketCategory, name="ticket_category", native_enum=True),
        default=TicketCategory.UNASSIGNED,
    )
    subcategory = Column(String, nullable=True)
    severity = Column(
        Enum(TicketSeverity, name="ticket_severity", native_enum=True),
        default=TicketSeverity.P4_LOW,
    )
    status = Column(
        Enum(TicketStatus, name="ticket_status", native_enum=True),
        default=TicketStatus.OPEN,
    )
    confidence_score = Column(Float, default=0.0)
    ai_tier_used = Column(
        Enum(AI_Tier, name="ai_tier", native_enum=True), default=AI_Tier.RULE_FALLBACK
    )

    # Extra AI context surfaced in the agent UI
    ai_summary = Column(Text, nullable=True)
    ai_reasoning = Column(Text, nullable=True)
    troubleshooting_steps = Column(JSON, nullable=True)  # list[str] from the RAG engine

    assigned_agent_id = Column(UUIDType(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_by_id = Column(UUIDType(as_uuid=True), ForeignKey("users.id"), nullable=False)

    created_at = Column(DateTime, default=datetime.utcnow)
    sla_deadline = Column(DateTime, nullable=True)
    is_sla_breached = Column(Boolean, default=False)

    assigned_agent = relationship(
        "Users", foreign_keys=[assigned_agent_id], back_populates="assigned_tickets"
    )
    created_by = relationship(
        "Users", foreign_keys=[created_by_id], back_populates="created_tickets"
    )
    kb_documents = relationship(
        "KB_Documents", secondary="ticket_kb_documents", back_populates="tickets"
    )
    audit_logs = relationship("AIAuditLogs", back_populates="ticket")
    sla_events = relationship("SLAEvents", back_populates="ticket")


class KB_Documents(Base):
    """Knowledge base documents with pgvector embeddings."""

    __tablename__ = "kb_documents"

    id = Column(UUIDType(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    category = Column(String, nullable=False)
    embedding = Column(Vector(settings.VECTOR_DIMENSION), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    tickets = relationship(
        "Tickets", secondary="ticket_kb_documents", back_populates="kb_documents"
    )


class TicketKB_Documents(Base):
    """Which KB runbooks were retrieved for which ticket (RAG provenance)."""

    __tablename__ = "ticket_kb_documents"

    ticket_id = Column(UUIDType(as_uuid=True), ForeignKey("tickets.id"), primary_key=True)
    kb_document_id = Column(UUIDType(as_uuid=True), ForeignKey("kb_documents.id"), primary_key=True)


class AIAuditLogs(Base):
    """HITL correction audit trail."""

    __tablename__ = "ai_audit_logs"

    id = Column(UUIDType(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ticket_id = Column(UUIDType(as_uuid=True), ForeignKey("tickets.id"), nullable=False)

    original_category = Column(String, nullable=False)
    corrected_category = Column(String, nullable=True)

    original_severity = Column(String, nullable=False)
    corrected_severity = Column(String, nullable=True)

    corrected_by_agent_id = Column(UUIDType(as_uuid=True), ForeignKey("users.id"), nullable=True)
    note = Column(Text, nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow)

    ticket = relationship("Tickets", back_populates="audit_logs")
    corrected_by_agent = relationship("Users", back_populates="audit_logs")


class SLAEvents(Base):
    """Escalation events emitted by the async SLA worker."""

    __tablename__ = "sla_events"

    id = Column(UUIDType(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ticket_id = Column(UUIDType(as_uuid=True), ForeignKey("tickets.id"), nullable=False)
    event_type = Column(String, nullable=False, default="SLA_BREACH")  # SCHEDULED | BREACH | ESCALATED
    message = Column(String, nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow)

    ticket = relationship("Tickets", back_populates="sla_events")


# --------------------------------------------------------------------------- #
# Engine / session helpers
# --------------------------------------------------------------------------- #
def _normalize_database_url(url: str) -> str:
    """Force an asyncpg DSN regardless of what the user passed."""
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+asyncpg://", 1)
    return url


engine: AsyncEngine = create_async_engine(
    _normalize_database_url(settings.DATABASE_URL),
    pool_size=settings.DATABASE_POOL_SIZE,
    max_overflow=settings.DATABASE_MAX_OVERFLOW,
    echo=False,
    future=True,
)

async_session_maker = sessionmaker(
    engine, class_=AsyncSession, expire_on_commit=False
)


async def init_database() -> None:
    """Create the pgvector extension (best effort) and all tables."""
    logger.info("Initializing database")
    try:
        async with engine.begin() as conn:
            try:
                await conn.execute(
                    __import__("sqlalchemy").text("CREATE EXTENSION IF NOT EXISTS vector")
                )
            except Exception as ext_exc:  # non-Postgres dev backend (e.g. sqlite)
                logger.warning("Could not enable pgvector extension: %s", ext_exc)
            await conn.run_sync(Base.metadata.create_all)
        logger.info("Database initialized successfully")
    except Exception as exc:  # pragma: no cover - infra dependent
        logger.error("Database initialization failed: %s", exc)
        raise


@asynccontextmanager
async def get_db():
    """Async session context manager that commits on success."""
    async with async_session_maker() as session:
        try:
            yield session
            await session.commit()
        except Exception as exc:
            await session.rollback()
            logger.error("Database session error: %s", exc)
            raise
        finally:
            await session.close()


async def get_async_db_session():
    """FastAPI dependency yielding an committed session."""
    async with get_db() as session:
        yield session


async def close_database() -> None:
    logger.info("Closing database connection pool")
    await engine.dispose()

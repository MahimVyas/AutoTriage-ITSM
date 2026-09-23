"""Pydantic v2 schemas: strict structured outputs for AI + API contracts."""

from datetime import datetime
from typing import List, Optional, Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator

from src.database import AI_Tier, TicketCategory, TicketSeverity, TicketStatus, UserRole


# --------------------------------------------------------------------------- #
# Pipeline 2 — strict structured output for the tiered classifier
# --------------------------------------------------------------------------- #
class TicketClassificationResponse(BaseModel):
    """Schema enforced on every classifier tier (Tier 1, Tier 2 and fallback)."""

    category: TicketCategory
    subcategory: str = Field(default="", description="Narrower slice of the category")
    severity: TicketSeverity
    confidence_score: float = Field(ge=0.0, le=1.0)
    reasoning: str
    summary: str
    ai_tier_used: AI_Tier = AI_Tier.RULE_FALLBACK

    @field_validator("confidence_score", mode="before")
    @classmethod
    def _clamp_confidence(cls, v):
        try:
            f = float(v)
        except (TypeError, ValueError):
            return 0.0
        return max(0.0, min(1.0, f))

    @field_validator("subcategory", mode="before")
    @classmethod
    def _coerce_subcategory(cls, v):
        return "" if v is None else str(v)


class TroubleshootingSteps(BaseModel):
    """Strict shape requested from the LLM in the RAG pipeline."""

    steps: List[str] = Field(min_length=1, max_length=5)


# --------------------------------------------------------------------------- #
# API contracts
# --------------------------------------------------------------------------- #
class UserOut(BaseModel):
    id: UUID
    name: str
    email: str
    role: UserRole

    model_config = {"from_attributes": True}


class TicketCreate(BaseModel):
    title: str = Field(min_length=3, max_length=200)
    raw_description: str = Field(min_length=10, max_length=5000)
    created_by_id: Optional[UUID] = None
    created_by_email: Optional[str] = None


class KBCitation(BaseModel):
    id: UUID
    title: str
    category: str
    score: float = 0.0

    model_config = {"from_attributes": True}


class TicketOut(BaseModel):
    id: UUID
    title: str
    raw_description: str
    scrubbed_description: Optional[str]
    category: TicketCategory
    subcategory: Optional[str]
    severity: TicketSeverity
    status: TicketStatus
    confidence_score: float
    ai_tier_used: AI_Tier
    ai_summary: Optional[str]
    ai_reasoning: Optional[str]
    troubleshooting_steps: Optional[List[str]]
    assigned_agent_id: Optional[UUID]
    created_by_id: UUID
    created_at: datetime
    sla_deadline: Optional[datetime]
    is_sla_breached: bool

    assigned_agent: Optional[UserOut] = None
    created_by: Optional[UserOut] = None
    kb_citations: List[KBCitation] = []

    model_config = {"from_attributes": True}


class TicketUpdate(BaseModel):
    status: Optional[TicketStatus] = None
    assigned_agent_id: Optional[UUID] = None
    priority_note: Optional[str] = None


class HITLOverrideRequest(BaseModel):
    """One-click agent correction — logged into ai_audit_logs."""

    agent_id: UUID
    category: Optional[TicketCategory] = None
    severity: Optional[TicketSeverity] = None
    note: Optional[str] = None

    @model_validator(mode="after")
    def _at_least_one_change(self):
        if self.category is None and self.severity is None:
            raise ValueError("Provide at least a category or a severity to override")
        return self


class AuditLogOut(BaseModel):
    id: UUID
    ticket_id: UUID
    original_category: str
    corrected_category: Optional[str]
    original_severity: str
    corrected_severity: Optional[str]
    corrected_by_agent_id: Optional[UUID]
    note: Optional[str]
    timestamp: datetime

    model_config = {"from_attributes": True}


class SLAEventOut(BaseModel):
    id: UUID
    ticket_id: UUID
    event_type: str
    message: Optional[str]
    timestamp: datetime

    model_config = {"from_attributes": True}


class TicketDetailOut(TicketOut):
    audit_logs: List[AuditLogOut] = []
    sla_events: List[SLAEventOut] = []


class TicketListOut(BaseModel):
    total: int
    items: List[TicketOut]


# --------------------------------------------------------------------------- #
# Analytics
# --------------------------------------------------------------------------- #
class AnalyticsSummary(BaseModel):
    total_tickets: int
    open_tickets: int
    sla_breach_count: int
    sla_breach_rate: float
    ai_accuracy_rate: float
    avg_confidence: float
    tier1_count: int
    tier2_count: int
    rule_fallback_count: int
    hitl_override_count: int
    cost_saved_usd: float
    estimated_ai_spend_usd: float


class CategoryBucket(BaseModel):
    category: str
    count: int
    breached: int


class TierBucket(BaseModel):
    tier: str
    count: int


class AnalyticsOverview(BaseModel):
    summary: AnalyticsSummary
    by_category: List[CategoryBucket]
    by_tier: List[TierBucket]
    by_severity: List[CategoryBucket]
    sla_events_last_7d: int


class HealthOut(BaseModel):
    status: Literal["healthy", "degraded"]
    app: str
    timestamp: datetime
    database: str
    redis: str
    tier2_available: bool

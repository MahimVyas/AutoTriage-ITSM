from pydantic_settings import BaseSettings
from typing import Optional, List


class Settings(BaseSettings):
    """Application settings (env-overridable via .env)."""

    # ------------------------------------------------------------------ #
    # Application
    # ------------------------------------------------------------------ #
    APP_NAME: str = "AutoTriage-ITSM"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    LOG_LEVEL: str = "INFO"

    # ------------------------------------------------------------------ #
    # Database (PostgreSQL + pgvector)
    # ------------------------------------------------------------------ #
    DATABASE_URL: str = "postgresql+asyncpg://autouser:autopass@localhost:5432/autotriage"
    DATABASE_POOL_SIZE: int = 10
    DATABASE_MAX_OVERFLOW: int = 20

    # ------------------------------------------------------------------ #
    # Redis / Celery
    # ------------------------------------------------------------------ #
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_PASSWORD: Optional[str] = None
    CELERY_BROKER_URL: Optional[str] = None   # defaults to REDIS_URL
    CELERY_RESULT_BACKEND: Optional[str] = None

    # ------------------------------------------------------------------ #
    # AI / LLM
    # ------------------------------------------------------------------ #
    OPENAI_API_KEY: Optional[str] = None
    OPENAI_MODEL: str = "gpt-4o-mini"
    OPENAI_EMBEDDING_MODEL: str = "text-embedding-3-small"
    OPENAI_MAX_TOKENS: int = 1000

    GOOGLE_GEMINI_API_KEY: Optional[str] = None
    GOOGLE_GEMINI_MODEL: str = "gemini-1.5-flash"

    # ------------------------------------------------------------------ #
    # Vector / RAG
    # ------------------------------------------------------------------ #
    VECTOR_DIMENSION: int = 1536
    VECTOR_SIMILARITY_THRESHOLD: float = 0.3
    KB_SEARCH_K: int = 5

    # ------------------------------------------------------------------ #
    # PII scrubbing
    # ------------------------------------------------------------------ #
    PII_REDACTION_TOKEN: str = "[REDACTED_SENSITIVE_DATA]"
    PII_REDACTION_PATTERNS: List[str] = [
        r"\b\d{3}-\d{2}-\d{4}\b",                                  # SSN
        r"\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b",             # Credit card
        r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",      # Email
        r"\b\d{1,3}(?:\.\d{1,3}){3}\b",                             # IPv4
        r"(?:password|passwd|pwd)\s*[=:]\s*\S+",                    # Password
        r"\b(?:api[_-]?key|secret|token)\s*[=:]\s*\S+",             # API key / token
    ]

    # ------------------------------------------------------------------ #
    # SLA configuration (seconds)
    # ------------------------------------------------------------------ #
    SLA_DEADLINES: dict = {
        "P1_CRITICAL": 900,    # 15 minutes
        "P2_HIGH": 3600,       # 1 hour
        "P3_MEDIUM": 14400,    # 4 hours
        "P4_LOW": 86400,       # 24 hours
    }

    # ------------------------------------------------------------------ #
    # Tiered classification
    # ------------------------------------------------------------------ #
    CONFIDENCE_THRESHOLD: float = 0.85
    HIGH_RISK_CATEGORY: str = "SECURITY"
    T1_MAX_TOKENS: int = 100
    T2_MAX_TOKENS: int = 1000

    # Estimated per-call model costs used for the "cost saved" KPI
    TIER2_ESTIMATED_COST_USD: float = 0.004
    TIER1_ESTIMATED_COST_USD: float = 0.0002

    RATE_LIMIT_PER_MINUTE: int = 60

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #
    @property
    def broker_url(self) -> str:
        return self.CELERY_BROKER_URL or self.REDIS_URL

    @property
    def result_backend(self) -> str:
        return self.CELERY_RESULT_BACKEND or self.REDIS_URL

    @property
    def has_openai(self) -> bool:
        return bool(self.OPENAI_API_KEY)

    @property
    def has_gemini(self) -> bool:
        return bool(self.GOOGLE_GEMINI_API_KEY)

    model_config = {"env_file": ".env", "case_sensitive": False, "extra": "ignore"}


settings = Settings()

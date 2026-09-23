# AutoTriage-ITSM Backend

Enterprise AI-Augmented ITSM Ticketing & SLA Escalation Platform

## Overview

AutoTriage-ITSM is a comprehensive enterprise solution for IT service management with AI-powered ticket classification, automated SLA escalation, and human-in-the-loop workflows.

## Key Features

### 1. Automated PII Scrubbing
- Regex-based sanitization of sensitive data (SSNs, credit cards, passwords, IPs)
- Real-time content filtering before AI processing

### 2. Tiered AI Classification
- **Tier 1**: Fast local keyword matching and rule-based classification
- **Tier 2**: LLM-powered structured outputs via OpenAI/Gemini
- Confidence scoring with fallback mechanisms

### 3. Hybrid RAG Engine
- Combines pgvector similarity search with BM25 for troubleshooting guidance
- Integrates knowledge base documents with vector embeddings
- Generates concise agent troubleshooting steps

### 4. Async SLA Escalation Engine
- Redis-based delayed task execution
- Automatic ticket escalation on deadline breach
- Real-time status monitoring and updates

### 5. Human-in-the-Loop (HITL) Override
- Agent correction system with audit logging
- Real-time ticket modification capabilities
- Full traceability of manual interventions

### 6. Role-Based Access Control
- Employee ticket submission
- Support agent dashboard with HITL controls
- Admin analytics and monitoring

## Technical Architecture

### Database Schema
- `users`: User management with roles
- `tickets`: Ticket lifecycle with SLA tracking
- `kb_documents`: Knowledge base with vector embeddings
- `ai_audit_logs`: HITL activity tracking

### Backend Stack
- **Framework**: FastAPI (async/await)
- **Database**: PostgreSQL + pgvector
- **Queue**: Redis + Celery
- **AI**: OpenAI/Gemini via LangChain
- **Security**: Pydantic validation, structured outputs

### API Endpoints (all prefixed `/api`)

#### Ticket Management
- `POST /api/tickets`: create a ticket (PII scrub → tiered classification → hybrid RAG → SLA scheduling)
- `GET /api/tickets`: list tickets, filter by `category`, `severity`, `status`, `sla=breached|at_risk|ok`, `q`
- `GET /api/tickets/{id}`: detail incl. AI reasoning, scrubbed text, RAG steps, audit + SLA events
- `PATCH /api/tickets/{id}`: update status / assign an L1 agent
- `POST /api/tickets/{id}/escalate`: enqueue a manual escalation
- `POST /api/tickets/{id}/troubleshooting`: re-run the hybrid RAG engine

#### HITL Operations
- `POST /api/tickets/{id}/override`: agent category/severity correction → `ai_audit_logs`
- `GET /api/tickets/{id}/audit`: audit trail for a ticket

#### Analytics
- `GET /api/analytics/overview`: KPIs + category/tier/severity distributions

#### System
- `GET /api/health`: database / Redis / Tier-2 availability
- `GET /api/users?role=AGENT`: role directory
- `GET /api/pii/stats`, `GET /api/kb`: scrubber patterns and knowledge base

## Database Migration

Use Alembic for database schema management:

```bash
# Initialize migrations
alembic init migrations

# Generate new migration
alembic revision --autogenerate -m "Migration description"

# Apply migrations
alembic upgrade head

# Downgrade
alembic downgrade base
```

## Environment Variables

Create a `.env` file in the backend directory:

```env
DATABASE_URL=postgresql+asyncpg://autouser:autopass@localhost:5432/autotriage
REDIS_URL=redis://:redispass@localhost:6379/0
OPENAI_API_KEY=your_openai_api_key          # optional
GOOGLE_GEMINI_API_KEY=your_gemini_api_key   # optional
ENVIRONMENT=development
```

## Development Setup

### Prerequisites
- Python 3.11+
- Docker and Docker Compose
- Node 20+ (for the frontend)

### Quick Start (recommended — everything in Docker)

```bash
# from the repository root
docker compose up --build
```

This starts:

| Service    | Port | What it runs                                             |
|------------|------|----------------------------------------------------------|
| postgres   | 5432 | `pgvector/pgvector:pg16` + `CREATE EXTENSION vector`      |
| redis      | 6379 | broker for the delayed SLA tasks + Celery beat            |
| backend    | 8000 | `python seed.py` then `uvicorn src.main:app`              |
| worker     | —    | `celery -A src.workers.sla_worker.celery_app worker`      |
| beat       | —    | SLA deadline sweeper (every 30 s)                         |
| frontend   | 5173 | Vite dev server (proxies `/api` → backend)                |

Open **http://localhost:5173** for the UI and **http://localhost:8000/docs** for OpenAPI.

### Manual (local) setup

1. Infrastructure only:
   ```bash
   docker compose up -d postgres redis
   ```

2. Install Python dependencies:
   ```bash
   cd backend && pip install -r requirements.txt
   ```

3. Seed demo data (users, 7 KB runbooks, 14 historical tickets, audit logs):
   ```bash
   python seed.py          # add --reset to wipe first
   ```
   Tables are created automatically at API startup (`Base.metadata.create_all`);
   Alembic is wired up if you prefer versioned migrations:
   ```bash
   alembic revision --autogenerate -m "initial schema"
   alembic upgrade head
   ```

4. Start the API:
   ```bash
   cd backend && uvicorn src.main:app --reload
   ```

5. Start the Celery SLA worker (+ optional beat sweeper):
   ```bash
   celery -A src.workers.sla_worker.celery_app worker --loglevel=info
   celery -A src.workers.sla_worker.celery_app beat --loglevel=info
   ```

6. Frontend:
   ```bash
   cd frontend && npm install && npm run dev
   ```

## Testing

Offline smoke tests (no Postgres/Redis/API keys needed):
```bash
cd backend && python tests/test_smoke.py   # or: pytest -v
```

## Docker Build

Build the Docker image:
```bash
docker build -t autotriage-backend ./backend
```

Run with Docker:
```bash
docker run -p 8000:8000 --env-file ./backend/.env autotriage-backend
```

## License

MIT
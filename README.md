# AutoTriage-ITSM

**Enterprise AI-Augmented ITSM Ticketing & SLA Escalation Platform.**

AutoTriage-ITSM takes an employee's free-text incident report and runs it through a full
production-shaped pipeline: PII redaction → tiered AI classification with strict Pydantic
JSON schemas → hybrid RAG (pgvector + BM25) troubleshooting guidance → an async
Redis/Celery SLA escalation engine, with a one-click human-in-the-loop override
recorded in `ai_audit_logs` — surfaced through three role-based dashboards.

## Feature map

| # | Feature | Where |
|---|---------|-------|
| 1 | Automated PII scrubbing before AI processing | `backend/src/services/pii_scrubber.py` (regex → `[REDACTED_SENSITIVE_DATA]`) |
| 2 | Tiered AI classification + strict Pydantic schema | `backend/src/services/ai_classifier.py`, `backend/src/schemas.py` |
| 3 | Hybrid RAG (pgvector cosine + BM25, RRF fusion) | `backend/src/services/rag_engine.py`, `embeddings.py` |
| 4 | Async SLA escalation on Redis | `backend/src/workers/sla_worker.py` (Celery countdown + beat sweeper) |
| 5 | HITL override with audit log | `POST /api/tickets/{id}/override` → `ai_audit_logs` |
| 6 | Role-based dashboards | `frontend/src/views/{EmployeeView,AgentDashboard,AdminAnalytics}.jsx` |
| 7 | Tech Stack modal with animated flow diagram | Navbar **Tech Stack** button → `components/TechStackModal.jsx` (hoverable blocks, marching-ant edges, travelling packets) |
| 8 | Light / dark mode | Navbar toggle → `dark` class on `<html>`, CSS-variable tokens in `index.css`, persisted in `localStorage` |

### Tiered classification rules
- **Tier 1 — local SLM / keyword rules**: instant, free, returns `category`, `severity`, `confidence_score`.
- **Tier 2 — cloud LLM**: invoked when Tier-1 confidence `< 0.85` **or** the category is `SECURITY`;
  uses OpenAI `gpt-4o-mini` (or Gemini 1.5 Flash) structured JSON output validated by Pydantic.
- **Rule fallback**: deterministic classifier so the prototype runs with no API keys.

### SLA windows (enforced by the worker)
`P1_CRITICAL` 15 min · `P2_HIGH` 1 h · `P3_MEDIUM` 4 h · `P4_LOW` 24 h.
On expiry with the ticket still `OPEN`: `is_sla_breached = True`, severity → `P1_CRITICAL`,
status → `ESCALATED`, event logged to `sla_events`.

## File tree

```
AutoTriage-ITSM/
├── docker-compose.yml            # dev stack: postgres(pgvector) · redis · backend · worker · beat · frontend
├── docker-compose.prod.yml       # production stack: no bind mounts, nginx static UI, internal DB/queue
├── .github/workflows/ci.yml      # CI: smoke tests + vite build + full prod stack boot check
├── .github/workflows/pages.yml   # deploys the static demo build to GitHub Pages
├── .env.example                  # optional LLM keys
├── backend/
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── requirements.txt
│   ├── pyproject.toml
│   ├── alembic.ini
│   ├── seed.py                   # python seed.py [--reset]
│   ├── initdb/001_extensions.sql # CREATE EXTENSION vector
│   ├── migrations/               # alembic env + versions/
│   ├── tests/test_smoke.py       # offline smoke tests
│   └── src/
│       ├── main.py               # FastAPI app
│       ├── config.py             # settings (env-driven)
│       ├── database.py           # SQLAlchemy async models (users, tickets, kb_documents, ai_audit_logs, sla_events)
│       ├── schemas.py            # Pydantic v2 schemas (incl. TicketClassificationResponse)
│       ├── api/endpoints.py      # /api/tickets, /api/analytics, /api/health …
│       ├── services/
│       │   ├── pii_scrubber.py   # Pipeline 1
│       │   ├── ai_classifier.py  # Pipeline 2 (Tier 1 → Tier 2 → fallback)
│       │   ├── embeddings.py     # OpenAI embeddings w/ deterministic local fallback
│       │   └── rag_engine.py     # Pipeline 3 (pgvector + BM25 + RRF + 3 steps)
│       └── workers/sla_worker.py # Pipeline 4 (Celery/Redis delayed tasks)
└── frontend/                     # React + Vite + Tailwind + Lucide + shadcn-style UI
    ├── Dockerfile                # dev (vite dev server, HMR)
    ├── Dockerfile.prod           # multi-stage: npm ci → vite build → nginx
    ├── nginx.conf                # serves dist + proxies /api, /docs → FastAPI
    └── src/
        ├── App.jsx               # role switcher: Employee / Agent / Admin + dark mode
        ├── lib/api.js            # API client (routes to demoApi when VITE_DEMO=true)
        ├── lib/demoApi.js        # in-browser demo backend for the GitHub Pages build
        ├── components/
        │   ├── ui/               # button, badge, card, input, tabs, dialog (shadcn-style)
        │   └── TicketDetailModal.jsx   # AI confidence, raw vs scrubbed, RAG steps, HITL override
        └── views/
            ├── EmployeeView.jsx        # submission + live pipeline indicator
            ├── AgentDashboard.jsx      # filterable queue + detail modal
            └── AdminAnalytics.jsx      # KPI cards + bar/pie charts
```

## Quick start

### One script (easiest)

```bash
./start.sh              # full stack in Docker, waits for health, prints URLs
./start.sh --status     # what is running
./start.sh --logs       # tail all logs
./start.sh --test       # backend smoke tests + frontend build check
./start.sh --stop       # shut everything down
./start.sh --reset      # wipe databases/volumes and re-seed from scratch
./start.sh --local      # infra in Docker, backend/frontend run on your machine
```

The script auto-detects Docker (and offers to start Docker Desktop), auto-seeds the
database on first boot, waits until the API is healthy, and prints the URLs to open.

### Plain Docker

```bash
docker compose up --build
# UI   → http://localhost:5173
# API  → http://localhost:8000/docs
```

No LLM keys required: the backend seeds itself and falls back to deterministic
classification/RAG. Add `OPENAI_API_KEY` or `GOOGLE_GEMINI_API_KEY` to the root
`.env` to switch on Tier-2 cloud classification and LLM-written troubleshooting steps.

### Local development

```bash
docker compose up -d postgres redis
cd backend  && pip install -r requirements.txt && python seed.py
uvicorn src.main:app --reload                                  # terminal 1
celery -A src.workers.sla_worker.celery_app worker --loglevel=info   # terminal 2
cd ../frontend && npm install && npm run dev                   # terminal 3
```

### Verify

```bash
cd backend && python tests/test_smoke.py   # 10 offline tests
cd frontend && npx vite build              # production build check
```

## Try the demo flow

1. **Employee tab** — paste a description containing an SSN, card number, IP and
   password; submit and watch the four pipeline stages complete. The response shows
   what was redacted, which AI tier ran, the confidence, and the 3 RAG steps.
2. **Support Agent tab** — filter by priority/category/SLA, open a ticket, inspect
   raw vs scrubbed text, then use **HITL override** to correct category/severity —
   the correction lands in `ai_audit_logs` and the SLA window is rescheduled.
3. **Admin tab** — KPI cards (total, breach rate, AI accuracy, cost saved via
   Tier-1), bar chart by category, pie chart of Tier-1 vs Tier-2 distribution.
4. **SLA escalation** — create a P1 (15 min) ticket and leave it `OPEN`: the Celery
   worker fires from Redis at the deadline, breaches it, bumps it to `P1_CRITICAL`
   and writes an `sla_events` row (the beat sweeper backstops anything missed).
5. **Tech Stack button (navbar)** — opens the architecture modal: an animated
   request-flow diagram (colour-coded edges, marching dashes, travelling packets).
   Hover any block to see what it does and the technology behind it, plus a
   full tech-stack breakdown by layer.
6. **Dark mode** — the moon/sun button in the navbar flips the whole app to dark;
   the choice is saved and restored on reload.

## Deployment

The repo is deployment-ready: production Docker images, a hardened compose stack and a
CI pipeline that boots the full stack on every push.

### Production (any Docker host / VPS)

```bash
docker compose -f docker-compose.prod.yml up -d --build

# UI    → http://localhost:5173            (UI_PORT)
# API   → http://localhost:8000/docs       (API_PORT)
# health→ http://localhost:5173/api/health
```

What changes vs the dev stack:

| Concern | Production behaviour |
|---------|----------------------|
| Frontend | Multi-stage build (`npm ci` → `vite build`) served by **nginx**, SPA fallback + immutable asset caching |
| API proxy | nginx forwards `/api`, `/docs`, `/openapi.json` → FastAPI (same-origin, no CORS needed) |
| Bind mounts | **None** — app code lives in the images; data persists in named volumes |
| Postgres / Redis | **No published ports** — reachable only on the internal compose network |
| Backend | Runs with `--workers 2` and a `/api/health` healthcheck; UI waits for it |
| Credentials | Override via env: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `UI_PORT`, `API_PORT` |
| LLM keys | Optional: `OPENAI_API_KEY` / `GOOGLE_GEMINI_API_KEY` (rule fallback keeps it working keyless) |

Put it behind TLS by pointing your reverse proxy (Caddy/Traefik/cloud LB) at the
`frontend` (80) and `backend` (8000) ports, or set `UI_PORT=80`.

### GitHub Pages (live static demo)

Every push to `main` also runs `.github/workflows/pages.yml`, which builds the
frontend with `VITE_DEMO=true` and deploys it to:

**https://mahimvyas.github.io/AutoTriage-ITSM/**

Static hosting has no FastAPI/Postgres, so demo builds route the API client to
`frontend/src/lib/demoApi.js` — an **in-browser implementation of the exact same
API contract** (regex PII scrub → tiered classify → runbook steps → SLA windows,
seeded with the same 14 demo tickets). The header shows an amber
*Demo mode · in-memory* pill so it's clear you're looking at the static demo.
Run `./start.sh` locally for the real full-stack experience.

> One-time repo setting: **Settings → Pages → Source: GitHub Actions**.

### CI / CD (GitHub Actions)

`.github/workflows/ci.yml` runs on every push/PR to `main`:

1. **backend-tests** — 10 offline smoke tests on Python 3.11 (SQLite, no keys)
2. **frontend-build** — production `vite build` on Node 20
3. **docker-images** — validates both compose files, builds the production images,
   boots the full stack and curls `/api/health` through the nginx proxy

To ship to a cloud later, add a registry push step (GHCR/ECR) to the `docker-images`
job and a `docker compose up -d` on the target host — the compose file needs no changes.

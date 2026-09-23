"""AutoTriage-ITSM — FastAPI application entrypoint."""

import logging
from contextlib import asynccontextmanager

from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI

from src.api.endpoints import analytics_router, system_router, tickets_router
from src.config import settings
from src.database import close_database, init_database

logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("autotriage")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting %s API", settings.APP_NAME)
    await init_database()
    yield
    logger.info("Shutting down %s API", settings.APP_NAME)
    await close_database()


app = FastAPI(
    title=settings.APP_NAME,
    description="Enterprise AI-Augmented ITSM Ticketing & SLA Escalation Platform",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(tickets_router)
app.include_router(analytics_router)
app.include_router(system_router)


@app.get("/")
async def root():
    return {
        "name": settings.APP_NAME,
        "version": "0.1.0",
        "description": "Enterprise AI-Augmented ITSM Ticketing & SLA Escalation Platform",
        "docs": "/docs",
        "health": "/api/health",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("src.main:app", host=settings.HOST, port=settings.PORT, reload=True)

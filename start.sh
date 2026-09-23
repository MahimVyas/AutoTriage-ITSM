#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# AutoTriage-ITSM — one-script startup
#
#   ./start.sh              Full stack in Docker (recommended)
#   ./start.sh --local      Infra in Docker, backend/frontend on your machine
#   ./start.sh --status     Show what is running
#   ./start.sh --logs       Tail all logs (Ctrl-C to stop tailing)
#   ./start.sh --test       Run backend smoke tests + frontend build check
#   ./start.sh --stop       Stop everything
#   ./start.sh --reset      Stop, wipe databases/volumes, re-seed from scratch
#   ./start.sh --help       This help
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")"

API_URL="http://localhost:8000"
UI_URL="http://localhost:5173"
RUN_DIR=".run"
HEALTH_TIMEOUT=120

# ----------------------------------------------------------------- colors --
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
else
  C_RESET=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BOLD=""; C_DIM=""
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s▶%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

banner() {
  printf '%s' "$C_BOLD"
  cat <<'EOF'
  _                    ___    _____ _____
 / \   __ _  ___ _ _  |_ _|  |_   _| ____|
/ _ \ / _` |/ _ \ ' \  | |     | | |  _|
/ ___ \ (_| |  __/ |_| | |     | | | |___
/_/   \__, |\___|_\_,_|___|    |_| |_____|
      |___/      AI-Augmented ITSM · one-shot starter
EOF
  printf '%s\n' "$C_RESET"
}

# ------------------------------------------------------------ preflight ----
have() { command -v "$1" >/dev/null 2>&1; }

# Prefer a Python the backend supports (3.11–3.13); fall back to python3.
pick_python() {
  local cand
  for cand in python3.11 python3.12 python3.13 python3; do
    if have "$cand" && "$cand" -c 'import sys; raise SystemExit(0 if (3,11) <= sys.version_info[:2] <= (3,13) else 1)' 2>/dev/null; then
      echo "$cand"
      return 0
    fi
  done
  # Last resort: any python3 (may not have wheels for every dep)
  have python3 && { echo python3; return 0; }
  return 1
}

compose() {
  # `docker compose` (v2) preferred, `docker-compose` (v1) fallback
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif have docker-compose; then
    docker-compose "$@"
  else
    die "Docker Compose not found. Install Docker Desktop: https://docs.docker.com/get-docker/"
  fi
}

need_docker() {
  have docker || die "Docker is not installed. Install Docker Desktop first:
    brew install --cask docker   # macOS
    https://docs.docker.com/get-docker/"
  if ! docker info >/dev/null 2>&1; then
    warn "Docker daemon is not running — attempting to start Docker Desktop..."
    if have open; then open -a Docker; elif have docker-desktop; then docker-desktop; fi
    for i in $(seq 1 30); do
      docker info >/dev/null 2>&1 && break
      sleep 2
    done
    docker info >/dev/null 2>&1 || die "Docker daemon did not start. Open Docker Desktop and re-run."
  fi
  compose version >/dev/null 2>&1 || die "Docker Compose plugin missing — update Docker Desktop."
}

wait_for_url() { # url, name, timeout_seconds
  local url="$1" name="$2" timeout="${3:-60}" i=0
  printf '  waiting for %-10s' "$name"
  while [ "$i" -lt "$timeout" ]; do
    if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
      printf '\r  waiting for %-10s %sready%s\n' "$name" "$C_GREEN" "$C_RESET"
      return 0
    fi
    printf '.'
    sleep 1
    i=$((i + 1))
  done
  printf '\r  waiting for %-10s %sTIMED OUT%s\n' "$name" "$C_RED" "$C_RESET"
  return 1
}

print_urls() {
  printf '\n%s  AutoTriage-ITSM is up%s\n' "$C_BOLD" "$C_RESET"
  cat <<EOF
    Frontend  →  $UI_URL
    API docs  →  $API_URL/docs
    Health    →  $API_URL/api/health
    Database  →  postgresql://autouser:autopass@localhost:5432/autotriage
    Redis     →  redis://:redispass@localhost:6379

${C_DIM}    Useful:
      ./start.sh --status    what is running
      ./start.sh --logs      tail logs
      ./start.sh --test      run the test suite
      ./start.sh --reset     wipe data and re-seed
      ./start.sh --stop      shut everything down${C_RESET}
EOF
}

# ----------------------------------------------------------------- modes ---
cmd_up() {
  banner
  need_docker
  step "Starting the full stack (postgres + redis + api + worker + beat + ui)..."
  compose up --build -d
  ok "Containers launched."

  step "Waiting for services..."
  wait_for_url "$API_URL/api/health" "API" "$HEALTH_TIMEOUT" || {
    warn "API did not become healthy in time — last logs:"
    compose logs --tail=40 backend || true
    die "Startup failed."
  }
  wait_for_url "$UI_URL" "UI" 90 || warn "Frontend not reachable yet — try: ./start.sh --logs"

  ok "Backend seeded and healthy."
  print_urls
}

cmd_local() {
  banner
  need_docker
  local ROOT VPY
  ROOT="$(pwd)"
  step "Starting infrastructure only (postgres + redis)..."
  compose up -d postgres redis

  if [ ! -d backend/.venv ]; then
    local PYBIN
    PYBIN="$(pick_python)" || die "No Python 3.11+ found. Install Python first."
    step "Creating Python virtualenv with $PYBIN..."
    "$PYBIN" -m venv backend/.venv
  fi
  VPY="$ROOT/backend/.venv/bin/python"
  [ -x "$VPY" ] || die "Virtualenv is broken — delete backend/.venv and re-run."

  step "Installing Python dependencies (first run only)..."
  "$VPY" -m pip install --quiet --upgrade pip
  "$VPY" -m pip install --quiet -r backend/requirements.txt ||
    die "Dependency install failed. Try manually: pip install -r backend/requirements.txt"

  local DB_URL="postgresql+asyncpg://autouser:autopass@localhost:5432/autotriage"
  step "Seeding database..."
  (cd backend && DATABASE_URL="$DB_URL" "$VPY" seed.py)

  mkdir -p "$RUN_DIR"
  step "Starting API (uvicorn) on :8000..."
  (cd backend && DATABASE_URL="$DB_URL" "$VPY" -m uvicorn src.main:app --host 0.0.0.0 --port 8000 \
    >"$ROOT/$RUN_DIR/api.log" 2>&1 &
   echo $! >"$ROOT/$RUN_DIR/api.pid")

  step "Starting Celery SLA worker..."
  (cd backend && DATABASE_URL="$DB_URL" "$VPY" -m celery -A src.workers.sla_worker.celery_app worker \
    --loglevel=info >"$ROOT/$RUN_DIR/worker.log" 2>&1 &
   echo $! >"$ROOT/$RUN_DIR/worker.pid")

  step "Starting frontend (Vite) on :5173..."
  if [ ! -d frontend/node_modules ]; then
    (cd frontend && npm install)
  fi
  (cd frontend && npm run dev >"$ROOT/$RUN_DIR/ui.log" 2>&1 &
   echo $! >"$ROOT/$RUN_DIR/ui.pid")

  wait_for_url "$API_URL/api/health" "API" 60 || { tail -20 "$RUN_DIR/api.log"; die "API failed to start (see $RUN_DIR/api.log)"; }
  wait_for_url "$UI_URL" "UI" 60 || warn "UI not reachable yet — see $RUN_DIR/ui.log"

  ok "Local stack running (logs in .run/)."
  print_urls
}

cmd_status() {
  printf '%sServices%s\n' "$C_BOLD" "$C_RESET"
  if have docker && docker info >/dev/null 2>&1; then
    compose ps 2>/dev/null || true
  else
    say "  (docker not running)"
  fi
  printf '\n%sHealth%s\n' "$C_BOLD" "$C_RESET"
  if curl -fsS --max-time 2 "$API_URL/api/health" 2>/dev/null; then printf '\n'; else say "  API: not responding"; fi
  if curl -fsS -o /dev/null --max-time 2 "$UI_URL" 2>/dev/null; then
    say "  UI:  up ($UI_URL)"
  else
    say "  UI:  not responding"
  fi
  if [ -d "$RUN_DIR" ]; then
    printf '\n%sLocal processes%s\n' "$C_BOLD" "$C_RESET"
    for f in "$RUN_DIR"/*.pid; do
      [ -e "$f" ] || continue
      pid=$(cat "$f")
      name=$(basename "$f" .pid)
      if kill -0 "$pid" 2>/dev/null; then say "  $name: running (pid $pid)"; else say "  $name: stopped"; fi
    done
  fi
}

cmd_logs() {
  need_docker
  compose logs -f --tail=100
}

cmd_test() {
  banner
  local failures=0
  step "Backend smoke tests..."
  if [ -x backend/.venv/bin/python ]; then
    PY=backend/.venv/bin/python
  else
    PY=python3
  fi
  # Auto-provision a venv if the interpreter can't import the app deps
  if ! "$PY" -c "import fastapi, sqlalchemy, pgvector, rank_bm25, celery" 2>/dev/null; then
    local PYBIN
    PYBIN="$(pick_python)" || die "No Python 3.11+ found. Install Python first."
    warn "Backend deps not found for $PY — creating backend/.venv with $PYBIN..."
    "$PYBIN" -m venv backend/.venv ||
      die "Could not create a virtualenv. Install Python 3.11+ and re-run."
    backend/.venv/bin/python -m pip install --quiet --upgrade pip
    backend/.venv/bin/python -m pip install --quiet -r backend/requirements.txt ||
      die "Dependency install failed. Try manually:  pip install -r backend/requirements.txt"
    PY=backend/.venv/bin/python
  fi
  "$PY" backend/tests/test_smoke.py || failures=$((failures + 1))

  step "Frontend production build..."
  if [ ! -d frontend/node_modules ]; then (cd frontend && npm install); fi
  (cd frontend && npx vite build) || failures=$((failures + 1))
  rm -rf frontend/dist

  if [ "$failures" -eq 0 ]; then
    ok "All checks passed."
  else
    die "$failures check(s) failed."
  fi
}

stop_local() {
  [ -d "$RUN_DIR" ] || return 0
  for f in "$RUN_DIR"/*.pid; do
    [ -e "$f" ] || continue
    pid=$(cat "$f"); name=$(basename "$f" .pid)
    if kill "$pid" 2>/dev/null; then ok "stopped $name (pid $pid)"; fi
    rm -f "$f"
  done
}

cmd_stop() {
  step "Stopping local processes (if any)..."
  stop_local
  if have docker && docker info >/dev/null 2>&1; then
    step "Stopping containers..."
    compose down 2>/dev/null || true
  fi
  ok "Everything stopped."
}

cmd_reset() {
  step "Stopping everything and wiping data volumes..."
  stop_local
  if have docker && docker info >/dev/null 2>&1; then
    compose down -v 2>/dev/null || true
  fi
  rm -f backend/*.db
  ok "Data wiped. Run ./start.sh to start fresh (it will re-seed)."
}

# ------------------------------------------------------------------ main ---
case "${1:-}" in
  ""|--up)      cmd_up ;;
  --local)      cmd_local ;;
  --status|-s)  cmd_status ;;
  --logs|-l)    cmd_logs ;;
  --test|-t)    cmd_test ;;
  --stop)       cmd_stop ;;
  --reset)      cmd_reset ;;
  --help|-h)
    banner
    sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *) die "Unknown option: $1 (try ./start.sh --help)" ;;
esac

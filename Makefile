# Canonical entry points for the local stacks (issue #144) — one place
# for the multi-file compose invocations everyone was retyping slightly
# differently. `make help` lists everything.

COMPOSE  := docker compose
BASE     := -f docker-compose.yml
OBS      := -f docker-compose.observability.yml
# Optional local-only tweaks (gitignored). Compose auto-loads
# docker-compose.override.yml only when invoked with NO -f flags — every
# target here uses explicit -f, so the override must be re-listed
# explicitly or it silently stops applying.
OVERRIDE := $(shell test -f docker-compose.override.yml && echo -f docker-compose.override.yml)

.PHONY: help env up up-obs up-obs-desktop down down-obs logs ps verify smoke \
        test-api test-worker test-frontend test

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

env: ## Generate .env + docker/librechat/.env (once)
	./scripts/generate-local-env.sh

up: ## App stack only
	$(COMPOSE) $(BASE) $(OVERRIDE) up -d --build

up-obs: ## App stack + observability overlay (Grafana/Alloy/Mimir/Loki)
	$(COMPOSE) $(BASE) $(OBS) $(OVERRIDE) up -d --build

up-obs-desktop: ## up-obs for Docker Desktop (adds the container-stats-exporter profile)
	$(COMPOSE) $(BASE) $(OBS) $(OVERRIDE) --profile docker-desktop up -d --build

down: ## Stop the app stack (volumes kept)
	$(COMPOSE) $(BASE) $(OVERRIDE) down

down-obs: ## Stop app + observability (volumes kept)
	$(COMPOSE) $(BASE) $(OBS) $(OVERRIDE) down

logs: ## Tail all logs (make logs s=api for one service)
	$(COMPOSE) $(BASE) $(OBS) $(OVERRIDE) logs -f $(s)

ps: ## Status of every service
	$(COMPOSE) $(BASE) $(OBS) $(OVERRIDE) ps

verify: ## End-to-end connection checks against the running stack
	@test -x scripts/verify-stack-connections.sh || \
	  { echo "scripts/verify-stack-connections.sh not found — it lands with PR #158 (OCR pipeline)."; exit 1; }
	./scripts/verify-stack-connections.sh

smoke: ## CI's compose health smoke, locally (throwaway project, torn down after)
	$(COMPOSE) -f docker-compose.smoke.yml -p nexus-smoke up --build --wait; \
	  status=$$?; $(COMPOSE) -f docker-compose.smoke.yml -p nexus-smoke down -v; exit $$status

# Test targets run against DISPOSABLE containers on non-default ports —
# never the live stack's database (see TESTING.md; the suites refuse
# non-test database names outright).
TEST_PG_URL    := postgresql://t:t@localhost:5544/nexus_test
TEST_REDIS_URL := redis://localhost:6380

define start_test_deps
	npm run build --workspace=packages/shared >/dev/null
	npm run build --workspace=packages/pdf >/dev/null
	docker rm -f nexus-test-pg nexus-test-redis >/dev/null 2>&1 || true
	docker run --rm -d --name nexus-test-pg -p 5544:5432 \
	  -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t -e POSTGRES_DB=nexus_test postgres:16-alpine >/dev/null
	docker run --rm -d --name nexus-test-redis -p 6380:6379 redis:7-alpine redis-server --save '' >/dev/null
	until docker exec nexus-test-pg pg_isready -U t >/dev/null 2>&1; do sleep 1; done
	DATABASE_URL="$(TEST_PG_URL)" npm run prisma:push --workspace=packages/shared >/dev/null
endef

define stop_test_deps
	docker rm -f nexus-test-pg nexus-test-redis >/dev/null 2>&1 || true
endef

test-api: ## API suite against throwaway postgres/redis
	$(start_test_deps)
	DATABASE_URL="$(TEST_PG_URL)" REDIS_URL="$(TEST_REDIS_URL)" API_TEST_REDIS_URL="$(TEST_REDIS_URL)" \
	  npx vitest run --root packages/api; \
	  status=$$?; $(stop_test_deps); exit $$status

test-worker: ## Worker suite against throwaway postgres/redis
	$(start_test_deps)
	DATABASE_URL="$(TEST_PG_URL)" WORKER_TEST_REDIS_URL="$(TEST_REDIS_URL)" npx vitest run --root packages/worker; \
	  status=$$?; $(stop_test_deps); exit $$status

test-frontend: ## Frontend suite (no external deps)
	npx vitest run --root packages/frontend

test: test-frontend test-worker test-api ## All suites

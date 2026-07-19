# Testing

## The golden rule: never point test suites at a real database

The worker and api suites are **integration tests**: their fixtures
reset the entire database they connect to (`deleteMany` on every
table, every run). Pointed at a live deployment's Postgres — for
example the Compose stack, which publishes `5432` on the host — they
silently destroy real data.

Both suites therefore refuse to start unless the `DATABASE_URL`
database name looks disposable: it must contain `test`, or be exactly
`ci` or `t`. To override (you almost certainly should not):
`NEXUS_UNSAFE_TEST_DB=1`.

## The disposable-container pattern

Run every suite against throwaway containers on non-default ports, so
even a mistake can't reach a real instance:

```sh
docker run --rm -d --name test-pg -p 5544:5432 \
  -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t -e POSTGRES_DB=nexus_test \
  postgres:16-alpine
docker run --rm -d --name test-redis -p 6380:6379 redis:7-alpine

DATABASE_URL="postgresql://t:t@localhost:5544/nexus_test" \
  npm run prisma:push --workspace=packages/shared

DATABASE_URL="postgresql://t:t@localhost:5544/nexus_test" \
REDIS_URL="redis://localhost:6380" \
  npx vitest run --root packages/api

DATABASE_URL="postgresql://t:t@localhost:5544/nexus_test" \
WORKER_TEST_REDIS_URL="redis://127.0.0.1:6380" \
  npx vitest run --root packages/worker

docker rm -f test-pg test-redis
```

The worker's test files intentionally use `WORKER_TEST_REDIS_URL` for
their test-only Redis override; the running worker uses `REDIS_URL`.
CI needs no override because its disposable Redis listens on the
tests' default port, `6379`.

CI does the equivalent with service containers (db name `ci`).

## End-to-end (Playwright) knobs

`packages/e2e` drives a real browser against a running stack. Knobs
(all optional, read from the environment by the specs):

- `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` — the login used by the
  specs; defaults match `scripts/generate-local-env.sh`'s bootstrap
  admin only if you exported the same values.
- `E2E_BASE_URL` — the running frontend to test; defaults to
  `http://localhost:4173`.

The e2e suite exercises a live stack and creates real rows there — run
it against a stack you are happy to dirty, never a shared deployment.

# Build context must be the repo root (npm workspaces need the whole
# monorepo), e.g.: docker build -f packages/api/Dockerfile .
#
# TODO(REQUIREMENTS §3/§9.1/§10): swap `node:20-slim` for an Iron Bank
# Node image where available, run in FIPS mode, and apply the applicable
# DISA STIG hardening baseline before this goes anywhere near production.
# This base image is a placeholder to get the scaffold building/running.

FROM node:20-slim AS build
WORKDIR /app

# Prisma's schema/query engine binaries are linked against OpenSSL and
# need it present to detect the right build to use — `node:20-slim`
# doesn't ship it. Without this, `prisma generate`/`db push` silently
# guess a version ("Prisma failed to detect the libssl/openssl version")
# and can fail outright at either build or run time.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/pdf/package.json packages/pdf/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY packages/frontend/package.json packages/frontend/package.json
RUN npm ci

COPY packages/shared packages/shared
COPY packages/api packages/api
RUN npm run prisma:generate --workspace=packages/shared
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/api

# Strips devDependencies (typescript, vite/esbuild pulled in by the
# frontend workspace, eslint, etc.) out of the hoisted node_modules
# before it gets copied into the runtime image below — none of that
# build-only tooling has any business shipping in a runtime container
# (REQUIREMENTS §3/§10; issue #91). Runtime deps across every workspace
# (express, @prisma/client, bullmq, ...) are unaffected.
RUN npm prune --omit=dev

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# See the build stage above — @prisma/client needs OpenSSL present at
# runtime too, for every query it makes. `apt-get upgrade` pulls in
# whatever current Debian security patches exist at build time
# regardless of how stale the cached base layer is (same "don't pin,
# always take the latest patch" rationale as DL3008's exception below).
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system nexus && useradd --system --gid nexus --home-dir /app nexus
# This image only ever runs `node dist/index.js` directly (see CMD
# below) — npm/npx are never invoked at runtime, only during the build
# stage above. The bundled npm CLI's own dependencies (cross-spawn,
# glob, minimatch, sigstore, tar) are a recurring source of CRITICAL/
# HIGH CVEs unrelated to anything this image actually does (issue
# #91), so it's removed entirely rather than patched version-by-version.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/prisma packages/shared/prisma
COPY --from=build /app/packages/api/package.json packages/api/package.json
COPY --from=build /app/packages/api/dist packages/api/dist

USER nexus
EXPOSE 3000
CMD ["node", "packages/api/dist/index.js"]

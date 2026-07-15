# Build context must be the repo root, e.g.:
#   docker build -f packages/worker/Dockerfile .
#
# TODO(REQUIREMENTS §3/§9.1/§10): swap `node:20-slim` for an Iron Bank
# Node image where available, run in FIPS mode, and apply the applicable
# DISA STIG hardening baseline. This is a placeholder base image.

FROM node:20-slim AS build
WORKDIR /app

# See packages/api/Dockerfile for why this is needed — same Prisma/
# OpenSSL detection issue applies here.
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
COPY packages/pdf packages/pdf
COPY packages/worker packages/worker
RUN npm run prisma:generate --workspace=packages/shared
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/pdf
RUN npm run build --workspace=packages/worker

# Strips devDependencies (typescript, vite/esbuild pulled in by the
# frontend workspace, eslint, etc.) out of the hoisted node_modules
# before it gets copied into the runtime image below — none of that
# build-only tooling has any business shipping in a runtime container
# (REQUIREMENTS §3/§10; issue #91). Runtime deps across every workspace
# (express, @prisma/client, bullmq, ...) are unaffected, and this
# doesn't touch packages/pdf/node_modules below (playwright is a real
# dependency there, not a devDependency, and npm prune only prunes the
# hoisted root tree, not nested per-workspace node_modules).
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
COPY --from=build /app/packages/pdf/package.json packages/pdf/package.json
COPY --from=build /app/packages/pdf/dist packages/pdf/dist
# renderNotificationTemplate's Markdown rendering (§61) pulls in
# @nexus-scheduler/pdf's index.ts, which re-exports renderer.ts —
# importing `playwright` even though the worker never launches a
# browser. Same node_modules-not-hoisted situation as packages/pdf-
# service/Dockerfile; copied here purely to satisfy that import, not
# because the worker renders PDFs itself.
COPY --from=build /app/packages/pdf/node_modules packages/pdf/node_modules
COPY --from=build /app/packages/worker/package.json packages/worker/package.json
COPY --from=build /app/packages/worker/dist packages/worker/dist

USER nexus
EXPOSE 3001
CMD ["node", "packages/worker/dist/index.js"]

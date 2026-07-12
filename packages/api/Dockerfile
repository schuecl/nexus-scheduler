# Build context must be the repo root (npm workspaces need the whole
# monorepo), e.g.: docker build -f packages/api/Dockerfile .
#
# TODO(REQUIREMENTS §3/§9.1/§10): swap `node:20-slim` for an Iron Bank
# Node image where available, run in FIPS mode, and apply the applicable
# DISA STIG hardening baseline before this goes anywhere near production.
# This base image is a placeholder to get the scaffold building/running.

FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/worker/package.json packages/worker/package.json
COPY packages/frontend/package.json packages/frontend/package.json
RUN npm ci

COPY packages/shared packages/shared
COPY packages/api packages/api
RUN npm run prisma:generate --workspace=packages/shared
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/api

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system nexus && useradd --system --gid nexus --home-dir /app nexus

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

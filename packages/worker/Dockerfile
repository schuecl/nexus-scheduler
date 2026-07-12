# Build context must be the repo root, e.g.:
#   docker build -f packages/worker/Dockerfile .
#
# TODO(REQUIREMENTS §3/§9.1/§10): swap `node:20-slim` for an Iron Bank
# Node image where available, run in FIPS mode, and apply the applicable
# DISA STIG hardening baseline. This is a placeholder base image.

FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
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

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# PDF report email attachments (§2.2/§2.5) use headless Chromium via
# Playwright, installed below into a fixed, world-readable path so the
# non-root `nexus` user (created next) can still launch it.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN groupadd --system nexus && useradd --system --gid nexus --home-dir /app nexus

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/prisma packages/shared/prisma
COPY --from=build /app/packages/pdf/package.json packages/pdf/package.json
COPY --from=build /app/packages/pdf/dist packages/pdf/dist
COPY --from=build /app/packages/worker/package.json packages/worker/package.json
COPY --from=build /app/packages/worker/dist packages/worker/dist

# See packages/api/Dockerfile for the --with-deps/air-gap tradeoff note —
# same one applies here.
RUN npx --prefix packages/pdf playwright install --with-deps chromium \
    && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

USER nexus
EXPOSE 3001
CMD ["node", "packages/worker/dist/index.js"]

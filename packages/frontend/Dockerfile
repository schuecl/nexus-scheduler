# Build context must be the repo root, e.g.:
#   docker build -f packages/frontend/Dockerfile .
#
# TODO(REQUIREMENTS §3/§9.1/§10): swap both base images for Iron Bank
# equivalents where available (Node build stage, nginx-unprivileged
# runtime stage) and apply the applicable DISA STIG baseline.

FROM node:26-slim AS build
WORKDIR /app

# See packages/api/Dockerfile for why this is needed — building
# packages/shared here also runs `prisma generate`, which needs OpenSSL
# present to detect the right engine binary.
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
COPY packages/frontend packages/frontend
RUN npm run prisma:generate --workspace=packages/shared
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=packages/frontend

FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime
# Picks up whatever current Alpine security patches exist at build time
# regardless of how stale the cached base layer is (same rationale as
# the Debian `apt-get upgrade` steps in the other three Dockerfiles —
# issue #91). This base image already runs as the unprivileged `nginx`
# user by default; `apk upgrade` needs root, so this briefly switches
# back and restores the non-root user afterward — the final image's
# runtime user is unchanged.
USER root
RUN apk upgrade --no-cache
USER nginx

COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080

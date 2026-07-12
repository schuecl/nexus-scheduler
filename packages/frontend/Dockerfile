# Build context must be the repo root, e.g.:
#   docker build -f packages/frontend/Dockerfile .
#
# TODO(REQUIREMENTS §3/§9.1/§10): swap both base images for Iron Bank
# equivalents where available (Node build stage, nginx-unprivileged
# runtime stage) and apply the applicable DISA STIG baseline.

FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
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
COPY --from=build /app/packages/frontend/dist /usr/share/nginx/html
COPY packages/frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080

# LISA Cloud — containerizes `lisa serve --web` for Cloud Run (LISA_EDITION=cloud).
# See docs/PLAN_CLOUD_v1.0.md (C1). Build context = repo root:
#   gcloud run deploy lisa-cloud --source . --project oratis-491316 --region us-central1
#
# DRAFT (M0): not yet wired to the cloud auth gate (C3 — Firebase token). Until
# then the container REQUIRES LISA_WEB_TOKEN (a shared secret for the seeded demo
# account) since it binds a non-loopback address. node-pty (Mac-only PTY) is an
# optionalDependency and is expected to be skipped here.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund || npm ci --no-audit --no-fund --omit=optional
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV LISA_EDITION=cloud
# Cloud Run injects $PORT (default 8080). Auth is the cloud token/identity gate
# (NOT loopback) — the ingress LB fronts this, so binding 0.0.0.0 is intended.
ENV PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# The build symlinks dist/web/assets → ../../src/web/assets; ship the real assets
# so the link resolves at runtime.
COPY --from=build /app/src/web/assets ./src/web/assets
EXPOSE 8080
CMD ["sh", "-c", "node dist/cli.js serve --web --port ${PORT:-8080} --host 0.0.0.0"]

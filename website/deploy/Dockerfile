# Deterministic deploy image for the Lisa website on Cloud Run.
#
# The build CONTEXT must contain website/ plus the two repo-root paths that
# website/scripts/prebuild.mjs needs (it reads ../scripts/lisa-moods.ts and
# symlinks ../src/web/assets → public/assets). deploy.sh assembles exactly that
# minimal context, so `COPY . .` here stays small.
#
# Astro 6 requires Node >= 22.
FROM node:22-slim AS build
WORKDIR /app
COPY . .
WORKDIR /app/website
RUN npm ci || npm install
RUN npm run build           # prebuild (moods.json + assets symlink) then astro build
# dist/ is now fully self-contained (assets materialized from the symlink).

FROM node:22-slim
WORKDIR /app
RUN npm install -g serve@14
COPY --from=build /app/website/dist ./dist
ENV PORT=8080
# serve resolves clean URLs (/install → /install/index.html) and binds 0.0.0.0.
CMD ["sh","-c","serve -l ${PORT} dist"]

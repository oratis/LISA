#!/usr/bin/env bash
# Deploy the Lisa website (meetlisa.ai) to Cloud Run.
#
# Build model: the static site is built to dist/ *locally* — `prebuild` reads
# the repo-root scripts/lisa-moods.ts and src/web/assets/, reachable from here
# but not from inside a website-only Docker context (a plain `--source website`
# build would dangle the asset symlink). We then `gcloud run deploy --source`
# a tiny nginx image (Dockerfile + nginx.conf) that just serves the pre-built
# dist/. .gcloudignore trims the upload to dist/ + Dockerfile + nginx.conf.
#
# Usage:
#   PROJECT=my-project website/deploy/deploy.sh            # build + promote to 100%
#   PROJECT=my-project website/deploy/deploy.sh --canary   # --no-traffic 'canary' to verify
# Env overrides: PROJECT (required), REGION, SERVICE.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WEBSITE="$(cd "$HERE/.." && pwd)"
PROJECT="${PROJECT:?set your GCP project id, e.g. PROJECT=my-project website/deploy/deploy.sh}"
REGION="${REGION:-us-central1}"; SERVICE="${SERVICE:-lisa-web}"

# Build the static site locally (prebuild: snapshot moods + materialize assets).
( cd "$WEBSITE" && { npm ci || npm install; } && npm run build )
test -f "$WEBSITE/dist/index.html"   # fail fast if the build produced nothing

ARGS=(run deploy "$SERVICE" --source "$WEBSITE" --project "$PROJECT" --region "$REGION" --quiet)
if [ "${1:-}" = "--canary" ]; then ARGS+=(--no-traffic --tag canary); fi
echo "→ deploying $SERVICE to $PROJECT/$REGION ${1:-(promote 100%)}"
gcloud "${ARGS[@]}"

#!/usr/bin/env bash
# Deploy LISA Cloud (M0 reviewer demo) to Cloud Run — mirrors website/deploy/deploy.sh.
#
# Build context = the repo ROOT (the server needs all of src/). The cloud
# Dockerfile lives at deploy/Dockerfile; since `gcloud run deploy --source` only
# picks up a Dockerfile at the context root, we stage it there for the build and
# clean it up after. A trimmed .gcloudignore keeps the upload small.
#
# You provide (secrets — never commit these):
#   LISA_WEB_TOKEN      the demo password; hand it to App Review as the sign-in
#   ANTHROPIC_API_KEY   funds the demo LLM — RATE-LIMIT this key (demo-only)
# Overrides: PROJECT (default oratis-491316), REGION (us-central1), SERVICE (lisa-cloud)
#
# Usage:
#   LISA_WEB_TOKEN=… ANTHROPIC_API_KEY=… deploy/deploy.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
PROJECT="${PROJECT:-oratis-491316}"; REGION="${REGION:-us-central1}"; SERVICE="${SERVICE:-lisa-cloud}"
: "${LISA_WEB_TOKEN:?set LISA_WEB_TOKEN (the demo password)}"
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY (funds the demo LLM — rate-limit it)}"

cd "$ROOT"
cp deploy/Dockerfile ./Dockerfile
cat > .gcloudignore <<'IGN'
.git
node_modules
dist
packaging
website
docs
reference
build
IGN
cleanup() { rm -f ./Dockerfile ./.gcloudignore; }
trap cleanup EXIT

echo "→ deploying $SERVICE to $PROJECT/$REGION (min-instances=1, allow-unauthenticated; the app's own token gate is the auth)"
gcloud run deploy "$SERVICE" \
  --source . --project "$PROJECT" --region "$REGION" --quiet \
  --allow-unauthenticated --min-instances 1 --max-instances 2 \
  --memory 1Gi --cpu 1 --timeout 300 \
  --set-env-vars "LISA_EDITION=cloud,LISA_WEB_TOKEN=$LISA_WEB_TOKEN,ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
echo "✓ deployed${URL:+: $URL}"
[ -n "$URL" ] && echo "  Reviewer demo URL (opens authed, pins the cookie):  $URL/?token=$LISA_WEB_TOKEN"

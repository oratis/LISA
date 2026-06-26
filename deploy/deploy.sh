#!/usr/bin/env bash
# Deploy LISA Cloud (M0 reviewer demo) to Cloud Run — mirrors website/deploy/deploy.sh.
#
# Build context = the repo ROOT (the server needs all of src/). The cloud
# Dockerfile lives at deploy/Dockerfile; since `gcloud run deploy --source` only
# picks up a Dockerfile at the context root, we stage it there for the build and
# clean it up after. A trimmed .gcloudignore keeps the upload small.
#
# You provide (secrets — never commit these):
#   LISA_WEB_TOKEN     the demo password; hand it to App Review as the sign-in
#   + exactly one LLM provider key, which also selects the model:
#       ZHIPU_API_KEY    → GLM (set LISA_MODEL=glm-4.6; defaulted if unset)
#       ANTHROPIC_API_KEY→ Claude (LISA_MODEL defaults to claude-sonnet-4-6)
#       OPENAI_API_KEY   → GPT (set LISA_MODEL=gpt-4o)
#   RATE-LIMIT whichever key you use — it funds the public demo.
# Overrides: PROJECT (default oratis-491316), REGION (us-central1),
#   SERVICE (lisa-cloud), LISA_MODEL.
#
# Usage (GLM):
#   LISA_WEB_TOKEN=… ZHIPU_API_KEY=… deploy/deploy.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
PROJECT="${PROJECT:-oratis-491316}"; REGION="${REGION:-us-central1}"; SERVICE="${SERVICE:-lisa-cloud}"
: "${LISA_WEB_TOKEN:?set LISA_WEB_TOKEN (the demo password)}"

# Require at least one LLM key (the demo soul is born by an LLM).
if [ -z "${ANTHROPIC_API_KEY:-}${ZHIPU_API_KEY:-}${OPENAI_API_KEY:-}" ]; then
  echo "✗ set one LLM provider key: ZHIPU_API_KEY (GLM), ANTHROPIC_API_KEY (Claude), or OPENAI_API_KEY (GPT)" >&2
  exit 1
fi
# Default the model from the key in use so the GLM path "just works".
if [ -z "${LISA_MODEL:-}" ]; then
  if   [ -n "${ZHIPU_API_KEY:-}" ];     then LISA_MODEL="glm-4.6"
  elif [ -n "${OPENAI_API_KEY:-}" ];    then LISA_MODEL="gpt-4o"
  fi   # else: leave unset → Anthropic default (claude-sonnet-4-6)
fi

# Build the env list with a custom '##' delimiter (gcloud's ^d^ syntax) so secret
# values may safely contain commas.
ENVS="^##^LISA_EDITION=cloud##LISA_WEB_TOKEN=${LISA_WEB_TOKEN}"
[ -n "${LISA_MODEL:-}" ]        && ENVS="${ENVS}##LISA_MODEL=${LISA_MODEL}"
[ -n "${ANTHROPIC_API_KEY:-}" ] && ENVS="${ENVS}##ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
[ -n "${ZHIPU_API_KEY:-}" ]     && ENVS="${ENVS}##ZHIPU_API_KEY=${ZHIPU_API_KEY}"
[ -n "${OPENAI_API_KEY:-}" ]    && ENVS="${ENVS}##OPENAI_API_KEY=${OPENAI_API_KEY}"

cd "$ROOT"
cp deploy/Dockerfile ./Dockerfile
cat > .gcloudignore <<'IGN'
.git
.claude
node_modules
dist
packaging
website
docs
reference
build
*.log
.DS_Store
IGN
cleanup() { rm -f ./Dockerfile ./.gcloudignore; }
trap cleanup EXIT

echo "→ deploying $SERVICE to $PROJECT/$REGION (model ${LISA_MODEL:-claude-default}, min-instances=1, allow-unauthenticated; the app's token gate is the auth)"
gcloud run deploy "$SERVICE" \
  --source . --project "$PROJECT" --region "$REGION" --quiet \
  --allow-unauthenticated --min-instances 1 --max-instances 2 \
  --memory 1Gi --cpu 1 --timeout 300 \
  --set-env-vars "$ENVS"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
echo "✓ deployed${URL:+: $URL}"
[ -n "$URL" ] && echo "  Reviewer demo URL (opens authed, pins the cookie):  $URL/?token=$LISA_WEB_TOKEN"

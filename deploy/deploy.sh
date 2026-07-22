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
# Persistence (C2): a GCS bucket is mounted at /data (= $LISA_HOME) so the soul +
# sessions survive restarts/redeploys (Cloud Run's own FS is ephemeral). The
# bucket + the runtime service account's access are ensured idempotently here.
#
# Overrides: PROJECT (default oratis-491316), REGION (us-central1),
#   SERVICE (lisa-cloud), LISA_MODEL, LISA_BUCKET (default <project>-lisa-cloud-data).
#
# Optional — Sign in with Apple for the iOS app (off unless set; src/web/cloudAuth.ts):
#   LISA_CLOUD_APPLE_SIGNIN=1   enable POST /api/auth/apple
#   LISA_CLOUD_APPLE_SUBS=…     optional comma-separated Apple `sub` allowlist
#   LISA_CLOUD_APPLE_AUD=…      override the expected bundle id (default ai.meetlisa.main)
#
# Usage (GLM):
#   LISA_WEB_TOKEN=… ZHIPU_API_KEY=… deploy/deploy.sh
#   # …with iOS sign-in: append LISA_CLOUD_APPLE_SIGNIN=1
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
# Optional: Sign in with Apple for the iOS app (src/web/cloudAuth.ts). Off unless
# LISA_CLOUD_APPLE_SIGNIN is set; LISA_CLOUD_APPLE_SUBS is an optional allowlist of
# Apple `sub`s, LISA_CLOUD_APPLE_AUD overrides the expected bundle id.
[ -n "${LISA_CLOUD_APPLE_SIGNIN:-}" ] && ENVS="${ENVS}##LISA_CLOUD_APPLE_SIGNIN=${LISA_CLOUD_APPLE_SIGNIN}"
[ -n "${LISA_CLOUD_APPLE_SUBS:-}" ]   && ENVS="${ENVS}##LISA_CLOUD_APPLE_SUBS=${LISA_CLOUD_APPLE_SUBS}"
[ -n "${LISA_CLOUD_APPLE_AUD:-}" ]    && ENVS="${ENVS}##LISA_CLOUD_APPLE_AUD=${LISA_CLOUD_APPLE_AUD}"
# Sign in with Apple on the WEB login page (B8b): the Services ID registered in
# the Apple portal for cloud.meetlisa.ai (needs domain verification there).
[ -n "${LISA_CLOUD_APPLE_WEB_SID:-}" ] && ENVS="${ENVS}##LISA_CLOUD_APPLE_WEB_SID=${LISA_CLOUD_APPLE_WEB_SID}"
# Accounts & billing era (PLAN_ACCOUNTS_BILLING B1–B7), all optional:
#   LISA_REVIEWER_SEED="email:password"  idempotent App-Review demo account (verified, $20/Tier-2)
#   LISA_RPM_LIMIT / LISA_DAILY_CAP_USD  abuse guards (defaults 20 rpm / $200 per day)
#   LISA_BILLING_KILL=1                  pause ALL metered inference immediately
[ -n "${LISA_REVIEWER_SEED:-}" ]  && ENVS="${ENVS}##LISA_REVIEWER_SEED=${LISA_REVIEWER_SEED}"
#   RESEND_API_KEY / LISA_MAIL_FROM  email verification (B8a; domain verified in Resend)
#   STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET  desktop/web top-up (B8c)
[ -n "${RESEND_API_KEY:-}" ]        && ENVS="${ENVS}##RESEND_API_KEY=${RESEND_API_KEY}"
[ -n "${LISA_MAIL_FROM:-}" ]        && ENVS="${ENVS}##LISA_MAIL_FROM=${LISA_MAIL_FROM}"
[ -n "${STRIPE_SECRET_KEY:-}" ]     && ENVS="${ENVS}##STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}"
[ -n "${STRIPE_WEBHOOK_SECRET:-}" ] && ENVS="${ENVS}##STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}"
[ -n "${LISA_RPM_LIMIT:-}" ]      && ENVS="${ENVS}##LISA_RPM_LIMIT=${LISA_RPM_LIMIT}"
[ -n "${LISA_DAILY_CAP_USD:-}" ]  && ENVS="${ENVS}##LISA_DAILY_CAP_USD=${LISA_DAILY_CAP_USD}"
[ -n "${LISA_BILLING_KILL:-}" ]   && ENVS="${ENVS}##LISA_BILLING_KILL=${LISA_BILLING_KILL}"

# ── durable home (C2): a GCS bucket mounted at /data keeps the soul across restarts ──
BUCKET="${LISA_BUCKET:-${PROJECT}-lisa-cloud-data}"
echo "→ ensuring durable bucket gs://$BUCKET (+ Cloud Run SA access)"
gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access
# The default Cloud Run runtime identity is the compute service account; grant it object access.
SA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --project "$PROJECT" \
  --member "serviceAccount:$SA" --role roles/storage.objectAdmin >/dev/null

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

# Sizing (PLAN_ACCOUNTS_BILLING §6.7): 2 vCPU / 4Gi headroom for the account era;
# --timeout 3600 so SSE chat streams aren't cut at 5 min. min=max=1 stays until
# the per-uid + Firestore work (B2) removes the single-writer constraint.
echo "→ deploying $SERVICE to $PROJECT/$REGION (model ${LISA_MODEL:-claude-default}, /data←gs://$BUCKET, min=max=1 single-writer, allow-unauthenticated; the app's token gate is the auth)"
gcloud run deploy "$SERVICE" \
  --source . --project "$PROJECT" --region "$REGION" --quiet \
  --allow-unauthenticated --min-instances 1 --max-instances 1 \
  --execution-environment gen2 \
  --add-volume "name=soul,type=cloud-storage,bucket=$BUCKET" \
  --add-volume-mount "volume=soul,mount-path=/data" \
  --memory 4Gi --cpu 2 --timeout 3600 \
  --set-env-vars "$ENVS"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
echo "✓ deployed${URL:+: $URL}"
[ -n "$URL" ] && echo "  Reviewer demo URL (opens authed, pins the cookie):  $URL/?token=$LISA_WEB_TOKEN"

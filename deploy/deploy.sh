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

# ── Secret routing (S6) ─────────────────────────────────────────────────────
# SECRETS_MODE=env (default): everything ships as plain env vars — unchanged
#   demo behavior, values visible in the Cloud Run console.
# SECRETS_MODE=sm: sensitive values go to Secret Manager (a version is pushed
#   on every deploy) and reach the container via --set-secrets; only
#   non-sensitive config stays in env vars. The PRODUCTION setting.
SECRETS_MODE="${SECRETS_MODE:-env}"
SECRET_VARS=" LISA_WEB_TOKEN ANTHROPIC_API_KEY ZHIPU_API_KEY OPENAI_API_KEY RESEND_API_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET LISA_TURNSTILE_SECRET LISA_SWEEP_TOKEN LISA_REVIEWER_SEED "
PENDING_SECRETS=()
SET_SECRETS=""
# Build the env list with a custom '##' delimiter (gcloud's ^d^ syntax) so
# values may safely contain commas. addenv routes each var to env or secret.
ENVS="^##^LISA_EDITION=cloud"
addenv() { # addenv NAME VALUE
  local name="$1" val="$2"
  [ -z "$val" ] && return 0
  if [ "$SECRETS_MODE" = "sm" ] && [[ "$SECRET_VARS" == *" $name "* ]]; then
    PENDING_SECRETS+=("${name}=${val}")
    SET_SECRETS="${SET_SECRETS:+$SET_SECRETS,}${name}=${name}:latest"
  else
    ENVS="${ENVS}##${name}=${val}"
  fi
}
addenv LISA_WEB_TOKEN        "${LISA_WEB_TOKEN}"
addenv LISA_MODEL            "${LISA_MODEL:-}"
addenv ANTHROPIC_API_KEY     "${ANTHROPIC_API_KEY:-}"
addenv ZHIPU_API_KEY         "${ZHIPU_API_KEY:-}"
addenv OPENAI_API_KEY        "${OPENAI_API_KEY:-}"
# Optional: Sign in with Apple for the iOS app (src/web/cloudAuth.ts). Off unless
# LISA_CLOUD_APPLE_SIGNIN is set; LISA_CLOUD_APPLE_SUBS is an optional allowlist of
# Apple `sub`s, LISA_CLOUD_APPLE_AUD overrides the expected bundle id.
addenv LISA_CLOUD_APPLE_SIGNIN  "${LISA_CLOUD_APPLE_SIGNIN:-}"
addenv LISA_CLOUD_APPLE_SUBS    "${LISA_CLOUD_APPLE_SUBS:-}"
addenv LISA_CLOUD_APPLE_AUD     "${LISA_CLOUD_APPLE_AUD:-}"
# Sign in with Apple on the WEB login page (B8b): the Services ID registered in
# the Apple portal for cloud.meetlisa.ai (needs domain verification there).
addenv LISA_CLOUD_APPLE_WEB_SID "${LISA_CLOUD_APPLE_WEB_SID:-}"
# Sign in with Google on the WEB login page (S1, PLAN_WEB_SIGNUP):
#   LISA_CLOUD_GOOGLE_SIGNIN=1     enable POST /api/auth/google
#   LISA_CLOUD_GOOGLE_CLIENT_ID=…  OAuth web client id (…apps.googleusercontent.com;
#                                  authorized JS origin = https://cloud.meetlisa.ai)
addenv LISA_CLOUD_GOOGLE_SIGNIN    "${LISA_CLOUD_GOOGLE_SIGNIN:-}"
addenv LISA_CLOUD_GOOGLE_CLIENT_ID "${LISA_CLOUD_GOOGLE_CLIENT_ID:-}"
# Turnstile bot gate on signup (S3): widget site key + siteverify secret.
addenv LISA_TURNSTILE_SITE_KEY "${LISA_TURNSTILE_SITE_KEY:-}"
addenv LISA_TURNSTILE_SECRET   "${LISA_TURNSTILE_SECRET:-}"
# Extra disposable-email domains to block at signup (comma-separated; S3).
addenv LISA_EMAIL_BLOCKLIST    "${LISA_EMAIL_BLOCKLIST:-}"
# Per-uid autonomy sweep (S4): bearer secret for POST /internal/autonomy/sweep.
# Pair it with a Cloud Scheduler job, e.g.:
#   gcloud scheduler jobs create http lisa-autonomy-sweep --schedule "*/30 * * * *" \
#     --uri "$URL/internal/autonomy/sweep" --http-method POST \
#     --headers "Authorization=Bearer $LISA_SWEEP_TOKEN" --location "$REGION"
addenv LISA_SWEEP_TOKEN        "${LISA_SWEEP_TOKEN:-}"
# Accounts & billing era (PLAN_ACCOUNTS_BILLING B1–B7), all optional:
#   LISA_REVIEWER_SEED="email:password"  idempotent App-Review demo account (verified, $20/Tier-2)
#   LISA_RPM_LIMIT / LISA_DAILY_CAP_USD  abuse guards (defaults 20 rpm / $200 per day)
#   LISA_BILLING_KILL=1                  pause ALL metered inference immediately
addenv LISA_REVIEWER_SEED  "${LISA_REVIEWER_SEED:-}"
#   RESEND_API_KEY / LISA_MAIL_FROM  email verification (B8a; domain verified in Resend)
#   STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET  desktop/web top-up (B8c)
addenv RESEND_API_KEY        "${RESEND_API_KEY:-}"
addenv LISA_MAIL_FROM        "${LISA_MAIL_FROM:-}"
addenv STRIPE_SECRET_KEY     "${STRIPE_SECRET_KEY:-}"
addenv STRIPE_WEBHOOK_SECRET "${STRIPE_WEBHOOK_SECRET:-}"
#   LISA_FIRESTORE=1  move accounts/balances/tx-index/day-cap/turn-lease to Firestore
#   (enable the API + Native-mode DB in the project first; unlocks MAX_INSTANCES>1)
addenv LISA_FIRESTORE         "${LISA_FIRESTORE:-}"
addenv LISA_FIRESTORE_PROJECT "${LISA_FIRESTORE_PROJECT:-}"
addenv LISA_RPM_LIMIT         "${LISA_RPM_LIMIT:-}"
addenv LISA_DAILY_CAP_USD     "${LISA_DAILY_CAP_USD:-}"
addenv LISA_BILLING_KILL      "${LISA_BILLING_KILL:-}"

# ── durable home (C2): a GCS bucket mounted at /data keeps the soul across restarts ──
BUCKET="${LISA_BUCKET:-${PROJECT}-lisa-cloud-data}"
echo "→ ensuring durable bucket gs://$BUCKET (+ Cloud Run SA access)"
gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access
# The default Cloud Run runtime identity is the compute service account; grant it object access.
SA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --project "$PROJECT" \
  --member "serviceAccount:$SA" --role roles/storage.objectAdmin >/dev/null

# ── Secret Manager push (S6; SECRETS_MODE=sm only) ──────────────────────────
# Idempotent: ensure each secret exists, push the value as a new version, and
# grant the runtime SA accessor. Values never appear in the service's env.
if [ "$SECRETS_MODE" = "sm" ] && [ "${#PENDING_SECRETS[@]}" -gt 0 ]; then
  echo "→ pushing ${#PENDING_SECRETS[@]} secrets to Secret Manager"
  gcloud services enable secretmanager.googleapis.com --project "$PROJECT" >/dev/null
  for pair in "${PENDING_SECRETS[@]}"; do
    name="${pair%%=*}"; val="${pair#*=}"
    gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1 \
      || gcloud secrets create "$name" --project "$PROJECT" --replication-policy automatic >/dev/null
    printf '%s' "$val" | gcloud secrets versions add "$name" --project "$PROJECT" --data-file=- >/dev/null
    gcloud secrets add-iam-policy-binding "$name" --project "$PROJECT" \
      --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
  done
fi

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
# --timeout 3600 so SSE chat streams aren't cut at 5 min. MAX_INSTANCES stays 1
# unless LISA_FIRESTORE=1 moved the shared state off local files (B9) — the
# guard below refuses a footgun scale-out.
MAX_INSTANCES="${MAX_INSTANCES:-1}"
if [ "$MAX_INSTANCES" != "1" ] && [ -z "${LISA_FIRESTORE:-}" ]; then
  echo "✗ MAX_INSTANCES=$MAX_INSTANCES requires LISA_FIRESTORE=1 (file-backed accounts/balances are single-writer)" >&2
  exit 1
fi
echo "→ deploying $SERVICE to $PROJECT/$REGION (model ${LISA_MODEL:-claude-default}, /data←gs://$BUCKET, max-instances=$MAX_INSTANCES, allow-unauthenticated; the app's token gate is the auth)"
gcloud run deploy "$SERVICE" \
  --source . --project "$PROJECT" --region "$REGION" --quiet \
  --allow-unauthenticated --min-instances 1 --max-instances "$MAX_INSTANCES" \
  --execution-environment gen2 \
  --add-volume "name=soul,type=cloud-storage,bucket=$BUCKET" \
  --add-volume-mount "volume=soul,mount-path=/data" \
  --memory 4Gi --cpu 2 --timeout 3600 \
  --set-env-vars "$ENVS" \
  ${SET_SECRETS:+--set-secrets "$SET_SECRETS"}

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)"
echo "✓ deployed${URL:+: $URL}"
[ -n "$URL" ] && echo "  Reviewer demo URL (opens authed, pins the cookie):  $URL/?token=$LISA_WEB_TOKEN"

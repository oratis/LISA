#!/usr/bin/env bash
# Deploy the Anthropic relay to Cloud Run (see README.md).
#
#   ANTHROPIC_API_KEY=sk-ant-... ./deploy.sh
#
# Stores the real Anthropic key + a generated RELAY_TOKEN in Secret Manager, grants
# the Cloud Run runtime SA read access, deploys, and prints the exact config.env
# lines for the Mac. Re-runs are idempotent (adds new secret versions, redeploys).
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="${GCP_PROJECT:-oratis-491316}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-anthropic-relay}"
MIN_INSTANCES="${MIN_INSTANCES:-0}"   # set 1 to avoid cold-start latency on the first message (~$5-15/mo)
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY (the real Anthropic key to hold server-side)}"
RELAY_TOKEN="${RELAY_TOKEN:-$(openssl rand -hex 24)}"

echo "==> project=$PROJECT region=$REGION service=$SERVICE"
gcloud config set project "$PROJECT" >/dev/null
gcloud services enable run.googleapis.com secretmanager.googleapis.com cloudbuild.googleapis.com >/dev/null

put_secret() { # name, value
  if gcloud secrets describe "$1" >/dev/null 2>&1; then
    printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
  else
    printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic >/dev/null
  fi
}
echo "==> writing secrets"
put_secret anthropic-api-key "$ANTHROPIC_API_KEY"
put_secret relay-token "$RELAY_TOKEN"

# Cloud Run runtime SA needs to read the secrets.
PROJ_NUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
RUNTIME_SA="${PROJ_NUM}-compute@developer.gserviceaccount.com"
for s in anthropic-api-key relay-token; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/secretmanager.secretAccessor >/dev/null 2>&1 || true
done

echo "==> deploying to Cloud Run"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances="$MIN_INSTANCES" \
  --max-instances=3 \
  --cpu=1 --memory=256Mi \
  --timeout=3600 \
  --set-secrets=ANTHROPIC_API_KEY=anthropic-api-key:latest,RELAY_TOKEN=relay-token:latest

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
echo
echo "✓ Relay live: $URL"
echo
echo "On the Mac, in ~/.lisa/config.env:"
echo "  ANTHROPIC_BASE_URL=$URL"
echo "  ANTHROPIC_API_KEY=$RELAY_TOKEN"
echo "  (and REMOVE any HTTPS_PROXY / HTTP_PROXY so calls go direct to the relay)"
echo
echo "Smoke test:"
echo "  curl -sS $URL/v1/messages -H 'x-api-key: $RELAY_TOKEN' -H 'anthropic-version: 2023-06-01' \\"
echo "    -H 'content-type: application/json' -d '{\"model\":\"claude-sonnet-5\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"say hi\"}]}'"

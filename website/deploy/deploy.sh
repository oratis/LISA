#!/usr/bin/env bash
# Deterministic deploy of the Lisa website (meetlisa.ai) to Cloud Run.
#
# Why a staging dir: prebuild reads repo-root paths (../scripts, ../src/web/assets),
# so a plain `gcloud run deploy --source website` would dangle the asset symlink.
# We assemble a minimal self-contained context (website + those two paths + the
# Dockerfile) and deploy that.
#
# Usage:
#   website/deploy/deploy.sh             # build + promote to 100% traffic
#   website/deploy/deploy.sh --canary    # build a --no-traffic 'canary' revision to verify first
# Env overrides: PROJECT, REGION, SERVICE.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PROJECT="${PROJECT:?set your GCP project id, e.g. PROJECT=my-project website/deploy/deploy.sh}"; REGION="${REGION:-us-central1}"; SERVICE="${SERVICE:-lisa-web}"

STAGE="$(mktemp -d)/lisa-web"
mkdir -p "$STAGE/website" "$STAGE/scripts" "$STAGE/src/web"
rsync -a --exclude node_modules --exclude dist --exclude .astro --exclude 'public/assets' "$REPO/website/" "$STAGE/website/"
cp "$REPO/scripts/lisa-moods.ts" "$STAGE/scripts/"
rsync -aL "$REPO/src/web/assets/" "$STAGE/src/web/assets/"   # -L dereferences → real files
cp "$HERE/Dockerfile" "$STAGE/Dockerfile"

ARGS=(run deploy "$SERVICE" --source "$STAGE" --project "$PROJECT" --region "$REGION" --quiet)
if [ "${1:-}" = "--canary" ]; then ARGS+=(--no-traffic --tag canary); fi
echo "→ deploying $SERVICE to $PROJECT/$REGION ${1:-(promote 100%)}"
gcloud "${ARGS[@]}"
rm -rf "$(dirname "$STAGE")"

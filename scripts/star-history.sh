#!/usr/bin/env bash
# Append a daily snapshot of stars / forks / open-issues / last-push to docs/star-history.csv.
#
# Designed to be run from cron / launchd / GitHub Actions / a manual `make stats`.
# Uses the public GitHub REST API (no auth needed for public repos).
#
# Usage:
#   bash scripts/star-history.sh                     # uses default repo
#   REPO=oratis/LISA bash scripts/star-history.sh    # override
#   OUT=/tmp/lisa-stats.csv bash scripts/star-history.sh
#
# Cron example (hourly):
#   0 * * * * cd ~/Coding/Lisa && bash scripts/star-history.sh
set -euo pipefail

REPO="${REPO:-oratis/LISA}"
OUT="${OUT:-docs/star-history.csv}"

mkdir -p "$(dirname "$OUT")"
if [[ ! -f "$OUT" ]]; then
  echo "timestamp,stars,forks,watchers,open_issues,last_push" > "$OUT"
fi

JSON=$(curl -fsSL -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO")

stars=$(echo "$JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["stargazers_count"])')
forks=$(echo "$JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["forks_count"])')
watchers=$(echo "$JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["subscribers_count"])')
issues=$(echo "$JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["open_issues_count"])')
last_push=$(echo "$JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["pushed_at"])')

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "$ts,$stars,$forks,$watchers,$issues,$last_push" >> "$OUT"

# Print the latest 5 rows so cron emails are useful at a glance.
echo "[$REPO @ $ts] stars=$stars forks=$forks watchers=$watchers open_issues=$issues"
echo
echo "Recent rows:"
tail -n 5 "$OUT"

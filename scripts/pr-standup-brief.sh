#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# pr-standup-brief.sh
#
# Usage:
#   ./pr-standup-brief.sh OWNER/REPO [STALE_DAYS]
#
#   OWNER/REPO   e.g.  myorg/myrepo
#   STALE_DAYS   PRs open longer than this are "stale". Default: 5
#
# Requirements:
#   - `gh` CLI authenticated (run `gh auth login` once)
#   - jq
#
# Schedule (Monday standup example — crontab -e):
#   0 9 * * 1 /path/to/pr-standup-brief.sh myorg/myrepo 5
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO="${1:-}"
STALE_DAYS="${2:-5}"

if [[ -z "$REPO" ]]; then
  echo "Usage: $0 OWNER/REPO [STALE_DAYS]" >&2
  exit 1
fi

command -v gh  >/dev/null 2>&1 || { echo "Error: 'gh' CLI not found. Install from https://cli.github.com/" >&2; exit 1; }
command -v jq  >/dev/null 2>&1 || { echo "Error: 'jq' not found. Install with: brew install jq" >&2; exit 1; }

NOW_EPOCH=$(date +%s)
STALE_SECONDS=$(( STALE_DAYS * 86400 ))

# ── Fetch all open PRs ────────────────────────────────────────────────────────
PRS=$(gh pr list \
  --repo "$REPO" \
  --state open \
  --limit 100 \
  --json number,title,author,createdAt,updatedAt,reviewDecision,isDraft,labels,url,reviews,assignees,mergeable \
  2>/dev/null)

TOTAL=$(echo "$PRS" | jq 'length')

# ── Categorise ────────────────────────────────────────────────────────────────
READY_JSON=$(echo "$PRS" | jq '[.[] |
  select(
    .isDraft == false and
    .reviewDecision == "APPROVED" and
    .mergeable == "MERGEABLE"
  )
]')

BLOCKED_JSON=$(echo "$PRS" | jq '[.[] |
  select(
    .isDraft == false and
    (.reviewDecision == "CHANGES_REQUESTED" or
     (.reviewDecision == "REVIEW_REQUIRED" and (.reviews | length) > 0))
  )
]')

AWAITING_REVIEW_JSON=$(echo "$PRS" | jq '[.[] |
  select(
    .isDraft == false and
    .reviewDecision == "REVIEW_REQUIRED" and
    (.reviews | length) == 0
  )
]')

STALE_JSON=$(echo "$PRS" | jq --argjson now "$NOW_EPOCH" --argjson stale "$STALE_SECONDS" '[.[] |
  select(
    (now - (.updatedAt | fromdateiso8601)) > $stale
  )
]')

DRAFT_JSON=$(echo "$PRS" | jq '[.[] | select(.isDraft == true)]')

# ── Helper ────────────────────────────────────────────────────────────────────
print_pr_list() {
  local json="$1"
  local count
  count=$(echo "$json" | jq 'length')
  if [[ "$count" -eq 0 ]]; then
    echo "  (none)"
    return
  fi
  echo "$json" | jq -r '.[] |
    "  #\(.number)  \(.title)  — @\(.author.login)\n         \(.url)"'
}

# ── Output ────────────────────────────────────────────────────────────────────
TODAY=$(date "+%A, %B %-d")
READY_COUNT=$(echo "$READY_JSON"              | jq 'length')
BLOCKED_COUNT=$(echo "$BLOCKED_JSON"          | jq 'length')
AWAITING_COUNT=$(echo "$AWAITING_REVIEW_JSON" | jq 'length')
STALE_COUNT=$(echo "$STALE_JSON"              | jq 'length')
DRAFT_COUNT=$(echo "$DRAFT_JSON"              | jq 'length')

cat <<EOF

╔══════════════════════════════════════════════════════════════╗
║  📋  PR Standup Brief — ${TODAY}
║  Repo: ${REPO}  |  Open PRs: ${TOTAL}
╚══════════════════════════════════════════════════════════════╝

✅  READY TO MERGE  (${READY_COUNT})
$(print_pr_list "$READY_JSON")

🔴  BLOCKED / CHANGES REQUESTED  (${BLOCKED_COUNT})
$(print_pr_list "$BLOCKED_JSON")

👀  AWAITING FIRST REVIEW  (${AWAITING_COUNT})
$(print_pr_list "$AWAITING_REVIEW_JSON")

🕰️   STALE (no activity >${STALE_DAYS}d)  (${STALE_COUNT})
$(echo "$STALE_JSON" | jq -r --argjson now "$NOW_EPOCH" '.[] |
  "  #\(.number)  @\(.author.login)  — last updated \( (($now - (.updatedAt | fromdateiso8601)) / 86400 | floor) )d ago\n         \(.url)"')

🚧  DRAFTS  (${DRAFT_COUNT})
$(print_pr_list "$DRAFT_JSON")

EOF

# ── Action prompts ─────────────────────────────────────────────────────────────
[[ "$READY_COUNT"   -gt 0 ]] && echo "⚡ ${READY_COUNT} PR(s) approved & mergeable — land them before standup!"
[[ "$BLOCKED_COUNT" -gt 0 ]] && echo "⚡ ${BLOCKED_COUNT} PR(s) need author follow-up on review feedback."
[[ "$AWAITING_COUNT" -gt 0 ]] && echo "⚡ ${AWAITING_COUNT} PR(s) waiting on first reviewer — assign someone now."
[[ "$STALE_COUNT"   -gt 0 ]] && echo "⚡ ${STALE_COUNT} PR(s) gone quiet — ping authors or close."

echo ""

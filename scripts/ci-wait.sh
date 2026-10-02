#!/usr/bin/env bash
# Usage: scripts/ci-wait.sh [sha]  — wait until the "iOS native" run for sha (default HEAD) completes, then print ci-status.
# Polls every 2 minutes: the public API allows 60 requests per hour without a token.
set -uo pipefail
# head_sha only matches a full SHA, so a short one is expanded first.
SHA=$(git rev-parse "${1:-HEAD}")
API=https://api.github.com/repos/harunhusey556-hub/lashkirja
for _ in $(seq 1 60); do
  state=$(curl -fsS "$API/actions/runs?head_sha=$SHA&per_page=10" 2>/dev/null | python3 -c 'import sys,json
r=[x for x in json.load(sys.stdin)["workflow_runs"] if x["name"]=="iOS native"]
print(r[0]["status"] if r else "none")' 2>/dev/null || echo error)
  [ "$state" = "completed" ] && break
  sleep 120
done
"$(dirname "$0")/ci-status.sh"

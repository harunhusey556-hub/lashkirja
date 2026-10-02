#!/usr/bin/env bash
# Usage: scripts/ci-status.sh [branch]  — latest "iOS native" run, its jobs and error annotations.
# Public repo: no token needed (60 requests per hour).
set -euo pipefail
REPO=harunhusey556-hub/lashkirja
BRANCH=${1:-native}
API=https://api.github.com/repos/$REPO
run=$(curl -fsS "$API/actions/runs?branch=$BRANCH&per_page=10" |
  python3 -c 'import sys,json; r=[x for x in json.load(sys.stdin)["workflow_runs"] if x["name"]=="iOS native"]; print(r[0]["id"] if r else "")')
[ -z "$run" ] && { echo "no run"; exit 1; }
curl -fsS "$API/actions/runs/$run" | python3 -c 'import sys,json; r=json.load(sys.stdin); print(r["head_sha"][:7], r["status"], r["conclusion"], r["html_url"])'
curl -fsS "$API/actions/runs/$run/jobs" | python3 -c '
import sys,json,urllib.request
for j in json.load(sys.stdin)["jobs"]:
    print(f"- {j[\"name\"]}: {j[\"status\"]} {j[\"conclusion\"]}")
    ann=json.load(urllib.request.urlopen(f"https://api.github.com/repos/harunhusey556-hub/lashkirja/check-runs/{j[\"id\"]}/annotations"))
    for a in ann[:40]:
        print(f"    {a[\"annotation_level\"]} {a[\"path\"]}:{a[\"start_line\"]} {a[\"message\"][:300]}")'

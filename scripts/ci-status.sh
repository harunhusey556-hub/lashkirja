#!/usr/bin/env bash
# Usage: scripts/ci-status.sh [branch]  — latest "iOS native" run, its jobs and error annotations.
exec python3 "$(dirname "$0")/ci-status.py" "${1:-native}"

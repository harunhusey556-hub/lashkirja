#!/usr/bin/env bash
# Runs the mobile e2e suite through the harness: run-e2e.sh <export root> <log file>
# LASHKIRJA_E2E_STORAGE_STATE should point at a saved session (login is rate-limited).
set -u
cd "$(dirname "$0")/../../../../../app"
EXPORT_ROOT="$1" npx playwright test -c ../.superpowers/quality/batch-3/laneB/harness/playwright.harness.config.ts > "$2" 2>&1
echo "EXIT $?" >> "$2"

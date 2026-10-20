#!/usr/bin/env bash
# Warms a freshly started demo API before a motion walk: every route the walk opens, once, as the
# demo user. A cold route compiles or fills its caches on first use, and the screen then waits on
# that instead of on the app (docs/quality/SIMULATOR.md §4).
#   scripts/sim/warm-api.sh [base-url, default http://127.0.0.1:3999]
set -u
B=${1:-http://127.0.0.1:3999}
PY=${PYTHON:-python3}
tok=$(curl -s -X POST "$B/api/auth/token" -H 'content-type: application/json' \
  -d '{"email":"demo@lashkirja.fi","password":"demo123"}' | $PY -c 'import json,sys; print(json.load(sys.stdin)["token"])')
[ -n "$tok" ] || { echo "warm-api: no token from $B"; exit 1; }
get() { curl -s -o /dev/null -w "%{http_code} %{time_total}s $1\n" --max-time 120 -H "authorization: Bearer $tok" "$B$1"; }
m=$(date +%Y-%m); y=$(date +%Y)
for p in /api/bootstrap /api/auth/me /api/sync/version /api/profile /api/onboarding "/api/dashboard?month=$m" \
  "/api/dashboard/month?month=$m" /api/period-lock /api/receipts /api/receipts/counts /api/receipts/inbox \
  /api/invoices /api/invoices/counts /api/invoices/sequence /api/invoices/match /api/customers /api/catalog \
  /api/recurring-invoices /api/invoice-email-templates "/api/reports/profit-loss?from=$y-01&to=$y-12" /api/ledger \
  "/api/alv?period=$m" /api/bank-accounts /api/statements /api/statements/counts /api/bank/connections \
  /api/purchase-invoices /api/purchase-invoices/counts /api/purchase-invoices/match /api/recurring-purchases \
  /api/matching/candidates /api/matching/purchase-candidates /api/work-queue /api/notifications /api/jobs \
  /api/vendor-rules /api/auth/sessions /api/auth/passkey/status /api/ai/status /api/ai/conversations \
  /api/integrations/imap /api/pos/status /api/pos/settings; do get "$p"; done
inv=$(curl -s -H "authorization: Bearer $tok" "$B/api/invoices" | $PY -c 'import json,sys; print(json.load(sys.stdin)["invoices"][0]["id"])')
cus=$(curl -s -H "authorization: Bearer $tok" "$B/api/customers" | $PY -c 'import json,sys; print(json.load(sys.stdin)["customers"][0]["id"])')
for p in "/api/invoices/$inv" "/api/invoices/$inv/reminders" "/api/invoices/$inv/payments" "/api/customers/$cus"; do get "$p"; done

#!/usr/bin/env bash
#
# End-to-end smoke test for the CREHQ REST API endpoints this MCP server wraps.
# Exercises the live API directly with curl so you can confirm your key works
# and see real response shapes BEFORE wiring the server into a client.
#
# Usage:
#   export CREHQ_API_KEY=crehq_live_xxxxx
#   ./test.sh
#
# Get a free sandbox key (1,000 calls/mo) at https://crehq.com/developers/sandbox/
#
set -uo pipefail

BASE="${CREHQ_API_BASE:-https://crehq.com/wp-json/crehq/v1}"
KEY="${CREHQ_API_KEY:-}"

if [[ -z "$KEY" ]]; then
  echo "ERROR: CREHQ_API_KEY is not set."
  echo "Get a free sandbox key at https://crehq.com/developers/sandbox/ then:"
  echo "  export CREHQ_API_KEY=crehq_live_xxxxx && ./test.sh"
  exit 1
fi

pass=0; fail=0

# hit <label> <method> <path> [curl-data-args...]
hit() {
  local label="$1"; local method="$2"; local path="$3"; shift 3
  echo "──────────────────────────────────────────────────────────"
  echo "▶ $label"
  echo "  $method $BASE$path"
  local code
  code=$(curl -s -o /tmp/crehq_test_body.json -w "%{http_code}" \
    -X "$method" \
    -H "Authorization: Bearer $KEY" \
    -H "X-API-Key: $KEY" \
    -H "Accept: application/json" \
    "$@" \
    "$BASE$path")
  echo "  HTTP $code"
  head -c 600 /tmp/crehq_test_body.json; echo
  if [[ "$code" =~ ^2 ]]; then pass=$((pass+1)); else fail=$((fail+1)); fi
}

hit "Datasets categories"          GET "/datasets/categories"
hit "Companies (page 1, 2 rows)"   GET "/companies?per_page=2&page=1"
hit "Company search: chipotle"     GET "/companies/search?q=chipotle"
hit "Datasets list (2 rows)"       GET "/datasets?per_page=2"
hit "Locations list (2 rows)"      GET "/locations?per_page=2"
hit "Geographic trends"            GET "/trends/geographic?country=US"

echo "──────────────────────────────────────────────────────────"
echo "RESULTS: $pass passed, $fail failed"
echo "(403 'Invalid or revoked API key' = key problem; 200 = working.)"
[[ "$fail" -eq 0 ]]

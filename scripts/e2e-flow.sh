#!/usr/bin/env bash
# Post-deploy smoke test. Safe to run against production: it only reads public
# endpoints and checks security properties — it never creates data.
#
#   BASE=https://app.example.com bash scripts/e2e-flow.sh          # single-domain (API under /api)
#   BASE=http://localhost:4000 API=http://localhost:4000 bash scripts/e2e-flow.sh   # API at root (dev)
#
# Exit code is non-zero if any check fails, so it can gate a deploy pipeline.
set -u
BASE=${BASE:-http://localhost:4000}
API=${API:-$BASE/api}
PASS=0; FAIL=0
ok()    { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()   { echo "  FAIL  $1  -> $2"; FAIL=$((FAIL+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3' got '$2'"; fi; }
code()  { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== Health"
check "liveness /health" "$(code "$API/health")" "200"
check "readiness /ready (database reachable)" "$(code "$API/ready")" "200"

echo "== Auth surface"
check "anonymous /me is 401" "$(code "$API/me")" "401"
check "providers endpoint" "$(code "$API/auth/providers")" "200"
check "cross-site login is blocked (CSRF)" "$(code -X POST -H 'content-type: application/json' -H 'origin: https://evil.example' "$API/auth/login" -d '{"email":"a@b.co","password":"x"}')" "403"
check "wrong password is 401" "$(code -X POST -H 'content-type: application/json' "$API/auth/login" -d '{"email":"smoke-nobody@example.com","password":"wrong-pass-1"}')" "401"
check "dev-login is disabled" "$(code -X POST -H 'content-type: application/json' "$API/auth/dev-login" -d '{"email":"a@b.co"}')" "404"

echo "== Webhooks reject unauthenticated calls"
# 400 = signature required; 404 = Stripe is not configured on this deployment (endpoint disabled).
w=$(code -X POST -H 'content-type: application/json' "$API/integrations/stripe/webhook" -d '{}'); [ "$w" = "400" ] || [ "$w" = "404" ] && ok "Stripe webhook without signature ($w)" || bad "Stripe webhook without signature" "got $w"
w=$(code -X POST -H 'content-type: application/json' "$API/inbound/postmark" -d '{}'); [ "$w" = "401" ] || [ "$w" = "503" ] && ok "Postmark inbound without token ($w)" || bad "Postmark inbound without token" "got $w"
check "cron without secret" "$(code "$API/cron/dunning")" "401"

echo "== Web app"
check "SPA shell" "$(code "$BASE/login")" "200"
headers=$(curl -sI "$BASE/login")
echo "$headers" | grep -qi "content-security-policy" && ok "CSP header" || bad "CSP header" "missing"
echo "$headers" | grep -qi "x-content-type-options: nosniff" && ok "nosniff header" || bad "nosniff header" "missing"
case "$BASE" in https://*) echo "$headers" | grep -qi "strict-transport-security" && ok "HSTS header" || bad "HSTS header" "missing";; esac

echo
echo "Result: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

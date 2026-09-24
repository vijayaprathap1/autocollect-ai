#!/usr/bin/env bash
# End-to-end smoke test of the core AutoCollect flows against a running API.
# Runs in mock mode (no real Stripe/Postmark keys): Stripe events go through
# the dev simulator, emails get fake provider IDs.
#
#   API=http://localhost:4000 CRON_SECRET=... bash scripts/e2e-flow.sh
set -u
API=${API:-http://localhost:4000}
CRON_SECRET=${CRON_SECRET:-test-cron-secret}
JAR=$(mktemp)
PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1  -> $2"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$3' got '$2'"; fi; }
j()    { curl -s -b "$JAR" -c "$JAR" -H 'content-type: application/json' "$@"; }

echo "== Auth"
code=$(j -o /dev/null -w '%{http_code}' -X POST "$API/auth/login" -d '{"email":"dev-user@autocollect.local","password":"dev-password-auto"}')
check "login" "$code" "200"
check "/me returns user" "$(j "$API/me" | jq -r '.user.email // .email')" "dev-user@autocollect.local"

echo "== Setup: approve templates, enable workflow"
for id in $(j "$API/templates" | jq -r '.templates[].id'); do
  j -X PUT "$API/templates/$id" -d '{"approved":true}' >/dev/null
done
check "all templates approved" "$(j "$API/templates" | jq '[.templates[] | select(.approved|not)] | length')" "0"
WF=$(j "$API/workflows" | jq -r '.workflows[0].id')
j -X PUT "$API/workflows/$WF" -d '{"enabled":true}' >/dev/null
check "workflow enabled" "$(j "$API/workflows" | jq -r '.workflows[0].enabled')" "true"

echo "== Stripe connect (mock OAuth)"
URL=$(j -X POST "$API/integrations/stripe/connect" -d "{}" | jq -r .url)
loc=$(curl -s -b "$JAR" -o /dev/null -w '%{redirect_url}' "$URL")
case "$loc" in *stripe=connected*) ok "OAuth callback redirects to settings?stripe=connected";; *) bad "OAuth callback" "$loc";; esac

echo "== Stripe invoice ingest (webhook simulator)"
S=$RANDOM
A=in_e2e_a_$S; B=in_e2e_b_$S
j -X POST "$API/integrations/stripe/dev-event" -d "{\"type\":\"invoice.created\",\"invoice\":{\"id\":\"$A\",\"amount_due\":50000,\"customer\":\"cus_a_$S\",\"customer_email\":\"a$S@example.com\",\"customer_name\":\"Client A\",\"due_days\":-10}}" >/dev/null
j -X POST "$API/integrations/stripe/dev-event" -d "{\"type\":\"invoice.created\",\"invoice\":{\"id\":\"$B\",\"amount_due\":70000,\"customer\":\"cus_b_$S\",\"customer_email\":\"b$S@example.com\",\"customer_name\":\"Client B\",\"due_days\":-10}}" >/dev/null
INV=$(j "$API/invoices?limit=200")
IA=$(echo "$INV" | jq -r --arg x "$A" '.invoices[] | select(.externalId==$x) | .id')
IB=$(echo "$INV" | jq -r --arg x "$B" '.invoices[] | select(.externalId==$x) | .id')
[ -n "$IA" ] && ok "invoice A ingested" || bad "invoice A ingested" "missing"
[ -n "$IB" ] && ok "invoice B ingested" || bad "invoice B ingested" "missing"

echo "== payment_failed only touches its own invoice"
OPEN_BEFORE=$(psql "$DATABASE_URL" -Atc "select count(*) from invoices where status='open'")
code=$(j -o /dev/null -w '%{http_code}' -X POST "$API/integrations/stripe/dev-event" -d "{\"type\":\"invoice.payment_failed\",\"invoice\":{\"id\":\"$A\",\"failure_reason\":\"Card declined\",\"failure_code\":\"card_declined\"}}")
check "payment_failed accepted" "$code" "200"
check "invoice B untouched" "$(psql "$DATABASE_URL" -Atc "select status from invoices where id='$IB'")" "open"
check "invoice A failure recorded" "$(psql "$DATABASE_URL" -Atc "select last_payment_failure_code from invoices where id='$IA'")" "card_declined"
OPEN_AFTER=$(psql "$DATABASE_URL" -Atc "select count(*) from invoices where status='open'")
check "no other invoices changed status" "$OPEN_AFTER" "$OPEN_BEFORE"

echo "== Follow-up email (send now + cron)"
r=$(j -X POST "$API/invoices/$IB/actions" -d '{"action":"send_now"}')
check "send_now sends" "$(echo "$r" | jq -r .sent)" "true"
check "message row is 'sent'" "$(psql "$DATABASE_URL" -Atc "select status from messages where invoice_id='$IB' order by created_at limit 1")" "sent"
code=$(curl -s -o /tmp/cron.json -w '%{http_code}' -H "authorization: Bearer $CRON_SECRET" "$API/cron/dunning")
check "cron accepts Vercel 'Authorization: Bearer' header" "$code" "200"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "x-cron-secret: $CRON_SECRET" "$API/cron/dunning")
check "cron accepts x-cron-secret header" "$code" "200"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer wrong" "$API/cron/dunning")
check "cron rejects wrong secret" "$code" "401"

echo "== Failed send is retried (not stuck forever)"
psql "$DATABASE_URL" -qc "update messages set status='failed', provider_msg_id=null where invoice_id='$IA'" >/dev/null
psql "$DATABASE_URL" -qc "insert into messages (tenant_id, invoice_id, step_index, status) select tenant_id, id, next_step_index, 'failed' from invoices where id='$IA' on conflict do nothing" >/dev/null
r=$(j -X POST "$API/invoices/$IA/actions" -d '{"action":"send_now"}')
check "retry after failed send succeeds" "$(echo "$r" | jq -r .sent)" "true"

echo "== Postmark delivery webhooks (single-object RecordType payloads)"
MID=$(psql "$DATABASE_URL" -Atc "select provider_msg_id from messages where invoice_id='$IB' and provider_msg_id is not null limit 1")
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -X POST "$API/email/webhook/postmark" -d "{\"RecordType\":\"Delivery\",\"MessageID\":\"$MID\"}")
check "Delivery webhook accepted" "$code" "200"
check "message -> delivered" "$(psql "$DATABASE_URL" -Atc "select status from messages where provider_msg_id='$MID'")" "delivered"
curl -s -o /dev/null -H 'content-type: application/json' -X POST "$API/email/webhook/postmark" -d "{\"RecordType\":\"Open\",\"MessageID\":\"$MID\"}"
curl -s -o /dev/null -H 'content-type: application/json' -X POST "$API/email/webhook/postmark" -d "{\"RecordType\":\"Delivery\",\"MessageID\":\"$MID\"}"
check "late Delivery does not downgrade 'opened'" "$(psql "$DATABASE_URL" -Atc "select status from messages where provider_msg_id='$MID'")" "opened"

echo "== Payment stops reminders"
j -X POST "$API/integrations/stripe/dev-event" -d "{\"type\":\"invoice.paid\",\"invoice\":{\"id\":\"$B\"}}" >/dev/null
check "invoice.paid -> paid" "$(psql "$DATABASE_URL" -Atc "select status from invoices where id='$IB'")" "paid"
check "sequence stopped" "$(psql "$DATABASE_URL" -Atc "select next_step_index from invoices where id='$IB'")" "9999"

echo "== CSV import"
CSV=$(mktemp --suffix=.csv)
printf 'invoice_number,customer_name,customer_email,amount,due_date\nCSV-%s,Csv Client,csv%s@example.com,250.00,2026-01-15\n' "$S" "$S" > "$CSV"
r=$(curl -s -b "$JAR" -F "file=@$CSV;type=text/csv" "$API/integrations/csv/import")
check "csv row imported" "$(echo "$r" | jq -r '.imported')" "1"
IC=$(psql "$DATABASE_URL" -Atc "select id from invoices where external_id='CSV-$S'")
r=$(j -X POST "$API/invoices/$IC/pay-link" -d '{}')
case "$(echo "$r" | jq -r .paymentLink)" in https://*) ok "pay link created for CSV invoice";; *) bad "pay link" "$r";; esac

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]

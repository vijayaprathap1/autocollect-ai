-- Migration 026: retryable sends + default sequence backfill.

-- 1) Failed sends are now retried with backoff instead of blocking the
--    invoice forever (the unique (tenant, invoice, step) row used to make
--    every later attempt fail with a unique violation).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_error TEXT;

-- 2) Workspaces created by signup / super admin got a default workflow with
--    zero steps and no templates, so they could never send a reminder.
--    Give them the default (unapproved) templates and link the steps.
--    Workflows that already have steps are left untouched.
INSERT INTO templates (tenant_id, step_key, subject, body, approved)
SELECT w.tenant_id, v.step_key, v.subject, v.body, FALSE
  FROM workflows w
 CROSS JOIN (VALUES
   ('reminder_pre', 'Quick heads-up: {client_name} — invoice {amount} coming due',
    E'Hi {client_name},\n\nJust a quick heads-up that invoice {amount} is due {due_date}. You can pay in one click here: {pay_link}\n\nThanks for your business!\n{company_name}'),
   ('reminder_1d', 'Invoice {amount} is now due — {client_name}',
    E'Hi {client_name},\n\nA gentle reminder that invoice {amount} is now due. You can settle it here: {pay_link}\n\nLet us know if anything looks off.\n{company_name}'),
   ('reminder_7d', 'Reminder: invoice {amount} from {company_name}',
    E'Hi {client_name},\n\nThis is a reminder that invoice {amount} is past due. Please arrange payment at your earliest convenience: {pay_link}\n\nIf you have questions, just reply.\n{company_name}'),
   ('reminder_14d', 'Overdue: invoice {amount} ({company_name})',
    E'Hi {client_name},\n\nInvoice {amount} remains unpaid and is now overdue. Please make payment here promptly: {pay_link}\n\nWe value the relationship — reach out if there''s an issue we can resolve.\n{company_name}')
 ) AS v(step_key, subject, body)
 WHERE w.is_default = TRUE
   AND (w.steps IS NULL OR jsonb_array_length(w.steps) = 0)
ON CONFLICT (tenant_id, step_key) DO NOTHING;

UPDATE workflows w
   SET steps = s.steps
  FROM (
    SELECT t.tenant_id,
           jsonb_agg(jsonb_build_object(
             'order', d.ord, 'delayDays', d.delay_days, 'channel', 'email', 'templateId', t.id
           ) ORDER BY d.ord) AS steps
      FROM templates t
      JOIN (VALUES ('reminder_pre', 0, -2), ('reminder_1d', 1, 1),
                   ('reminder_7d', 2, 7), ('reminder_14d', 3, 14)) AS d(step_key, ord, delay_days)
        ON d.step_key = t.step_key
     GROUP BY t.tenant_id
  ) s
 WHERE w.tenant_id = s.tenant_id
   AND w.is_default = TRUE
   AND (w.steps IS NULL OR jsonb_array_length(w.steps) = 0);

-- 3) Every tenant needs a credit wallet or no reminder is ever sent
--    ("dunning_skipped_no_credits"). The dev seed never created one.
INSERT INTO credit_wallets (tenant_id, balance)
SELECT t.id, 50 FROM tenants t
 WHERE NOT EXISTS (SELECT 1 FROM credit_wallets w WHERE w.tenant_id = t.id);

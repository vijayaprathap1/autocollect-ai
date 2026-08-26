-- Reserve each automated send before contacting an external provider.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('sending','sent','delivered','opened','clicked','bounced','failed'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'usd';

UPDATE tenants
   SET currency = CASE
     WHEN lower(trim(currency)) ~ '^[a-z]{3}$' THEN lower(trim(currency))
     ELSE 'usd'
   END;

ALTER TABLE tenants ALTER COLUMN currency SET DEFAULT 'usd';
ALTER TABLE tenants ALTER COLUMN currency SET NOT NULL;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_currency_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_currency_check CHECK (currency ~ '^[a-z]{3}$');
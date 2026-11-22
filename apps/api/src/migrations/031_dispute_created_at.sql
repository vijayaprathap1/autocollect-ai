-- disputes needed created_at so the workspace export can order every table the same way.
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

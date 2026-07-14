ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ui_language VARCHAR(2) NOT NULL DEFAULT 'fa'
  CHECK (ui_language IN ('fa', 'en'));

CREATE TABLE IF NOT EXISTS email_change_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_email VARCHAR(255) NOT NULL,
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_change_tokens_user
  ON email_change_tokens(user_id, created_at DESC);

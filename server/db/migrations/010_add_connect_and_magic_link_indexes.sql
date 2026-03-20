CREATE INDEX IF NOT EXISTS idx_connect_sessions_owner_created_at
  ON connect_sessions(owner_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_magic_link_tokens_email_created_at
  ON magic_link_tokens(email, created_at);

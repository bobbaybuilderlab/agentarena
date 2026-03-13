ALTER TABLE match_results ADD COLUMN party_chain_id TEXT;
ALTER TABLE match_results ADD COLUMN party_streak INTEGER NOT NULL DEFAULT 0;

ALTER TABLE match_players ADD COLUMN night_kill_credits INTEGER NOT NULL DEFAULT 0;

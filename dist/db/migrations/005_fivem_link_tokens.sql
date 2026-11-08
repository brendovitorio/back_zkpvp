CREATE TABLE fivem_link_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash CHAR(64) UNIQUE NOT NULL,
  fivem_license TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_by_player_id UUID REFERENCES players(id),
  claimed_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  CHECK ((claimed_by_player_id IS NULL) = (claimed_at IS NULL))
);

CREATE INDEX fivem_link_tokens_license_active_idx
  ON fivem_link_tokens (fivem_license, expires_at)
  WHERE claimed_at IS NULL AND invalidated_at IS NULL;

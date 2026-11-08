ALTER TABLE staff_accounts
  ADD COLUMN role TEXT NOT NULL DEFAULT 'attendant'
    CHECK (role IN ('admin','moderator','attendant'));

CREATE TABLE player_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id),
  kind TEXT NOT NULL CHECK (kind IN ('vip','skin','vehicle')),
  entitlement_key TEXT NOT NULL,
  duration_unit TEXT NOT NULL CHECK (duration_unit IN ('days','months','years','lifetime')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_staff UUID REFERENCES staff_accounts(id),
  CHECK ((duration_unit = 'lifetime' AND expires_at IS NULL) OR (duration_unit <> 'lifetime' AND expires_at IS NOT NULL))
);

CREATE INDEX player_entitlements_active_idx
  ON player_entitlements (player_id, kind, entitlement_key, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE staff_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID REFERENCES staff_accounts(id),
  action TEXT NOT NULL,
  target_player_id UUID REFERENCES players(id),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

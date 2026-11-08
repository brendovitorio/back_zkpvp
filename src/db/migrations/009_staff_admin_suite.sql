
-- Staff administration: punishments, support queue, internal notes,
-- notifications and explicit per-account permissions.
CREATE TABLE IF NOT EXISTS player_punishments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id),
  type TEXT NOT NULL CHECK (type IN ('warning','temporary_ban','permanent_ban')),
  reason TEXT NOT NULL,
  evidence_url TEXT,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_by_staff UUID REFERENCES staff_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((type = 'temporary_ban' AND expires_at IS NOT NULL) OR (type <> 'temporary_ban'))
);
CREATE INDEX IF NOT EXISTS player_punishments_active_idx
  ON player_punishments(player_id, created_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS staff_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'support',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  assigned_staff UUID REFERENCES staff_accounts(id),
  created_by_staff UUID REFERENCES staff_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_tickets_queue_idx ON staff_tickets(status, priority, updated_at DESC);

CREATE TABLE IF NOT EXISTS staff_player_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id),
  note TEXT NOT NULL,
  created_by_staff UUID REFERENCES staff_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_player_notes_player_idx ON staff_player_notes(player_id, created_at DESC);

CREATE TABLE IF NOT EXISTS staff_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','success','warning','critical')),
  target_role TEXT CHECK (target_role IN ('admin','moderator','attendant') OR target_role IS NULL),
  created_by_staff UUID REFERENCES staff_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_by UUID[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS staff_account_permissions (
  staff_id UUID NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN (
    'players.read','players.manage','punishments.read','punishments.manage',
    'tickets.read','tickets.manage','store.read','store.manage',
    'orders.read','content.manage','monitor.read','audit.read','team.manage',
    'notifications.manage'
  )),
  effect TEXT NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  granted_by UUID REFERENCES staff_accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, permission)
);

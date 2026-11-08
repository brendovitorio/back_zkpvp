CREATE TABLE players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id TEXT UNIQUE NOT NULL,
  discord_username TEXT NOT NULL,
  fivem_license TEXT UNIQUE,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE clans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tag TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE rankings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id),
  mode TEXT NOT NULL CHECK (mode IN ('diario','semanal','mensal','mvp')),
  stage TEXT NOT NULL,
  position INT NOT NULL,
  eliminations INT NOT NULL DEFAULT 0,
  wins INT NOT NULL DEFAULT 0,
  rating NUMERIC NOT NULL DEFAULT 0,
  clan_id UUID REFERENCES clans(id),
  prizes_text TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE player_stats (
  player_id UUID NOT NULL REFERENCES players(id),
  mode TEXT NOT NULL DEFAULT 'global' CHECK (mode IN ('global','duo','squad')),
  matches INT NOT NULL DEFAULT 0,
  avg_position NUMERIC NOT NULL DEFAULT 0,
  avg_kills NUMERIC NOT NULL DEFAULT 0,
  kd NUMERIC NOT NULL DEFAULT 0,
  wins INT NOT NULL DEFAULT 0,
  ranked BOOLEAN NOT NULL DEFAULT false,
  rating NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, mode)
);

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  prize_text TEXT,
  featured BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE hall_of_fame (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name TEXT NOT NULL,
  champion_name TEXT NOT NULL,
  champion_tag TEXT,
  prize_text TEXT,
  won_at DATE NOT NULL
);

CREATE TABLE changelog_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at DATE NOT NULL,
  categories TEXT[] NOT NULL DEFAULT '{}',
  body TEXT NOT NULL
);

CREATE TABLE home_stats (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE store_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_diamonds INT NOT NULL,
  category TEXT NOT NULL,
  image_url TEXT,
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id),
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','pago','cancelado')),
  total_diamonds INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  store_item_id UUID NOT NULL REFERENCES store_items(id),
  quantity INT NOT NULL,
  unit_price_diamonds INT NOT NULL
);

CREATE TABLE link_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id),
  code TEXT UNIQUE NOT NULL,
  confirmed BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE staff_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

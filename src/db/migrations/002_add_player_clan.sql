ALTER TABLE players ADD COLUMN clan_id UUID REFERENCES clans(id);

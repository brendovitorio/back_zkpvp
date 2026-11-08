-- The ranking UI now uses daily/weekly/monthly labels. Older installations
-- may already have applied migration 001 with the legacy solo/duo/squad
-- constraint, so update the live database rather than relying on editing
-- an already-applied migration file.
ALTER TABLE rankings DROP CONSTRAINT IF EXISTS rankings_mode_check;
UPDATE rankings
SET mode = CASE mode
  WHEN 'solo' THEN 'diario'
  WHEN 'duo' THEN 'semanal'
  WHEN 'squad' THEN 'mensal'
  ELSE mode
END
WHERE mode IN ('solo', 'duo', 'squad');
ALTER TABLE rankings
  ADD CONSTRAINT rankings_mode_check
  CHECK (mode IN ('diario', 'semanal', 'mensal', 'mvp'));

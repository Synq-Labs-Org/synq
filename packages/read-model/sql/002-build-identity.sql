ALTER TABLE __SCHEMA__.rm_checkpoint ADD COLUMN IF NOT EXISTS build_id text;
UPDATE __SCHEMA__.rm_checkpoint
  SET build_id = '0x' || replace(gen_random_uuid()::text, '-', '')
  WHERE build_id IS NULL;
ALTER TABLE __SCHEMA__.rm_checkpoint ALTER COLUMN build_id SET NOT NULL;
ALTER TABLE __SCHEMA__.rm_checkpoint ADD CONSTRAINT rm_checkpoint_build_id_format CHECK (build_id ~ '^0x[0-9a-f]{32}$');

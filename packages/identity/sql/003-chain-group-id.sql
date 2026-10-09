ALTER TABLE identity_group
  ADD COLUMN IF NOT EXISTS chain_group_id text CHECK (chain_group_id ~ '^0x[0-9a-f]{64}$');
UPDATE identity_group SET chain_group_id = group_id
  WHERE chain_group_id IS NULL AND group_id ~ '^0x[0-9a-f]{64}$';

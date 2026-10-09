ALTER TABLE __SCHEMA__.rm_checkpoint ADD COLUMN IF NOT EXISTS lineage text;
UPDATE __SCHEMA__.rm_checkpoint
  SET lineage = '0x' || encode(sha256(convert_to('synq:rm:lineage:' || build_id || ':' || generation::text, 'UTF8')), 'hex')
  WHERE lineage IS NULL;
ALTER TABLE __SCHEMA__.rm_checkpoint ALTER COLUMN lineage SET NOT NULL;
ALTER TABLE __SCHEMA__.rm_checkpoint ADD CONSTRAINT rm_checkpoint_lineage_format CHECK (lineage ~ '^0x[0-9a-f]{64}$');
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_lineage (
  chain_id bigint NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  lineage text NOT NULL CHECK (lineage ~ '^0x[0-9a-f]{64}$'),
  PRIMARY KEY (chain_id, generation)
);
INSERT INTO __SCHEMA__.rm_lineage(chain_id, generation, lineage)
  SELECT chain_id, generation, lineage FROM __SCHEMA__.rm_checkpoint
  ON CONFLICT DO NOTHING;

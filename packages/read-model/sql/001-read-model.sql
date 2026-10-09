CREATE TABLE IF NOT EXISTS synq_projection_checkpoint (
  chain_id bigint PRIMARY KEY,
  indexed_through_block bigint NOT NULL CHECK (indexed_through_block >= 0),
  revision bigint NOT NULL CHECK (revision >= 0),
  binding_json jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS synq_chain_event (
  chain_id bigint NOT NULL,
  id text NOT NULL,
  block_number bigint NOT NULL,
  event_json jsonb NOT NULL,
  PRIMARY KEY (chain_id,id)
);
CREATE TABLE IF NOT EXISTS synq_group_projection (
  chain_id bigint NOT NULL,
  group_id text NOT NULL,
  state_json jsonb NOT NULL,
  PRIMARY KEY (chain_id,group_id)
);

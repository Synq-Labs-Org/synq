CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_checkpoint (
  chain_id bigint PRIMARY KEY,
  indexed_through_block bigint NOT NULL CHECK (indexed_through_block >= 0),
  generation bigint NOT NULL CHECK (generation >= 0),
  config_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_event (
  chain_id bigint NOT NULL,
  tx_hash text NOT NULL,
  log_index bigint NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  tx_index bigint NOT NULL,
  event_name text NOT NULL,
  schema_version int NOT NULL,
  scope text[] NOT NULL,
  event jsonb NOT NULL,
  generation bigint NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS rm_event_block ON __SCHEMA__.rm_event (chain_id, block_number);
CREATE INDEX IF NOT EXISTS rm_event_scope ON __SCHEMA__.rm_event USING gin (scope);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_group (
  chain_id bigint NOT NULL,
  group_id text NOT NULL,
  account text NOT NULL,
  registry text NOT NULL,
  module text NOT NULL,
  creator text,
  salt text,
  threshold numeric(78,0),
  guard text,
  paused boolean NOT NULL,
  accounting_status text NOT NULL CHECK (accounting_status IN ('OPEN','FROZEN')),
  created_block bigint NOT NULL,
  created_tx text NOT NULL,
  revision bigint NOT NULL,
  PRIMARY KEY (chain_id, group_id),
  UNIQUE (chain_id, account)
);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_owner (
  chain_id bigint NOT NULL,
  group_id text NOT NULL,
  owner text NOT NULL,
  since_block bigint NOT NULL,
  PRIMARY KEY (chain_id, group_id, owner)
);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_safe_module (
  chain_id bigint NOT NULL,
  group_id text NOT NULL,
  module text NOT NULL,
  enabled boolean NOT NULL,
  updated_block bigint NOT NULL,
  PRIMARY KEY (chain_id, group_id, module)
);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_executor (
  chain_id bigint NOT NULL,
  group_id text NOT NULL,
  executor text NOT NULL,
  allowed boolean NOT NULL,
  updated_block bigint NOT NULL,
  PRIMARY KEY (chain_id, group_id, executor)
);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_mandate (
  chain_id bigint NOT NULL,
  group_id text NOT NULL,
  mandate_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  current_version numeric(78,0) NOT NULL,
  min_valid_version numeric(78,0) NOT NULL,
  spent_token numeric(78,0) NOT NULL,
  spent_native numeric(78,0) NOT NULL,
  PRIMARY KEY (chain_id, group_id, mandate_id)
);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_mandate_version (
  chain_id bigint NOT NULL,
  group_id text NOT NULL,
  mandate_id text NOT NULL,
  version numeric(78,0) NOT NULL,
  mandate_hash text NOT NULL,
  token text NOT NULL,
  max_token_per_action numeric(78,0) NOT NULL,
  max_native_per_action numeric(78,0) NOT NULL,
  cumulative_token_cap numeric(78,0) NOT NULL,
  cumulative_native_cap numeric(78,0) NOT NULL,
  valid_after numeric(78,0) NOT NULL,
  valid_until numeric(78,0) NOT NULL,
  call_targets jsonb NOT NULL,
  call_selectors jsonb NOT NULL,
  recipients jsonb NOT NULL,
  security_sensitive boolean,
  configured_block bigint NOT NULL,
  configured_tx text NOT NULL,
  PRIMARY KEY (chain_id, group_id, mandate_id, version)
);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_spend (
  chain_id bigint NOT NULL,
  tx_hash text NOT NULL,
  log_index bigint NOT NULL,
  group_id text NOT NULL,
  mandate_id text NOT NULL,
  version numeric(78,0) NOT NULL,
  token_amount numeric(78,0) NOT NULL,
  native_amount numeric(78,0) NOT NULL,
  spent_token numeric(78,0) NOT NULL,
  spent_native numeric(78,0) NOT NULL,
  block_number bigint NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS rm_spend_group ON __SCHEMA__.rm_spend (chain_id, group_id);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_grant_executed (
  chain_id bigint NOT NULL,
  group_id text NOT NULL,
  nonce numeric(78,0) NOT NULL,
  intent_hash text NOT NULL,
  mandate_id text NOT NULL,
  mandate_version numeric(78,0) NOT NULL,
  executor text NOT NULL,
  plugin_id text NOT NULL,
  grant_hash text NOT NULL,
  target text NOT NULL,
  selector text NOT NULL,
  token text NOT NULL,
  recipient text NOT NULL,
  token_amount numeric(78,0) NOT NULL,
  native_value numeric(78,0) NOT NULL,
  output_amount numeric(78,0) NOT NULL,
  tx_hash text NOT NULL,
  log_index bigint NOT NULL,
  block_number bigint NOT NULL,
  PRIMARY KEY (chain_id, group_id, nonce),
  UNIQUE (chain_id, group_id, intent_hash)
);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_cancelled_nonce (
  chain_id bigint NOT NULL,
  group_id text NOT NULL,
  nonce numeric(78,0) NOT NULL,
  block_number bigint NOT NULL,
  PRIMARY KEY (chain_id, group_id, nonce)
);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_tracked_account (
  chain_id bigint NOT NULL,
  account text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('GROUP','OBSERVED')),
  group_id text,
  PRIMARY KEY (chain_id, account)
);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_balance (
  chain_id bigint NOT NULL,
  account text NOT NULL,
  asset text NOT NULL,
  balance numeric(78,0) NOT NULL CHECK (balance >= 0),
  baseline_block bigint NOT NULL,
  baseline_balance numeric(78,0) NOT NULL,
  last_block bigint NOT NULL,
  PRIMARY KEY (chain_id, account, asset)
);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_reconciliation_signal (
  seq bigserial UNIQUE,
  id text PRIMARY KEY,
  chain_id bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','RESOLVED')),
  signal jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS rm_signal_open ON __SCHEMA__.rm_reconciliation_signal (chain_id, status);
CREATE TABLE IF NOT EXISTS __SCHEMA__.rm_mandate_artifact (
  chain_id bigint NOT NULL,
  mandate_hash text NOT NULL,
  artifact jsonb NOT NULL,
  PRIMARY KEY (chain_id, mandate_hash)
);

import { applyMigrations, type Migration, type SqlPool } from '@synq/domain/pg';

/**
 * Durable execution state: the payout outbox, consumed Kernel grants, CCTP
 * saga legs and Gateway buckets. Kept in this package's own migrations table
 * (`synq_execution_migrations`), separate from the finance ledger's.
 *
 * Every row that holds signed bytes is immutable once written: a trigger
 * refuses any change to the key, signed bytes, hash, sender or nonce, and any
 * transition out of a terminal state, so even a buggy caller cannot make the
 * store "forget" what was signed.
 */
export const EXECUTION_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `CREATE TABLE IF NOT EXISTS synq_arc_payout_outbox (
      key text PRIMARY KEY,
      state text NOT NULL CHECK (state IN ('SIGNED','CONFIRMED','FAILED','NEEDS_REVIEW')),
      chain_id int NOT NULL,
      from_address text NOT NULL,
      tx_nonce bigint NOT NULL,
      hash text NOT NULL UNIQUE,
      raw text NOT NULL,
      prepared jsonb NOT NULL,
      evidence jsonb,
      note text,
      grant_id text UNIQUE,
      created_at bigint NOT NULL,
      updated_at bigint NOT NULL,
      UNIQUE (chain_id, from_address, tx_nonce));
    CREATE OR REPLACE FUNCTION synq_arc_payout_outbox_guard() RETURNS trigger AS $$
    BEGIN
      IF NEW.key <> OLD.key OR NEW.raw <> OLD.raw OR NEW.hash <> OLD.hash
         OR NEW.chain_id <> OLD.chain_id OR NEW.from_address <> OLD.from_address
         OR NEW.tx_nonce <> OLD.tx_nonce OR NEW.prepared <> OLD.prepared
         OR NEW.grant_id IS DISTINCT FROM OLD.grant_id THEN
        RAISE EXCEPTION 'synq_arc_payout_outbox: signed fields are immutable';
      END IF;
      IF OLD.state <> 'SIGNED' AND NEW.state <> OLD.state THEN
        RAISE EXCEPTION 'synq_arc_payout_outbox: % is terminal', OLD.state;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS synq_arc_payout_outbox_guard ON synq_arc_payout_outbox;
    CREATE TRIGGER synq_arc_payout_outbox_guard BEFORE UPDATE ON synq_arc_payout_outbox
      FOR EACH ROW EXECUTE FUNCTION synq_arc_payout_outbox_guard();
    CREATE OR REPLACE FUNCTION synq_execution_no_delete() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS synq_arc_payout_outbox_keep ON synq_arc_payout_outbox;
    CREATE TRIGGER synq_arc_payout_outbox_keep BEFORE DELETE ON synq_arc_payout_outbox
      FOR EACH ROW EXECUTE FUNCTION synq_execution_no_delete();`,
    down: `DROP TABLE IF EXISTS synq_arc_payout_outbox;
    DROP FUNCTION IF EXISTS synq_arc_payout_outbox_guard();
    DROP FUNCTION IF EXISTS synq_execution_no_delete();`,
  },
  {
    version: 2,
    up: `CREATE TABLE IF NOT EXISTS synq_consumed_grants (
      grant_id text PRIMARY KEY,
      nonce text NOT NULL UNIQUE,
      intent_id text,
      mandate_id text,
      action_hash text,
      chain_id int,
      consumed_at bigint NOT NULL);
    DROP TRIGGER IF EXISTS synq_consumed_grants_keep ON synq_consumed_grants;
    CREATE TRIGGER synq_consumed_grants_keep BEFORE DELETE OR UPDATE ON synq_consumed_grants
      FOR EACH ROW EXECUTE FUNCTION synq_execution_no_delete();`,
    down: `DROP TABLE IF EXISTS synq_consumed_grants;`,
  },
  {
    version: 3,
    up: `CREATE TABLE IF NOT EXISTS synq_cctp_sagas (
      transfer_id text PRIMARY KEY,
      state text NOT NULL,
      rev int NOT NULL,
      transfer jsonb NOT NULL,
      review text,
      updated_at bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS synq_cctp_saga_legs (
      transfer_id text NOT NULL REFERENCES synq_cctp_sagas(transfer_id),
      leg text NOT NULL CHECK (leg IN ('APPROVE','BURN','MINT')),
      chain_id int NOT NULL,
      from_address text NOT NULL,
      to_address text NOT NULL,
      tx_nonce bigint NOT NULL,
      hash text NOT NULL UNIQUE,
      raw text NOT NULL,
      recorded_at bigint NOT NULL,
      PRIMARY KEY (transfer_id, leg),
      UNIQUE (chain_id, from_address, tx_nonce));
    DROP TRIGGER IF EXISTS synq_cctp_saga_legs_keep ON synq_cctp_saga_legs;
    CREATE TRIGGER synq_cctp_saga_legs_keep BEFORE DELETE OR UPDATE ON synq_cctp_saga_legs
      FOR EACH ROW EXECUTE FUNCTION synq_execution_no_delete();`,
    down: `DROP TABLE IF EXISTS synq_cctp_saga_legs; DROP TABLE IF EXISTS synq_cctp_sagas;`,
  },
  {
    version: 4,
    up: `CREATE TABLE IF NOT EXISTS synq_gateway_accounts (
      account_id text PRIMARY KEY,
      source_free numeric(78,0) NOT NULL CHECK (source_free >= 0),
      pending numeric(78,0) NOT NULL CHECK (pending >= 0),
      available numeric(78,0) NOT NULL CHECK (available >= 0),
      reserved numeric(78,0) NOT NULL CHECK (reserved >= 0),
      updated_at bigint NOT NULL);
    CREATE TABLE IF NOT EXISTS synq_gateway_deposits (
      chain_id int NOT NULL,
      tx_hash text NOT NULL,
      account_id text NOT NULL REFERENCES synq_gateway_accounts(account_id),
      amount numeric(78,0) NOT NULL CHECK (amount > 0),
      recorded_at bigint NOT NULL,
      PRIMARY KEY (chain_id, tx_hash));
    CREATE TABLE IF NOT EXISTS synq_gateway_burn_intents (
      salt text PRIMARY KEY,
      account_id text NOT NULL REFERENCES synq_gateway_accounts(account_id),
      value numeric(78,0) NOT NULL CHECK (value > 0),
      intent jsonb NOT NULL,
      signature text,
      state text NOT NULL CHECK (state IN ('RESERVED','SUBMITTED','ATTESTED','SETTLED','RELEASED')),
      attestation jsonb,
      mint_tx text UNIQUE,
      updated_at bigint NOT NULL);
    DROP TRIGGER IF EXISTS synq_gateway_deposits_keep ON synq_gateway_deposits;
    CREATE TRIGGER synq_gateway_deposits_keep BEFORE DELETE OR UPDATE ON synq_gateway_deposits
      FOR EACH ROW EXECUTE FUNCTION synq_execution_no_delete();
    DROP TRIGGER IF EXISTS synq_gateway_burn_intents_keep ON synq_gateway_burn_intents;
    CREATE TRIGGER synq_gateway_burn_intents_keep BEFORE DELETE ON synq_gateway_burn_intents
      FOR EACH ROW EXECUTE FUNCTION synq_execution_no_delete();`,
    down: `DROP TABLE IF EXISTS synq_gateway_burn_intents; DROP TABLE IF EXISTS synq_gateway_deposits; DROP TABLE IF EXISTS synq_gateway_accounts;`,
  },
];

export const migrateExecution = (pool: SqlPool, target?: number) =>
  applyMigrations(
    pool,
    'synq_execution_migrations',
    EXECUTION_MIGRATIONS,
    target,
  );

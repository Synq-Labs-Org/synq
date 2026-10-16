export const WORKSPACE_MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE synq_ws_principals (id text PRIMARY KEY, wallet text NOT NULL UNIQUE);
CREATE TABLE synq_ws_challenges (id uuid PRIMARY KEY, data jsonb NOT NULL, expires_at bigint NOT NULL, consumed boolean NOT NULL DEFAULT false);
CREATE TABLE synq_ws_sessions (digest text PRIMARY KEY, principal_id text NOT NULL REFERENCES synq_ws_principals(id), audience text NOT NULL CHECK(audience IN ('web','native')), expires_at bigint NOT NULL);
CREATE TABLE synq_workspaces (id uuid PRIMARY KEY, display_name text NOT NULL, kind text NOT NULL CHECK(kind IN ('PERSONAL','GROUP','BUSINESS')), created_by text NOT NULL REFERENCES synq_ws_principals(id), chain_id int NOT NULL CHECK(chain_id=5042002), status text NOT NULL CHECK(status IN ('FORMING','LAUNCHING','ACTIVE')), vault text UNIQUE, threshold int, CHECK ((status='ACTIVE' AND vault IS NOT NULL AND threshold>0) OR (status<>'ACTIVE' AND vault IS NULL)));
CREATE TABLE synq_ws_members (workspace_id uuid NOT NULL REFERENCES synq_workspaces(id), principal_id text NOT NULL REFERENCES synq_ws_principals(id), wallet text NOT NULL, role text NOT NULL CHECK(role IN ('OWNER','ADMIN','MEMBER','VIEWER')), joined_at bigint NOT NULL, PRIMARY KEY(workspace_id,principal_id), UNIQUE(workspace_id,wallet));
CREATE TABLE synq_ws_membership_log (seq bigserial PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES synq_workspaces(id), principal_id text NOT NULL, action text NOT NULL, role text NOT NULL, actor text NOT NULL, occurred_at bigint NOT NULL);
CREATE FUNCTION synq_ws_no_log_edit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'membership log is append only'; END $$;
CREATE TRIGGER synq_ws_log_immutable BEFORE UPDATE OR DELETE ON synq_ws_membership_log FOR EACH ROW EXECUTE FUNCTION synq_ws_no_log_edit();
CREATE TABLE synq_ws_invites (digest text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES synq_workspaces(id), role text NOT NULL CHECK(role IN ('OWNER','ADMIN','MEMBER','VIEWER')), issued_by text NOT NULL REFERENCES synq_ws_principals(id), expires_at bigint NOT NULL, consumed_by text REFERENCES synq_ws_principals(id));
CREATE TABLE synq_ws_channel_bindings (channel text NOT NULL CHECK(channel IN ('telegram','imessage')), channel_digest text NOT NULL, workspace_id uuid NOT NULL REFERENCES synq_workspaces(id), link_id text NOT NULL UNIQUE, PRIMARY KEY(channel,channel_digest));
CREATE TABLE synq_ws_rate_limits (bucket text PRIMARY KEY, window_id bigint NOT NULL, hits int NOT NULL CHECK(hits>0));
CREATE INDEX synq_ws_members_principal ON synq_ws_members(principal_id);
CREATE INDEX synq_ws_sessions_expiry ON synq_ws_sessions(expires_at);
`,
    down: `DROP TABLE synq_ws_rate_limits, synq_ws_channel_bindings, synq_ws_invites, synq_ws_membership_log, synq_ws_members, synq_workspaces, synq_ws_sessions, synq_ws_challenges, synq_ws_principals; DROP FUNCTION synq_ws_no_log_edit();`,
  },
  {
    version: 2,
    up: `
ALTER TABLE synq_workspaces ADD COLUMN policy text, ADD COLUMN vault_tx_hash text;
CREATE TABLE synq_ws_vault_setups (workspace_id uuid PRIMARY KEY REFERENCES synq_workspaces(id), setup_hash text NOT NULL UNIQUE, data jsonb NOT NULL, state text NOT NULL CHECK(state IN ('AWAITING_SIGNATURES','READY','ACTIVE','REVERTED','NEEDS_REVIEW')), evidence jsonb, created_at bigint NOT NULL);
CREATE TABLE synq_ws_setup_signatures (workspace_id uuid NOT NULL REFERENCES synq_ws_vault_setups(workspace_id), owner text NOT NULL, signature text NOT NULL, PRIMARY KEY(workspace_id,owner));
CREATE TABLE synq_ws_sponsor_days (day bigint PRIMARY KEY, limit_wei numeric(78,0) NOT NULL CHECK(limit_wei>0), used_wei numeric(78,0) NOT NULL CHECK(used_wei>=0 AND used_wei<=limit_wei));
CREATE TABLE synq_ws_sponsor_reservations (workspace_id uuid PRIMARY KEY REFERENCES synq_ws_vault_setups(workspace_id), setup_hash text NOT NULL UNIQUE, day bigint NOT NULL REFERENCES synq_ws_sponsor_days(day), reserved_wei numeric(78,0) NOT NULL CHECK(reserved_wei>0), actual_wei numeric(78,0), tx_hash text UNIQUE, state text NOT NULL CHECK(state IN ('RESERVED','SETTLED')), CHECK(actual_wei IS NULL OR (actual_wei>=0 AND actual_wei<=reserved_wei)));
CREATE FUNCTION synq_ws_setup_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.data<>OLD.data OR NEW.setup_hash<>OLD.setup_hash OR NEW.workspace_id<>OLD.workspace_id THEN RAISE EXCEPTION 'vault setup is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER synq_ws_setup_guard BEFORE UPDATE ON synq_ws_vault_setups FOR EACH ROW EXECUTE FUNCTION synq_ws_setup_immutable();
ALTER TABLE synq_ws_vault_setups ADD COLUMN next_attempt_at bigint NOT NULL DEFAULT 0, ADD COLUMN attempts int NOT NULL DEFAULT 0, ADD COLUMN last_error text;
`,
    down: `DROP TABLE synq_ws_sponsor_reservations, synq_ws_sponsor_days, synq_ws_setup_signatures, synq_ws_vault_setups; DROP FUNCTION synq_ws_setup_immutable(); ALTER TABLE synq_workspaces DROP COLUMN policy, DROP COLUMN vault_tx_hash;`,
  },
  {
    version: 3,
    up: `CREATE TABLE synq_ws_native_handoffs (digest text PRIMARY KEY, principal_id text NOT NULL REFERENCES synq_ws_principals(id), expires_at bigint NOT NULL, used_at bigint);`,
    down: `DROP TABLE synq_ws_native_handoffs;`,
  },
  {
    version: 4,
    up: `ALTER TABLE synq_ws_channel_bindings ADD COLUMN destination jsonb NOT NULL, ADD COLUMN identity_link_id text NOT NULL;`,
    down: `ALTER TABLE synq_ws_channel_bindings DROP COLUMN destination, DROP COLUMN identity_link_id;`,
  },
] as const;

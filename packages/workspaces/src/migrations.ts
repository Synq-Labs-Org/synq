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
] as const;

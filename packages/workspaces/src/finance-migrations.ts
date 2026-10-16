export const FINANCE_MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE synq_ws_finance_revision(workspace_id uuid PRIMARY KEY REFERENCES synq_workspaces(id),revision int NOT NULL CHECK(revision>0));
CREATE TABLE synq_ws_finance_changes(hash text PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES synq_workspaces(id),data jsonb NOT NULL,signatures jsonb NOT NULL,state text NOT NULL CHECK(state IN ('PENDING','APPLIED')));
CREATE TABLE synq_ws_vendors(workspace_id uuid NOT NULL REFERENCES synq_workspaces(id),id uuid NOT NULL,name text NOT NULL,address text NOT NULL,verified_at bigint NOT NULL,eligible_at bigint NOT NULL,change_hash text NOT NULL REFERENCES synq_ws_finance_changes(hash),PRIMARY KEY(workspace_id,id));
CREATE TABLE synq_ws_vendor_history(seq bigserial PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES synq_workspaces(id),vendor_id uuid NOT NULL,address text NOT NULL,change_hash text NOT NULL REFERENCES synq_ws_finance_changes(hash),verified_at bigint NOT NULL,eligible_at bigint NOT NULL);
CREATE TRIGGER synq_ws_vendor_history_immutable BEFORE UPDATE OR DELETE ON synq_ws_vendor_history FOR EACH ROW EXECUTE FUNCTION synq_ws_no_log_edit();
CREATE TABLE synq_ws_budgets(workspace_id uuid PRIMARY KEY REFERENCES synq_workspaces(id),data jsonb NOT NULL,change_hash text NOT NULL REFERENCES synq_ws_finance_changes(hash));
CREATE FUNCTION synq_ws_finance_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.data<>OLD.data OR NEW.hash<>OLD.hash OR NEW.workspace_id<>OLD.workspace_id OR OLD.state='APPLIED' THEN RAISE EXCEPTION 'finance change is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER synq_ws_finance_change_immutable BEFORE UPDATE ON synq_ws_finance_changes FOR EACH ROW EXECUTE FUNCTION synq_ws_finance_change_guard();
`,
    down: `DROP TABLE synq_ws_budgets,synq_ws_vendor_history,synq_ws_vendors,synq_ws_finance_changes,synq_ws_finance_revision; DROP FUNCTION synq_ws_finance_change_guard();`,
  },
  {
    version: 2,
    up: `CREATE TABLE synq_ws_payouts(id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES synq_workspaces(id),idempotency_key uuid NOT NULL,obligation text NOT NULL,data jsonb NOT NULL,signatures jsonb NOT NULL DEFAULT '{}',mandate_signature text,state text NOT NULL CHECK(state IN ('REVIEW','READY','HOLD','SIGNED','PAID','FAILED','NEEDS_REVIEW','CANCELLED')),reason text,created_at bigint NOT NULL,executed_at bigint,next_attempt_at bigint NOT NULL DEFAULT 0,attempts int NOT NULL DEFAULT 0,tx_hash text,UNIQUE(workspace_id,idempotency_key));
CREATE UNIQUE INDEX synq_ws_payout_obligation ON synq_ws_payouts(workspace_id,obligation) WHERE state<>'CANCELLED';
CREATE FUNCTION synq_ws_payout_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.data<>OLD.data OR NEW.obligation<>OLD.obligation OR NEW.idempotency_key<>OLD.idempotency_key THEN RAISE EXCEPTION 'payout terms are immutable'; END IF; IF OLD.state IN ('PAID','FAILED','NEEDS_REVIEW','CANCELLED') AND NEW.state<>OLD.state THEN RAISE EXCEPTION 'payout outcome is terminal'; END IF; RETURN NEW; END $$;
CREATE TRIGGER synq_ws_payout_immutable BEFORE UPDATE ON synq_ws_payouts FOR EACH ROW EXECUTE FUNCTION synq_ws_payout_guard();`,
    down: `DROP TABLE synq_ws_payouts; DROP FUNCTION synq_ws_payout_guard();`,
  },
  {
    version: 3,
    up: `CREATE TABLE synq_ws_safe_actions(id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES synq_workspaces(id),data jsonb NOT NULL,signatures jsonb NOT NULL DEFAULT '{}',state text NOT NULL CHECK(state IN ('REVIEW','READY','CONFIRMED','FAILED','NEEDS_REVIEW')),evidence jsonb,next_attempt_at bigint NOT NULL DEFAULT 0,last_error text);
CREATE UNIQUE INDEX synq_ws_action_unique ON synq_ws_safe_actions(workspace_id,(data->>'kind'),(data->>'vendorChangeHash'),(data->>'nonce'),(data->>'expiresAt'));
CREATE FUNCTION synq_ws_action_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id<>OLD.id OR NEW.workspace_id<>OLD.workspace_id OR NEW.data<>OLD.data OR (OLD.state<>'REVIEW' AND NEW.signatures<>OLD.signatures) THEN RAISE EXCEPTION 'action terms are immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER synq_ws_action_immutable BEFORE UPDATE ON synq_ws_safe_actions FOR EACH ROW EXECUTE FUNCTION synq_ws_action_guard();`,
    down: `DROP TABLE synq_ws_safe_actions; DROP FUNCTION synq_ws_action_guard();`,
  },
] as const;

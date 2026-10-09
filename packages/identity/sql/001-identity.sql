CREATE TABLE IF NOT EXISTS identity_principal (
  principal_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('MERA_HUMAN', 'PRIVY_DELEGATE', 'DYNAMIC_OPERATOR', 'LOCAL_FIXTURE')),
  signer text NOT NULL CHECK (signer ~ '^0x[0-9a-f]{40}$'),
  rp_id text,
  credential_id text,
  credential_json jsonb,
  provider_ref jsonb,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  enrolled_at bigint NOT NULL,
  last_recovered_at bigint,
  CONSTRAINT identity_principal_signer_key UNIQUE (signer),
  CONSTRAINT identity_principal_mera_binding CHECK (
    (kind = 'MERA_HUMAN') = (rp_id IS NOT NULL AND credential_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS identity_principal_credential_key
  ON identity_principal (rp_id, credential_id) WHERE credential_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS identity_challenge (
  challenge_id text PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('ENROLL', 'RECOVER', 'JOIN')),
  challenge_json jsonb NOT NULL,
  expires_at bigint NOT NULL,
  consumed_at bigint
);

CREATE TABLE IF NOT EXISTS identity_group (
  group_id text PRIMARY KEY,
  chain_id integer NOT NULL,
  account text NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),
  owners text[] NOT NULL,
  threshold integer NOT NULL CHECK (threshold > 0 AND threshold <= cardinality(owners)),
  membership_epoch bigint NOT NULL DEFAULT 0 CHECK (membership_epoch >= 0),
  created_at bigint NOT NULL,
  CONSTRAINT identity_group_account_key UNIQUE (chain_id, account)
);

CREATE TABLE IF NOT EXISTS identity_membership (
  id bigserial PRIMARY KEY,
  group_id text NOT NULL REFERENCES identity_group (group_id),
  member_id text NOT NULL,
  principal_id text NOT NULL REFERENCES identity_principal (principal_id),
  principal_kind text NOT NULL,
  role text NOT NULL CHECK (role IN ('APPROVER', 'OPERATOR')),
  signer text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  joined_epoch bigint NOT NULL,
  joined_at bigint NOT NULL,
  revoked_at bigint,
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL)),
  CHECK (role = 'OPERATOR' OR principal_kind IN ('MERA_HUMAN', 'LOCAL_FIXTURE')),
  CHECK (role = 'APPROVER' OR principal_kind = 'DYNAMIC_OPERATOR')
);
CREATE UNIQUE INDEX IF NOT EXISTS identity_membership_active_member
  ON identity_membership (group_id, member_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS identity_membership_active_principal
  ON identity_membership (group_id, principal_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS identity_membership_active_signer
  ON identity_membership (group_id, signer) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS identity_grant_draft (
  draft_digest text PRIMARY KEY,
  intent_hash text NOT NULL,
  group_id text NOT NULL REFERENCES identity_group (group_id),
  draft_json jsonb NOT NULL,
  asset_json jsonb NOT NULL,
  created_at bigint NOT NULL,
  CONSTRAINT identity_grant_draft_intent_key UNIQUE (intent_hash)
);

CREATE TABLE IF NOT EXISTS identity_grant_challenge (
  challenge_id text PRIMARY KEY,
  draft_digest text NOT NULL REFERENCES identity_grant_draft (draft_digest),
  challenge_json jsonb NOT NULL,
  expires_at bigint NOT NULL,
  consumed_at bigint
);

CREATE TABLE IF NOT EXISTS identity_verified_approval (
  approval_id text PRIMARY KEY,
  challenge_id text NOT NULL REFERENCES identity_grant_challenge (challenge_id),
  draft_digest text NOT NULL REFERENCES identity_grant_draft (draft_digest),
  member_id text NOT NULL,
  signer text NOT NULL,
  membership_epoch bigint NOT NULL,
  approval_json jsonb NOT NULL,
  verified_at bigint NOT NULL,
  CONSTRAINT identity_approval_challenge_key UNIQUE (challenge_id),
  CONSTRAINT identity_approval_member_key UNIQUE (draft_digest, membership_epoch, member_id),
  CONSTRAINT identity_approval_signer_key UNIQUE (draft_digest, membership_epoch, signer)
);

CREATE TABLE IF NOT EXISTS identity_idempotency (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING', 'DONE')),
  status_code integer,
  response_json jsonb,
  created_at bigint NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE IF NOT EXISTS identity_delegation_policy (
  policy_id text PRIMARY KEY,
  group_id text NOT NULL REFERENCES identity_group (group_id),
  delegate_principal_id text NOT NULL REFERENCES identity_principal (principal_id),
  policy_json jsonb NOT NULL,
  revoked_at bigint
);

CREATE TABLE IF NOT EXISTS identity_delegation_usage (
  usage_id text PRIMARY KEY,
  policy_id text NOT NULL REFERENCES identity_delegation_policy (policy_id),
  amount numeric(78, 0) NOT NULL CHECK (amount > 0),
  at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS identity_delegation_usage_policy
  ON identity_delegation_usage (policy_id, at);

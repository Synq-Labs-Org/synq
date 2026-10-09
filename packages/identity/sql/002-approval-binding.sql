ALTER TABLE identity_group
  ADD COLUMN IF NOT EXISTS executors text[] NOT NULL DEFAULT '{}';

ALTER TABLE identity_grant_draft
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'PENDING';
ALTER TABLE identity_grant_draft
  ADD CONSTRAINT identity_grant_draft_status_check CHECK (status IN ('PENDING', 'INVALIDATED'));
ALTER TABLE identity_grant_draft DROP CONSTRAINT IF EXISTS identity_grant_draft_intent_key;
CREATE UNIQUE INDEX identity_grant_draft_pending_intent
  ON identity_grant_draft (intent_hash) WHERE status = 'PENDING';

ALTER TABLE identity_verified_approval
  ADD COLUMN IF NOT EXISTS attestation_signature text;
ALTER TABLE identity_verified_approval DROP CONSTRAINT IF EXISTS identity_approval_member_key;
ALTER TABLE identity_verified_approval DROP CONSTRAINT IF EXISTS identity_approval_signer_key;
ALTER TABLE identity_verified_approval
  ADD CONSTRAINT identity_approval_member_key UNIQUE (draft_digest, member_id);
ALTER TABLE identity_verified_approval
  ADD CONSTRAINT identity_approval_signer_key UNIQUE (draft_digest, signer);

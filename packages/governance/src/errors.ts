export type GovernanceErrorCode =
  | 'BAD_POLICY'
  | 'BAD_SNAPSHOT'
  | 'BAD_SIGNATURE'
  | 'NOT_ELIGIBLE'
  | 'DUPLICATE_VOTE'
  | 'BALLOT_NOT_OPEN'
  | 'BALLOT_MISMATCH'
  | 'RESNAPSHOT_REQUIRED'
  | 'DELEGATION_INVALID'
  | 'DELEGATION_CYCLE'
  | 'DELEGATION_REVOKED'
  | 'DELEGATION_EXPIRED'
  | 'NOT_DELEGATED'
  | 'BAD_COUNCIL'
  | 'TERM_INACTIVE'
  | 'ACTION_MISMATCH'
  | 'QUORUM_NOT_MET'
  | 'CHALLENGE_WINDOW_OPEN'
  | 'CHALLENGE_WINDOW_CLOSED'
  | 'CHALLENGED'
  | 'NOT_A_CHALLENGER'
  | 'BAD_TERMS'
  | 'BAD_ASSENT';

export class GovernanceError extends Error {
  constructor(
    readonly code: GovernanceErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'GovernanceError';
  }
}

export const fail = (code: GovernanceErrorCode, message?: string): never => {
  throw new GovernanceError(code, message);
};

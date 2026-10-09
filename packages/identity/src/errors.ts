export type IdentityErrorCode =
  | 'INVALID_INPUT'
  | 'CHALLENGE_NOT_FOUND'
  | 'CHALLENGE_CONSUMED'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_MISMATCH'
  | 'SIGNATURE_MISMATCH'
  | 'PRINCIPAL_EXISTS'
  | 'PRINCIPAL_NOT_FOUND'
  | 'PRINCIPAL_KIND_FORBIDDEN'
  | 'PRINCIPAL_NOT_ELIGIBLE'
  | 'ORIGIN_MISMATCH'
  | 'GROUP_EXISTS'
  | 'GROUP_NOT_FOUND'
  | 'NOT_SAFE_OWNER'
  | 'OPERATOR_IS_OWNER'
  | 'DUPLICATE_MEMBERSHIP'
  | 'MEMBERSHIP_NOT_FOUND'
  | 'MEMBERSHIP_CHANGED'
  | 'DRAFT_EXISTS'
  | 'MANDATE_NOT_FOUND'
  | 'READ_MODEL_UNAVAILABLE'
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_INVALID'
  | 'DRAFT_INVALIDATED'
  | 'RATE_LIMITED'
  | 'INTENT_REJECTED'
  | 'KERNEL_UNAVAILABLE'
  | 'ALREADY_APPROVED'
  | 'DELEGATION_DENIED'
  | 'PROVIDER_BLOCKED'
  | 'PROVIDER_ERROR'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNAUTHORIZED';

const SAFE_MESSAGES: Record<IdentityErrorCode, string> = {
  INVALID_INPUT: 'Request is invalid',
  CHALLENGE_NOT_FOUND: 'Challenge not found',
  CHALLENGE_CONSUMED: 'Challenge already used',
  CHALLENGE_EXPIRED: 'Challenge expired',
  CHALLENGE_MISMATCH: 'Challenge does not match this request',
  SIGNATURE_MISMATCH: 'Signature does not match the expected signer',
  PRINCIPAL_EXISTS: 'Principal or signer already enrolled',
  PRINCIPAL_NOT_FOUND: 'Principal not found',
  PRINCIPAL_KIND_FORBIDDEN: 'Principal kind not allowed in this profile',
  PRINCIPAL_NOT_ELIGIBLE: 'Principal is not eligible for this action',
  ORIGIN_MISMATCH: 'Relying party or origin mismatch',
  GROUP_EXISTS: 'Group already bound',
  GROUP_NOT_FOUND: 'Group not found',
  NOT_SAFE_OWNER: 'Signer is not an owner of the group account',
  OPERATOR_IS_OWNER: 'Operator signer must not be an account owner',
  DUPLICATE_MEMBERSHIP: 'Membership already exists',
  MEMBERSHIP_NOT_FOUND: 'Active membership not found',
  MEMBERSHIP_CHANGED: 'Membership changed since the challenge was issued',
  DRAFT_EXISTS: 'Grant draft already registered',
  MANDATE_NOT_FOUND: 'Mandate not found',
  READ_MODEL_UNAVAILABLE: 'Read model unavailable',
  DRAFT_NOT_FOUND: 'Grant draft not found',
  DRAFT_INVALID: 'Grant draft is inconsistent',
  DRAFT_INVALIDATED:
    'Grant draft was invalidated by a membership change; a new draft is required',
  RATE_LIMITED: 'Too many requests',
  INTENT_REJECTED: 'Intent rejected by the Kernel',
  KERNEL_UNAVAILABLE: 'Kernel authorization is not configured for this API',
  ALREADY_APPROVED: 'Member already approved this draft',
  DELEGATION_DENIED: 'Delegation policy denies this action',
  PROVIDER_BLOCKED: 'Provider credentials are not configured',
  PROVIDER_ERROR: 'Provider request failed',
  IDEMPOTENCY_CONFLICT: 'Idempotency key reused with a different request',
  UNAUTHORIZED: 'Not authorized',
};

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly detail: string | undefined;
  constructor(code: IdentityErrorCode, detail?: string) {
    super(SAFE_MESSAGES[code]);
    this.name = 'IdentityError';
    this.code = code;
    this.detail = detail;
  }
}
export const isIdentityError = (error: unknown): error is IdentityError =>
  error instanceof IdentityError;

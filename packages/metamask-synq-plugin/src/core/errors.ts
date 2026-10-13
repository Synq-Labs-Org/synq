export const SYNQ_ERROR_CODES = [
  'WRONG_CHAIN',
  'WRONG_SAFE',
  'INVALID_TOKEN',
  'OVER_CAP',
  'INVALID_AMOUNT',
  'MANDATE_MISMATCH',
  'DUPLICATE_CONTRIBUTION',
  'INTENT_EXPIRED',
  'INTENT_MISMATCH',
  'WRONG_SPENDER',
  'MEMBERSHIP_REVOKED',
  'NOT_A_MEMBER',
  'CAPABILITY_DENIED',
  'INSUFFICIENT_BALANCE',
  'SUBMISSION_FAILED',
  'RECEIPT_MISMATCH',
  'SYNQ_API_ERROR',
  'SYNQ_API_UNAUTHORIZED',
  'SESSION_REQUIRED',
  'CONFIG_INVALID',
  'INVALID_INPUT',
] as const;
export type SynqErrorCode = (typeof SYNQ_ERROR_CODES)[number];

const HINTS: Record<SynqErrorCode, string> = {
  WRONG_CHAIN: 'Synq contributions run only on Monad testnet (eip155:10143).',
  WRONG_SAFE:
    'The destination must be the Safe registered for this group in MandateRegistry.',
  INVALID_TOKEN: 'Only the registry-verified testnet AUSD token is accepted.',
  OVER_CAP: 'Lower the amount to the plugin or mandate contribution cap.',
  INVALID_AMOUNT: 'Pass a positive decimal AUSD amount, e.g. 1.5.',
  MANDATE_MISMATCH:
    'The mandate must be active, unexpired and denominated in AUSD for this Safe.',
  DUPLICATE_CONTRIBUTION:
    'This contribution was already submitted; use `mm synq receipts` or pass a new --request-id.',
  INTENT_EXPIRED: 'Re-run the command to obtain a fresh funding quote.',
  INTENT_MISMATCH:
    'The Synq funding quote does not match the requested contribution.',
  WRONG_SPENDER:
    'Select the Agent Wallet account that is an active member of the group.',
  MEMBERSHIP_REVOKED: 'A group approver must re-admit this member first.',
  NOT_A_MEMBER:
    'Join the group with this wallet as signer before contributing.',
  CAPABILITY_DENIED:
    'Read-only Synq commands never submit; use `mm synq contribute`.',
  INSUFFICIENT_BALANCE: 'Fund the Agent Wallet with testnet AUSD first.',
  SUBMISSION_FAILED:
    'Agent Wallet policy or the network rejected the transaction; nothing was credited.',
  RECEIPT_MISMATCH:
    'The mined transaction does not carry the expected AUSD transfer.',
  SYNQ_API_ERROR: 'Check SYNQ_API_URL and that the Synq API is running.',
  SYNQ_API_UNAUTHORIZED:
    'Your member session expired or was refused; run `mm synq login <group>`.',
  SESSION_REQUIRED:
    'Run `mm synq login <group>` to sign in as your member wallet.',
  CONFIG_INVALID: 'Check the SYNQ_* environment variables.',
  INVALID_INPUT: 'Check the command flags with --help.',
};

export class SynqPluginError extends Error {
  readonly hint: string;
  constructor(
    readonly code: SynqErrorCode,
    message: string,
    hint?: string,
  ) {
    super(message);
    this.name = 'SynqPluginError';
    this.hint = hint ?? HINTS[code];
  }
}

export function fail(
  code: SynqErrorCode,
  message: string,
  hint?: string,
): never {
  throw new SynqPluginError(code, message, hint);
}

/** The Synq failure behind an error, including one wrapped by a viem transport. */
export function synqError(error: unknown): SynqPluginError | null {
  for (let e = error, depth = 0; e && depth < 8; depth++) {
    if (e instanceof SynqPluginError) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

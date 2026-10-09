import { safeParse, type z } from 'zod';

export type SynqErrorCode =
  | 'VALIDATION_FAILED'
  | 'INVALID_DECIMAL'
  | 'INVALID_DECIMALS'
  | 'DECIMAL_PRECISION'
  | 'AMOUNT_OVERFLOW'
  | 'INVALID_TRANSITION'
  | 'CAPABILITY_ESCALATION'
  | 'DUPLICATE_ID'
  | 'PLUGIN_CONFLICT'
  | 'PLUGIN_MUTATOR_INCOMPLETE'
  | 'PLUGIN_UNAVAILABLE'
  | 'PLUGIN_UNHEALTHY'
  | 'NETWORK_DISABLED'
  | 'ASSET_REGISTRY_MISMATCH'
  | 'ASSET_ROLE_UNCONFIGURED'
  | 'REGISTRY_INVALID'
  | 'PLUGIN_READ_ONLY_MUTATOR'
  | 'INVALID_GRANT_ID'
  | 'INVALID_NEW_SUBMISSION'
  | 'UNKNOWN_EXECUTION'
  | 'INVALID_EXECUTION_TRANSITION'
  | 'EXECUTION_LOCK_OWNER_UNKNOWN'
  | 'EXECUTION_ALREADY_RUNNING'
  | 'GRANT_REPREPARATION_FORBIDDEN'
  | 'RPC_TRANSACTION_HASH_MISMATCH'
  | 'JOURNAL_HISTORY_MISMATCH'
  | 'INVALID_CONFIRMATION_DEPTH'
  | 'CONFIRMATION_DEPTH_REQUIRES_HEAD'
  | 'MAINNET_DISABLED'
  | 'PREPARED_CALL_MISMATCH'
  | 'SIMULATION_SCOPE';

const publicMessages: Record<SynqErrorCode, string> = {
  VALIDATION_FAILED: 'Input failed schema validation.',
  INVALID_DECIMAL: 'Amount is not a valid decimal string.',
  INVALID_DECIMALS: 'Token decimals are out of range.',
  DECIMAL_PRECISION: 'Amount has more precision than the token supports.',
  AMOUNT_OVERFLOW: 'Amount exceeds uint256.',
  INVALID_TRANSITION: 'State transition is not permitted.',
  CAPABILITY_ESCALATION: 'Requested capabilities exceed the delegator.',
  DUPLICATE_ID: 'Identifier already exists.',
  PLUGIN_CONFLICT: 'A plugin with this id is already registered.',
  PLUGIN_MUTATOR_INCOMPLETE:
    'Financial plugins must implement prepare, simulate, execute and reconcile.',
  PLUGIN_UNAVAILABLE: 'Plugin is not available for this network.',
  PLUGIN_UNHEALTHY: 'Plugin health check is failing or stale.',
  NETWORK_DISABLED: 'Network profile is disabled.',
  ASSET_REGISTRY_MISMATCH: 'Asset does not match the official registry.',
  ASSET_ROLE_UNCONFIGURED: 'Asset role is not configured for this profile.',
  REGISTRY_INVALID: 'Registry configuration is invalid.',
  PLUGIN_READ_ONLY_MUTATOR:
    'Read-only plugins must not expose mutation entry points.',
  INVALID_GRANT_ID: 'Grant identifier is malformed.',
  INVALID_NEW_SUBMISSION: 'Only an unsubmitted signed transaction can start.',
  UNKNOWN_EXECUTION: 'No execution is journaled for this grant.',
  INVALID_EXECUTION_TRANSITION:
    'Transaction state change is not permitted by the lifecycle.',
  EXECUTION_LOCK_OWNER_UNKNOWN: 'Execution lock owner cannot be determined.',
  EXECUTION_ALREADY_RUNNING: 'Another worker holds this grant.',
  GRANT_REPREPARATION_FORBIDDEN:
    'A grant cannot be re-prepared with a different transaction.',
  RPC_TRANSACTION_HASH_MISMATCH: 'RPC returned an unexpected transaction hash.',
  JOURNAL_HISTORY_MISMATCH: 'Journal state disagrees with its history.',
  INVALID_CONFIRMATION_DEPTH: 'Confirmation depth must be a positive integer.',
  CONFIRMATION_DEPTH_REQUIRES_HEAD:
    'Confirmation depth above one needs a chain head source.',
  MAINNET_DISABLED: 'Mainnet execution is disabled.',
  PREPARED_CALL_MISMATCH: 'Prepared call does not match the grant.',
  SIMULATION_SCOPE: 'Simulation request is outside the plugin scope.',
};

export class SynqError extends Error {
  readonly publicMessage: string;
  constructor(
    readonly code: SynqErrorCode,
    readonly detail?: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${publicMessages[code]}`, options);
    this.name = new.target.name;
    this.publicMessage = publicMessages[code];
  }
  toJSON(): { code: SynqErrorCode; message: string } {
    return { code: this.code, message: this.publicMessage };
  }
}
export class ValidationError extends SynqError {
  constructor(
    readonly issues: readonly { path: string; message: string }[],
    options?: { cause?: unknown },
  ) {
    super(
      'VALIDATION_FAILED',
      issues.map((i) => `${i.path}: ${i.message}`).join('; '),
      options,
    );
  }
}
export class MoneyError extends SynqError {}
export class TransitionError extends SynqError {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
  ) {
    super('INVALID_TRANSITION', `${machine}:${from}->${to}`);
  }
}
export class CapabilityError extends SynqError {}
export class DuplicateIdError extends SynqError {
  constructor() {
    super('DUPLICATE_ID');
  }
}
export class PluginError extends SynqError {}
export class ExecutionError extends SynqError {}
export class RegistryError extends SynqError {}

export function parseOrThrow<S extends z.core.$ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  const result = safeParse(schema, value);
  if (result.success) return result.data;
  throw new ValidationError(
    result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '(root)',
      message: issue.message,
    })),
    { cause: result.error },
  );
}

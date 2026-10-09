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
  | 'REGISTRY_INVALID';

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

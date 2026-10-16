import type { Address } from 'viem';
import type { RiskFlag } from './rules.js';

/**
 * Counterparty (sanctions / wallet) screening port.
 *
 * A screening provider answers CLEAR or HIT for one address on one chain. If
 * the provider is not configured, unreachable, unhealthy or answers anything
 * malformed, the verdict is UNAVAILABLE, and UNAVAILABLE is never a pass: it
 * becomes a disclosed flag, and a HARD one for high-value payouts or for a
 * counterparty that has no verified payout history (fail closed).
 */
export type ScreeningVerdict = 'CLEAR' | 'HIT' | 'UNAVAILABLE';

export type ScreeningResult = Readonly<{
  providerId: string;
  address: Address;
  chainId: number;
  verdict: ScreeningVerdict;
  /** Provider reference for a real answer; null when UNAVAILABLE. */
  reference: string | null;
  reason: string;
  screenedAt: number;
}>;

export type ScreeningStatus = Readonly<{
  providerId: string;
  status: 'AVAILABLE' | 'UNAVAILABLE';
  /** Names only, never values. */
  missingCredentials: readonly string[];
  reason: string;
}>;

export interface WalletScreeningPort {
  readonly providerId: string;
  status(): ScreeningStatus;
  screen(input: {
    address: Address;
    chainId: number;
    now: number;
  }): Promise<ScreeningResult>;
}

/** Credential names a real screening provider would need (presence only). */
export const SCREENING_CREDENTIALS = ['SYNQ_SCREENING_API_KEY'] as const;

/**
 * The port when no screening provider is entitled: every call answers
 * UNAVAILABLE. This is the honest state of the Arc testnet build.
 */
export function unavailableScreening(
  reason = 'no wallet-screening provider is configured (credentials missing)',
  providerId = 'WALLET_SCREENING',
): WalletScreeningPort {
  return {
    providerId,
    status: () => ({
      providerId,
      status: 'UNAVAILABLE',
      missingCredentials: [...SCREENING_CREDENTIALS],
      reason,
    }),
    async screen({ address, chainId, now }) {
      return {
        providerId,
        address,
        chainId,
        verdict: 'UNAVAILABLE',
        reference: null,
        reason,
        screenedAt: now,
      };
    },
  };
}

/**
 * Wraps a provider call: a throw, timeout or answer for another address is
 * UNAVAILABLE, never CLEAR.
 */
export async function screenSafely(
  port: WalletScreeningPort,
  input: { address: Address; chainId: number; now: number },
  timeoutMs = 5_000,
): Promise<ScreeningResult> {
  const unavailable = (reason: string): ScreeningResult => ({
    providerId: port.providerId,
    address: input.address,
    chainId: input.chainId,
    verdict: 'UNAVAILABLE',
    reference: null,
    reason: reason.slice(0, 200),
    screenedAt: input.now,
  });
  if (port.status().status !== 'AVAILABLE')
    return unavailable(port.status().reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await Promise.race([
      port.screen(input),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('screening timed out')),
          timeoutMs,
        );
      }),
    ]);
    if (
      r.address.toLowerCase() !== input.address.toLowerCase() ||
      r.chainId !== input.chainId ||
      (r.verdict !== 'CLEAR' && r.verdict !== 'HIT') ||
      !r.reference
    )
      return unavailable(
        `provider answer is not a definite verdict for ${input.address}`,
      );
    return r;
  } catch (error) {
    return unavailable(
      `screening failed: ${error instanceof Error ? error.message : 'error'}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deterministic flags from a screening result. `highValueAt` mirrors the
 * Kernel's `riskRequiredAbove`; an unverified counterparty is always treated
 * as high risk.
 */
export function screeningFlags(input: {
  result: ScreeningResult;
  amount: bigint;
  highValueAt: bigint;
  counterpartyVerified: boolean;
}): { flags: RiskFlag[]; available: boolean } {
  const r = input.result;
  if (r.verdict === 'HIT')
    return {
      available: true,
      flags: [
        {
          code: 'SCREENING_HIT',
          severity: 'HARD',
          detail: `${r.providerId} reported ${r.address} (${r.reference})`,
        },
      ],
    };
  if (r.verdict === 'CLEAR') return { available: true, flags: [] };
  const hard = input.amount >= input.highValueAt || !input.counterpartyVerified;
  return {
    available: false,
    flags: [
      {
        code: 'SCREENING_UNAVAILABLE',
        severity: hard ? 'HARD' : 'SOFT',
        detail: `${r.providerId} could not screen ${r.address}: ${r.reason}. Not a pass${hard ? '; high-value or unverified payouts fail closed' : '; disclosed for owner review'}.`,
      },
    ],
  };
}

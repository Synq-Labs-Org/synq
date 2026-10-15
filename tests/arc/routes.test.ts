import { describe, expect, it } from 'vitest';
import {
  RouteError,
  planArcPayment,
  revalidateAtCommit,
  type RouteEvidence,
  type RouteOption,
} from '@synq/settlement/arc';

const NOW = 1_800_000_000;
const quote = (fee: bigint, ttl = 60) => ({
  fee,
  quotedAt: NOW,
  expiresAt: NOW + ttl,
  source: 'test',
});
// Fees observed on testnet: CCTP Fast 1 bps; Gateway direct mint from an Ethereum source about 1 USDC.
const base: RouteEvidence = {
  receiverChain: 'arc-testnet',
  recipientAmount: 1_000_000n,
  signerKind: 'EOA',
  walletFree: { 'arc-testnet': 0n, 'eth-sepolia': 5_000_000n },
  gatewayAvailable: { 'eth-sepolia': 30_000_000n },
  arcGasReserve: 10_000n,
  sourceGasOk: { 'eth-sepolia': true },
  cctpQuotes: { 'eth-sepolia': quote(100n) },
  gatewayQuotes: { 'eth-sepolia': quote(1_000_100n) },
  health: {},
  now: NOW,
};
const ev = (over: Partial<RouteEvidence>): RouteEvidence => ({
  ...base,
  ...over,
});
const chosen = (e: RouteEvidence, p?: Parameters<typeof planArcPayment>[1]) =>
  planArcPayment(e, p).chosen as RouteOption;

describe('Arc settlement route ladder', () => {
  it('pays directly on Arc when Arc USDC covers amount plus gas, at zero route fee', () => {
    const c = chosen(
      ev({
        walletFree: { 'arc-testnet': 2_000_000n, 'eth-sepolia': 5_000_000n },
      }),
    );
    expect([c.route, c.fee, c.gross]).toEqual([
      'ARC_USDC_DIRECT',
      0n,
      1_000_000n,
    ]);
  });

  it('keeps the Arc gas reserve: exactly the amount with no gas is not enough', () => {
    const p = planArcPayment(
      ev({
        walletFree: { 'arc-testnet': 1_000_000n, 'eth-sepolia': 5_000_000n },
      }),
    );
    expect((p.chosen as RouteOption).route).toBe('CCTP_V2_TRANSFER');
    expect(
      p.rejected.find((r) => r.route === 'ARC_USDC_DIRECT')!.reasons[0],
    ).toMatch(/INSUFFICIENT_ARC_USDC/);
  });

  it('picks CCTP over a Gateway whose fee breaks the bps policy', () => {
    const p = planArcPayment(base);
    const c = p.chosen as RouteOption;
    expect([c.route, c.sourceChain, c.fee, c.gross]).toEqual([
      'CCTP_V2_TRANSFER',
      'eth-sepolia',
      100n,
      1_000_100n,
    ]);
    const gw = p.rejected.find(
      (r) => r.route === 'GATEWAY_SPEND' && r.sourceChain === 'eth-sepolia',
    )!;
    expect(gw.reasons.some((x) => x.startsWith('FEE_ABOVE_BPS'))).toBe(true);
  });

  it('uses Gateway when CCTP is down and policy allows its fee', () => {
    const c = chosen(ev({ health: { CCTP_V2_TRANSFER: 'DOWN' } }), {
      allowed: ['ARC_USDC_DIRECT', 'CCTP_V2_TRANSFER', 'GATEWAY_SPEND'],
      maxFeeBps: 20_000,
      maxFee: 2_000_000n,
    });
    expect([c.route, c.fee]).toEqual(['GATEWAY_SPEND', 1_000_100n]);
  });

  it('never counts a pending Gateway deposit as spendable', () => {
    const p = planArcPayment(
      ev({ gatewayAvailable: {}, health: { CCTP_V2_TRANSFER: 'DOWN' } }),
      {
        allowed: ['GATEWAY_SPEND'],
        maxFeeBps: 20_000,
        maxFee: 2_000_000n,
      },
    );
    expect(p.chosen.route).toBe('HUMAN_HANDOFF');
    expect(
      p.rejected.find((r) => r.route === 'GATEWAY_SPEND')!.reasons.join(),
    ).toMatch(/INSUFFICIENT_GATEWAY_AVAILABLE 0/);
  });

  it('rejects cross-chain routes for signers that cannot sign them, and expired or missing quotes', () => {
    const sca = planArcPayment(ev({ signerKind: 'CIRCLE_SCA' }));
    expect(sca.chosen.route).toBe('HUMAN_HANDOFF');
    expect(
      sca.rejected
        .filter((r) => r.route !== 'ARC_USDC_DIRECT')
        .every((r) => r.reasons.some((x) => x.includes('SIGNER_CIRCLE_SCA'))),
    ).toBe(true);
    const stale = planArcPayment(
      ev({ cctpQuotes: { 'eth-sepolia': { ...quote(100n), expiresAt: NOW } } }),
    );
    expect(
      stale.rejected.find(
        (r) =>
          r.route === 'CCTP_V2_TRANSFER' && r.sourceChain === 'eth-sepolia',
      )!.reasons,
    ).toContain(`QUOTE_EXPIRED at ${NOW}`);
    expect(
      planArcPayment(ev({ cctpQuotes: {} })).rejected.find(
        (r) =>
          r.sourceChain === 'eth-sepolia' && r.route === 'CCTP_V2_TRANSFER',
      )!.reasons,
    ).toContain('NO_QUOTE');
  });

  it('answers HUMAN_HANDOFF with every reason when no route is executable, and refuses read-only mainnet', () => {
    const p = planArcPayment(ev({ walletFree: {}, gatewayAvailable: {} }));
    expect(p.chosen.route).toBe('HUMAN_HANDOFF');
    expect((p.chosen as { reasons: readonly string[] }).reasons.length).toBe(
      p.rejected.length,
    );
    expect(planArcPayment(ev({ receiverChain: 'arc-mainnet' })).chosen).toEqual(
      { route: 'HUMAN_HANDOFF', reasons: ['arc-mainnet is read-only'] },
    );
  });

  it('commit barrier: expired quote, raised fee and drained balance all stop signing', () => {
    const approved = chosen(base);
    expect(revalidateAtCommit(approved, ev({ now: NOW + 10 })).route).toBe(
      'CCTP_V2_TRANSFER',
    );
    expect(() => revalidateAtCommit(approved, ev({ now: NOW + 61 }))).toThrow(
      RouteError,
    );
    expect(() =>
      revalidateAtCommit(
        approved,
        ev({ cctpQuotes: { 'eth-sepolia': quote(200n) } }),
      ),
    ).toThrow(/FEE_INCREASED|200 > approved 100/);
    expect(() =>
      revalidateAtCommit(
        approved,
        ev({ walletFree: { 'eth-sepolia': 1_000_000n } }),
      ),
    ).toThrow(/no longer feasible: INSUFFICIENT_SOURCE_USDC/);
    expect(() =>
      revalidateAtCommit(approved, ev({ recipientAmount: 2_000_000n })),
    ).toThrow(/changed since approval/);
  });
});

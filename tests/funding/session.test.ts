import { describe, expect, it } from 'vitest';
import { officialAssets } from '@synq/chain-registry';
import {
  DirectMonadAusdAdapter,
  FundingRequestSchema,
  FundingRouter,
  MemoryFundingSessionStore,
  applyProviderStatus,
  authorizeSession,
  createFundingActivities,
  creditSession,
  markIndexed,
  observeDestination,
  openSession,
  recordSourceSubmission,
  timeoutSession,
  tokenRefOf,
  type DestinationReceipt,
  type FundingSession,
  type NormalizedQuote,
} from '@synq/funding';
import { MAINNET, NOW, SAFE, MEMBER, TESTNET, request } from './helpers.js';

const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
function intentQuote(
  overrides: Partial<NormalizedQuote> = {},
): NormalizedQuote {
  return {
    quoteId: TX(0xabc),
    route: 'AURORA_INTENTS',
    provider: 'NEAR_1CLICK',
    mode: 'MAINNET_READ_ONLY',
    dry: false,
    source: {
      chainId: 8453,
      address: `0x${'83'.repeat(20)}`,
      symbol: 'USDC',
      decimals: 6,
    },
    destination: tokenRefOf(officialAssets.mainnetUSDC),
    recipient: SAFE,
    sourceSender: MEMBER,
    destinationSender: MEMBER,
    amountIn: '5000000',
    amountOut: '4988795',
    minAmountOut: '4963851',
    fees: [],
    quotedAt: NOW,
    expiresAt: NOW + 120,
    timeEstimateSeconds: 37,
    depositAddress: `0x${'de'.repeat(20)}`,
    correlationId: 'corr-1',
    artifactHash: TX(1),
    ...overrides,
  };
}
const receipt = (o: Partial<DestinationReceipt> = {}): DestinationReceipt => ({
  chainId: MAINNET,
  token: officialAssets.mainnetUSDC.address.toLowerCase() as `0x${string}`,
  from: MEMBER,
  to: SAFE,
  amount: '4988795',
  transactionHash: TX(7),
  logIndex: 3,
  blockNumber: 500,
  ...o,
});
const sourceReceipt = (
  q = intentQuote(),
  transactionHash = TX(9),
): DestinationReceipt => ({
  ...receipt(),
  chainId: q.source.chainId,
  token: q.source.address as `0x${string}`,
  from: MEMBER,
  to: q.depositAddress as `0x${string}`,
  amount: q.amountIn,
  transactionHash,
});
const submitted = (q = intentQuote()): FundingSession =>
  recordSourceSubmission(
    authorizeSession(
      openSession({ groupId: 'g', quote: q, now: NOW }),
      NOW + 1,
    ),
    sourceReceipt(q),
    NOW + 2,
  );

describe('Funding state machine (Bible §19)', () => {
  it('AUSD-013 quote expiry: an expired quote cannot be authorized or debited; requote is required', () => {
    const s = openSession({ groupId: 'g', quote: intentQuote(), now: NOW });
    const late = authorizeSession(s, NOW + 121);
    expect(late.state).toBe('EXPIRED');
    expect(() =>
      recordSourceSubmission(late, sourceReceipt(), NOW + 122),
    ).toThrow('INVALID_TRANSITION');
    const authorized = authorizeSession(s, NOW + 10);
    expect(
      recordSourceSubmission(authorized, sourceReceipt(), NOW + 200).state,
    ).toBe('EXPIRED');
    expect(() =>
      openSession({ groupId: 'g', quote: intentQuote(), now: NOW + 500 }),
    ).toThrow('QUOTE_EXPIRED');
  });

  it('runs QUOTED → USER_AUTHORIZED → SOURCE_SUBMITTED → INTENT_PENDING → DESTINATION_RECEIVED → INDEXED → CREDITED', () => {
    let s = submitted();
    expect(s.state).toBe('INTENT_PENDING');
    s = observeDestination(s, receipt(), NOW + 40);
    s = markIndexed(
      s,
      { indexedThroughBlock: 500, eventPresent: true },
      NOW + 41,
    );
    s = creditSession(s, NOW + 42);
    expect(s.history.map((h) => h.to)).toEqual([
      'QUOTED',
      'USER_AUTHORIZED',
      'SOURCE_SUBMITTED',
      'INTENT_PENDING',
      'DESTINATION_RECEIVED',
      'INDEXED',
      'CREDITED',
    ]);
    expect(s.creditedAmount).toBe('4988795');
    expect(creditSession(s, NOW + 50)).toBe(s);
  });

  it('OFT sessions pass through BRIDGE_PENDING; direct sessions go straight to the destination receipt', () => {
    expect(submitted(intentQuote({ route: 'AUSD_OFT' })).state).toBe(
      'BRIDGE_PENDING',
    );
    expect(submitted(intentQuote({ route: 'DIRECT_MONAD_AUSD' })).state).toBe(
      'SOURCE_SUBMITTED',
    );
  });

  it('duplicate settlement callback: repeated provider statuses are no-ops and SUCCESS never credits', () => {
    let s = submitted();
    const update = {
      status: 'SUCCESS' as const,
      updatedAt: '2026-10-10T15:00:00Z',
    };
    s = applyProviderStatus(s, update, NOW + 30);
    const again = applyProviderStatus(s, update, NOW + 31);
    expect(again).toBe(s);
    expect(s.state).toBe('INTENT_PENDING');
    expect(s.creditedAmount).toBeNull();
    expect(() => creditSession(s, NOW + 32)).toThrow('INVALID_TRANSITION');
  });

  it('duplicate destination receipt is idempotent; a second different receipt is a conflict', () => {
    const s = observeDestination(submitted(), receipt(), NOW + 40);
    expect(observeDestination(s, receipt(), NOW + 41)).toBe(s);
    expect(() =>
      observeDestination(s, receipt({ logIndex: 4 }), NOW + 41),
    ).toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('AUSD-014 destination below minimum: credit the actual amount and record the shortfall', () => {
    let s = observeDestination(
      submitted(),
      receipt({ amount: '4900000' }),
      NOW + 40,
    );
    expect(s.shortfall).toBe(String(4963851n - 4900000n));
    s = creditSession(
      markIndexed(
        s,
        { indexedThroughBlock: 501, eventPresent: true },
        NOW + 41,
      ),
      NOW + 42,
    );
    expect(s.creditedAmount).toBe('4900000');
  });

  it('source underpayment from the provider moves to INCOMPLETE_DEPOSIT, never credited', () => {
    const s = applyProviderStatus(
      submitted(),
      { status: 'INCOMPLETE_DEPOSIT', updatedAt: 't1' },
      NOW + 30,
    );
    expect(s.state).toBe('INCOMPLETE_DEPOSIT');
    expect(() => creditSession(s, NOW + 31)).toThrow('INVALID_TRANSITION');
    const refunded = applyProviderStatus(
      s,
      { status: 'REFUNDED', updatedAt: 't2' },
      NOW + 32,
    );
    expect(refunded.state).toBe('REFUNDED');
  });

  it('wrong destination chain, token or recipient is refused', () => {
    const s = submitted();
    for (const bad of [
      receipt({ chainId: TESTNET }),
      receipt({ from: SAFE }),
      receipt({ token: officialAssets.mainnetAUSD.address }),
      receipt({ to: `0x${'99'.repeat(20)}` }),
    ])
      expect(() => observeDestination(s, bad, NOW + 40)).toThrow(
        'DESTINATION_MISMATCH',
      );
  });

  it('indexer delayed: no INDEXED (hence no credit) until the read model passes the receipt block', () => {
    const s = observeDestination(submitted(), receipt(), NOW + 40);
    expect(
      markIndexed(
        s,
        { indexedThroughBlock: 499, eventPresent: false },
        NOW + 41,
      ).state,
    ).toBe('DESTINATION_RECEIVED');
    expect(
      markIndexed(
        s,
        { indexedThroughBlock: 510, eventPresent: false },
        NOW + 41,
      ).state,
    ).toBe('DESTINATION_RECEIVED');
  });

  it('timeout after source submission reconciles instead of re-debiting; a second source tx is a conflict', () => {
    const s = submitted();
    expect(timeoutSession(s, NOW + 999).state).toBe('RECONCILIATION_REQUIRED');
    expect(recordSourceSubmission(s, sourceReceipt(), NOW + 3)).toBe(s);
    expect(() =>
      recordSourceSubmission(s, sourceReceipt(intentQuote(), TX(10)), NOW + 3),
    ).toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('idempotency by deposit address: the same quote returns the same session, another quote conflicts', async () => {
    const store = new MemoryFundingSessionStore();
    const a = await store.open(
      openSession({ groupId: 'g', quote: intentQuote(), now: NOW }),
    );
    const b = await store.open(
      openSession({ groupId: 'g', quote: intentQuote(), now: NOW }),
    );
    expect(b.sessionId).toBe(a.sessionId);
    await expect(
      store.open(
        openSession({
          groupId: 'g',
          quote: intentQuote({ quoteId: TX(0xdef) }),
          now: NOW,
        }),
      ),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('FundingWorkflow activities drive a direct AUSD contribution to CREDITED exactly once', async () => {
    const store = new MemoryFundingSessionStore();
    const req = request({
      destinationChainId: TESTNET,
      sourceToken: tokenRefOf(officialAssets.testnetAUSD),
    });
    const parsed = FundingRequestSchema.parse(req);
    const seen: DestinationReceipt = {
      chainId: TESTNET,
      token: parsed.destination.token.address as `0x${string}`,
      from: MEMBER,
      to: SAFE,
      amount: parsed.source.amount,
      transactionHash: TX(11),
      logIndex: 0,
      blockNumber: 900,
    };
    let indexedThrough = 899;
    const acts = createFundingActivities({
      router: new FundingRouter({ adapters: [new DirectMonadAusdAdapter()] }),
      store,
      destination: { find: async () => seen },
      indexed: {
        indexed: async () => ({
          indexedThroughBlock: indexedThrough,
          eventPresent: indexedThrough >= 900,
        }),
      },
    });
    const plan = await acts.planRoute(req);
    const s0 = await acts.openFromPlan({ groupId: 'g', plan, now: NOW });
    await acts.authorize(s0.sessionId, NOW + 1);
    await acts.recordSource(s0.sessionId, seen, NOW + 2);
    await acts.recordSource(s0.sessionId, seen, NOW + 2);
    await acts.observeDestination(s0.sessionId, NOW + 3);
    expect((await acts.confirmIndexed(s0.sessionId, NOW + 4)).state).toBe(
      'DESTINATION_RECEIVED',
    );
    indexedThrough = 905;
    await acts.confirmIndexed(s0.sessionId, NOW + 5);
    const credited = await acts.credit(s0.sessionId, NOW + 6);
    const again = await acts.credit(s0.sessionId, NOW + 7);
    expect(credited.state).toBe('CREDITED');
    expect(again.history).toEqual(credited.history);
    expect(credited.creditId).toBe(`${TESTNET}:${TX(11)}:0`);
  });
});

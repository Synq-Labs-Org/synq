import { describe, expect, it } from 'vitest';
import { assertExactTransfer, transferCalldata } from '../src/core/chain.js';
import {
  capFromEnv,
  contribute,
  type ContributeInput,
} from '../src/core/contribute.js';
import { SynqPluginError } from '../src/core/errors.js';
import type { Deps } from '../src/core/group.js';
import { MemoryJournal } from '../src/core/journal.js';
import { NETWORK } from '../src/core/network.js';
import { FakeSynqApi } from './fake-api.js';
import { makeDeps } from './deps.js';
import { MemorySessionStore } from '../src/core/session.js';
import {
  AUSD,
  FakeChain,
  GROUP_ID,
  MANDATE_ID,
  MEMBER,
  OTHER,
  ROGUE_SAFE,
  SAFE,
  fakeHostContext,
} from './fakes.js';

const NOW = 1_790_000_000_000;

function setup(host: Parameters<typeof fakeHostContext>[1] = {}) {
  const chain = new FakeChain();
  const api = new FakeSynqApi(chain, () => NOW);
  const { ctx, log } = fakeHostContext(chain, host);
  const journal = new MemoryJournal();
  const sessions = new MemorySessionStore();
  const deps: Deps = makeDeps(
    ctx,
    api.fetch,
    'synq:contribute',
    sessions,
    () => NOW,
  );
  const run = (input: Partial<ContributeInput> = {}) =>
    contribute(
      deps,
      { groupId: GROUP_ID, amount: '1.5', ...input },
      {
        journal,
        reconcileAttempts: 3,
        reconcileDelayMs: 0,
        sleep: async () => {},
      },
    );
  return { chain, api, log, journal, deps, run, sessions, ctx };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    if (error instanceof SynqPluginError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
};
const submitted = (log: ReturnType<typeof setup>['log']) =>
  log.flatMap((l) => l.requests).filter((r) => r.kind === 'transaction').length;

describe('synq contribute', () => {
  it('signs in as the member wallet once and reuses the session', async () => {
    const t = setup();
    await t.run();
    await t.run({ requestId: 'another-contribution' });
    expect(t.api.challengesIssued).toBe(1);
    const tokens = [...t.api.tokens.values()];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ memberId: 'alice' });
  });

  it('reads the verified group, submits one bounded AUSD transfer and returns a reconciled receipt', async () => {
    const t = setup();
    const r = await t.run();
    expect(r.mode).toBe('REAL_TESTNET');
    if (r.mode !== 'REAL_TESTNET') return;
    expect(r.safe).toBe(SAFE);
    expect(r.amount).toBe('1500000');
    expect(r.fundingState).toBe('CREDITED');
    expect(r.reconciled).toBe(true);
    expect(r.explorerUrl).toBe(`${NETWORK.explorerUrl}/tx/${r.txHash}`);
    expect(t.chain.balance(SAFE)).toBe(1_500_000n);
    expect(t.chain.balance(MEMBER)).toBe(8_500_000n);
    const kinds = t.log.flatMap((l) => l.requests).map((r) => r.kind);
    expect(kinds).toEqual(['typed-data', 'transaction']);
    expect(t.log.every((l) => l.source === 'synq:contribute')).toBe(true);
    const req = t.log.flatMap((l) => l.requests)[1]!;
    expect(req.kind).toBe('transaction');
    if (req.kind !== 'transaction') return;
    expect(req.chainId).toBe(NETWORK.chainId);
    expect(req.transaction.to).toBe(AUSD);
    expect(req.transaction.value).toBe(0n);
    expect(req.intent?.action).toBe('transfer');
    expect(t.api.calls.map((c) => c.path)).toContain(
      `/v1/funding/${r.fundingSessionId}/source`,
    );
    expect((await t.journal.get(r.requestId))?.state).toBe('CREDITED');
  });

  it('dry run prepares and validates without touching the wallet', async () => {
    const t = setup();
    const r = await t.run({ dryRun: true });
    expect(r.mode).toBe('DRY_RUN');
    expect(submitted(t.log)).toBe(0);
    expect(t.chain.balance(SAFE)).toBe(0n);
  });

  it('rejects the wrong chain before any API or wallet call', async () => {
    const t = setup();
    t.chain.chainId = 1;
    expect(await code(t.run())).toBe('WRONG_CHAIN');
    expect(submitted(t.log)).toBe(0);
  });

  it('rejects a group whose Synq account is not the MandateRegistry-bound Safe', async () => {
    const t = setup();
    t.api.group = {
      ...t.api.group,
      account: ROGUE_SAFE.toLowerCase() as `0x${string}`,
    };
    expect(await code(t.run())).toBe('WRONG_SAFE');
    expect(submitted(t.log)).toBe(0);
  });

  it('rejects a funding quote that pays another Safe', async () => {
    const t = setup();
    t.api.tamperQuote = (s) => ({
      ...s,
      quote: { ...s.quote, recipient: ROGUE_SAFE.toLowerCase() },
    });
    expect(await code(t.run())).toBe('WRONG_SAFE');
    expect(submitted(t.log)).toBe(0);
  });

  it('rejects a quote for another token, and calldata for another token', async () => {
    const t = setup();
    const fake = {
      chainId: NETWORK.chainId,
      address: OTHER.toLowerCase(),
      symbol: 'USDC',
      decimals: 6,
    };
    t.api.tamperQuote = (s) => ({
      ...s,
      quote: { ...s.quote, source: fake, destination: fake },
    });
    expect(await code(t.run())).toBe('INVALID_TOKEN');
    expect(submitted(t.log)).toBe(0);
    expect(() =>
      assertExactTransfer(
        {
          chainId: NETWORK.chainId,
          to: OTHER,
          data: transferCalldata(SAFE, 1n),
          value: 0n,
        },
        { safe: SAFE, amount: 1n },
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('enforces the contribution cap before any network call', async () => {
    const t = setup();
    expect(await code(t.run({ amount: '5.000001' }))).toBe('OVER_CAP');
    expect(t.api.calls).toHaveLength(0);
    const cap = capFromEnv({ SYNQ_MM_MAX_CONTRIBUTION: '2' });
    expect(cap).toBe(2_000_000n);
    expect(capFromEnv({ SYNQ_MM_MAX_CONTRIBUTION: '500' })).toBe(
      NETWORK.maxContributionBaseUnits,
    );
    const r = contribute(
      t.deps,
      { groupId: GROUP_ID, amount: '3' },
      { journal: t.journal, capBaseUnits: cap },
    );
    expect(await code(r)).toBe('OVER_CAP');
    expect(await code(t.run({ amount: '0' }))).toBe('INVALID_AMOUNT');
    expect(await code(t.run({ amount: '1.0000001' }))).toBe('INVALID_AMOUNT');
  });

  it('rejects a quote whose amount exceeds the request', async () => {
    const t = setup();
    t.api.tamperQuote = (s) => ({
      ...s,
      quote: { ...s.quote, amountIn: '4000000', amountOut: '4000000' },
    });
    expect(await code(t.run())).toBe('OVER_CAP');
    expect(submitted(t.log)).toBe(0);
  });

  it('requires a bound mandate to be active, AUSD-denominated and in window', async () => {
    const nowS = BigInt(NOW / 1000);
    const key = `${SAFE.toLowerCase()}:${MANDATE_ID}`;
    const t = setup();
    expect(await code(t.run({ mandateId: MANDATE_ID }))).toBe(
      'MANDATE_MISMATCH',
    );
    t.chain.mandates.set(key, {
      status: 1,
      version: 1n,
      token: OTHER,
      validAfter: 0n,
      validUntil: nowS + 100n,
    });
    expect(await code(t.run({ mandateId: MANDATE_ID }))).toBe(
      'MANDATE_MISMATCH',
    );
    t.chain.mandates.set(key, {
      status: 1,
      version: 1n,
      token: AUSD,
      validAfter: 0n,
      validUntil: nowS - 1n,
    });
    expect(await code(t.run({ mandateId: MANDATE_ID }))).toBe(
      'MANDATE_MISMATCH',
    );
    t.chain.mandates.set(key, {
      status: 2,
      version: 1n,
      token: AUSD,
      validAfter: 0n,
      validUntil: nowS + 100n,
    });
    expect(await code(t.run({ mandateId: MANDATE_ID }))).toBe(
      'MANDATE_MISMATCH',
    );
    expect(submitted(t.log)).toBe(0);
    t.chain.mandates.set(key, {
      status: 1,
      version: 1n,
      token: AUSD,
      validAfter: 0n,
      validUntil: nowS + 100n,
    });
    expect((await t.run({ mandateId: MANDATE_ID })).mode).toBe('REAL_TESTNET');
  });

  it('never submits the same contribution twice', async () => {
    const t = setup();
    await t.run();
    expect(await code(t.run())).toBe('DUPLICATE_CONTRIBUTION');
    expect(submitted(t.log)).toBe(1);
    expect(t.chain.balance(SAFE)).toBe(1_500_000n);
    const again = await t.run({ requestId: 'second-contribution' });
    expect(again.mode).toBe('REAL_TESTNET');
    expect(submitted(t.log)).toBe(2);
  });

  it('treats a Synq session that already has a source transaction as a duplicate', async () => {
    const t = setup();
    t.api.tamperQuote = (s) => ({
      ...s,
      state: 'SOURCE_SUBMITTED',
      sourceTransactionHash: `0x${'12'.repeat(32)}`,
    });
    expect(await code(t.run())).toBe('DUPLICATE_CONTRIBUTION');
    expect(submitted(t.log)).toBe(0);
  });

  it('holds the submission lock across concurrent runs', async () => {
    const t = setup();
    const results = await Promise.all([t.run(), t.run()].map(code));
    expect(results.filter((c) => c === 'NO_ERROR')).toHaveLength(1);
    expect(results.filter((c) => c === 'DUPLICATE_CONTRIBUTION')).toHaveLength(
      1,
    );
    expect(submitted(t.log)).toBe(1);
  });

  it('rejects an expired intent at quote and at authorization', async () => {
    const t = setup();
    t.api.quoteTtl = -1;
    expect(await code(t.run())).toBe('INTENT_EXPIRED');
    const u = setup();
    u.api.authorizeState = 'EXPIRED';
    expect(await code(u.run())).toBe('INTENT_EXPIRED');
    expect(submitted(t.log) + submitted(u.log)).toBe(0);
  });

  it('rejects a spender that is not the selected member wallet', async () => {
    const t = setup({ wallets: [MEMBER, OTHER], selected: MEMBER });
    expect(await code(t.run({ from: OTHER }))).toBe('WRONG_SPENDER');
    const u = setup({ wallets: [MEMBER, OTHER], selected: null });
    expect(await code(u.run())).toBe('WRONG_SPENDER');
    const v = setup();
    v.api.tamperQuote = (s) => ({
      ...s,
      quote: { ...s.quote, sourceSender: OTHER.toLowerCase() },
    });
    expect(await code(v.run())).toBe('WRONG_SPENDER');
    expect(submitted(t.log) + submitted(u.log) + submitted(v.log)).toBe(0);
  });

  it('refuses a session signed by a wallet other than the member', async () => {
    const t = setup({ typedSigner: OTHER });
    expect(await code(t.run())).toBe('WRONG_SPENDER');
    expect(submitted(t.log)).toBe(0);
    expect(t.api.tokens.size).toBe(0);
  });

  it('detects a host that signed from another wallet and never reports it as credited', async () => {
    const t = setup({ signer: OTHER });
    expect(await code(t.run())).toBe('WRONG_SPENDER');
    const entry = (await t.journal.list())[0]!;
    expect(entry.state).toBe('SUBMITTED');
    expect(t.api.calls.some((c) => c.path.endsWith('/source'))).toBe(false);
  });

  it('rejects revoked members and non-members', async () => {
    const t = setup();
    t.api.group = {
      ...t.api.group,
      memberships: t.api.group.memberships.map((m) =>
        m.memberId === 'alice'
          ? { ...m, status: 'REVOKED', revokedAt: '2026-10-01' }
          : m,
      ),
    };
    expect(await code(t.run())).toBe('MEMBERSHIP_REVOKED');
    const u = setup();
    u.api.group = {
      ...u.api.group,
      memberships: u.api.group.memberships.filter(
        (m) => m.memberId !== 'alice',
      ),
    };
    expect(await code(u.run())).toBe('NOT_A_MEMBER');
    expect(submitted(t.log) + submitted(u.log)).toBe(0);
  });

  it('surfaces an Agent Wallet policy rejection without crediting', async () => {
    const t = setup({ rejectWith: 'POLICY_DENIED' });
    expect(await code(t.run())).toBe('SUBMISSION_FAILED');
    expect((await t.journal.list())[0]!.state).toBe('FAILED');
    expect(t.chain.balance(SAFE)).toBe(0n);
    expect(await code(t.run())).toBe('DUPLICATE_CONTRIBUTION');
  });

  it('refuses when the member wallet lacks AUSD', async () => {
    const t = setup();
    t.chain.balances.set(MEMBER.toLowerCase(), 1n);
    expect(await code(t.run())).toBe('INSUFFICIENT_BALANCE');
    expect(submitted(t.log)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  fundJoinTypedData,
  safeTransactionHash,
  safeTransactionTypedData,
  type SafeGovernanceTransaction,
} from '@synq/identity';
import type { SendRecord } from '@synq/funding';
import type { IdentityChallenge, Mandate } from '@synq/schemas';
import {
  FUND_LIMITS,
  FundError,
  FundService,
  MemoryFundStore,
  cleanName,
  type FundPorts,
} from '../../apps/demo/src/fund-service.js';

const CHAIN_ID = 10143;
const SAFE = `0x${'5a'.repeat(20)}` as Address;
const GROUP = `0x${'9a'.repeat(32)}` as Hex;
const people = {
  ana: privateKeyToAccount(`0x${'11'.repeat(32)}`),
  ben: privateKeyToAccount(`0x${'22'.repeat(32)}`),
  cy: privateKeyToAccount(`0x${'33'.repeat(32)}`),
};
const principalOf = (a: { address: Address }) =>
  `mera:${a.address.toLowerCase()}`;

function harness() {
  let now = 1_800_000_000;
  const calls: string[] = [];
  let nonce = 0n;
  const joined = new Set<string>();
  const transfers: bigint[] = [];
  const sends: SendRecord[] = [];
  const ports: FundPorts = {
    now: () => now,
    chainId: CHAIN_ID,
    operator: `0x${'0e'.repeat(20)}`,
    asset: { symbol: 'AUSD', decimals: 6 } as Mandate['inputAsset'],
    principal: async (id) => {
      const a = Object.values(people).find((p) => principalOf(p) === id);
      return a
        ? { signer: a.address, kind: 'MERA_HUMAN', status: 'ACTIVE' }
        : null;
    },
    operatorGas: async () => 10n ** 18n,
    createGroup: async (owners) => {
      calls.push(`createGroup:${owners.length}`);
      return { chainGroupId: GROUP, account: SAFE, blockNumber: 7n };
    },
    bindGroup: async () => {
      calls.push('bindGroup');
    },
    joinChallenge: async (groupId, memberId, principalId) =>
      ({
        challengeId: `ch_${memberId}`,
        purpose: 'JOIN',
        groupId,
        memberId,
        principalId,
      }) as unknown as IdentityChallenge,
    join: async (_g, challengeId) => {
      joined.add(challengeId);
    },
    safeNonce: async () => nonce,
    execSafe: async (_account, tx, signatures) => {
      calls.push(`exec:${tx.nonce}:${signatures.length}`);
      nonce += 1n;
      return `0x${'e'.repeat(63)}${String(tx.nonce)}` as Hex;
    },
    setupCalls: () => [
      { to: `0x${'01'.repeat(20)}`, data: '0xaa', step: 'setExecutor' },
      { to: `0x${'02'.repeat(20)}`, data: '0xbb', step: 'configureMandate' },
    ],
    mandate: (input) =>
      ({
        mandateId: 'synq_send',
        members: input.members,
      }) as unknown as Mandate,
    activateMandate: async () => {
      calls.push('activateMandate');
    },
    transfer: async (_account, units) => {
      transfers.push(units);
      return `0x${'f'.repeat(64)}` as Hex;
    },
    treasury: async () =>
      transfers.reduce((a, b) => a + b, 0n) - 1_500_000n * BigInt(sends.length),
    sends: async () => sends,
    quorum: async () => ({ memberIds: ['member_1'], required: 2 }),
    explorer: (h) => `https://explorer/tx/${h}`,
    log: () => undefined,
  };
  const service = new FundService(new MemoryFundStore(), ports);
  return {
    service,
    calls,
    joined,
    transfers,
    sends,
    advance: (s: number) => {
      now += s;
    },
    now: () => now,
  };
}

async function joinAs(
  h: ReturnType<typeof harness>,
  fundId: string,
  key: string,
  who: keyof typeof people,
  overrides: { issuedAt?: number; name?: string } = {},
) {
  const account = people[who];
  const join = {
    fundId,
    principalId: principalOf(account),
    name: overrides.name ?? who,
    issuedAt: overrides.issuedAt ?? h.now(),
  };
  const signature = await account.signTypedData(fundJoinTypedData(join));
  return h.service.join(fundId, { key, ...join, signature });
}

async function activateAs(
  h: ReturnType<typeof harness>,
  fundId: string,
  key: string,
  who: keyof typeof people,
) {
  const account = people[who];
  const principalId = principalOf(account);
  const { challenge, safeTransactions } = await h.service.activationChallenge(
    fundId,
    { key, principalId },
  );
  const txs: SafeGovernanceTransaction[] = safeTransactions.map((t) => ({
    ...t,
    nonce: BigInt(t.nonce),
  }));
  return h.service.activate(fundId, {
    key,
    principalId,
    joinSignature: challenge ? (`0x${'ab'.repeat(65)}` as Hex) : null,
    safeSignatures: await Promise.all(
      txs.map(async (tx) => ({
        safeTxHash: safeTransactionHash(tx),
        signature: await account.signTypedData(safeTransactionTypedData(tx)),
      })),
    ),
  });
}

describe('group funds started from the Messages app', () => {
  it('forms, launches, activates with owner signatures and goes live with starter funds', async () => {
    const h = harness();
    const { fundId, key, adminKey } = await h.service.create({
      name: '  Lisbon   trip ',
    });
    expect(fundId).toMatch(/^fnd_[0-9a-f]{20}$/);
    expect((await h.service.view(fundId, key)).name).toBe('Lisbon trip');

    await joinAs(h, fundId, key, 'ana', { name: 'Ana' });
    await expect(h.service.launch(fundId, adminKey)).rejects.toMatchObject({
      code: 'NOT_ENOUGH_MEMBERS',
    });
    await joinAs(h, fundId, key, 'ben', { name: 'Ben' });
    await expect(h.service.launch(fundId, key)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await h.service.launch(fundId, adminKey);
    await expect(joinAs(h, fundId, key, 'cy')).rejects.toMatchObject({
      code: 'WRONG_STATE',
    });

    await h.service.tick();
    let view = await h.service.view(fundId, key);
    expect(view.state).toBe('SETUP');
    expect(view.group?.account).toBe(SAFE);
    expect(view.members.map((m) => m.memberId)).toEqual([
      'member_0',
      'member_1',
    ]);
    expect(h.calls).toEqual(['createGroup:2', 'bindGroup']);

    // One owner is not enough for the 2-of-n setup transactions.
    view = await activateAs(h, fundId, key, 'ana');
    expect(view.setup).toEqual({ signed: 1, required: 2 });
    expect(view.members[0]!.activated).toBe(true);
    await h.service.tick();
    expect((await h.service.view(fundId, key)).state).toBe('SETUP');

    await activateAs(h, fundId, key, 'ben');
    expect([...h.joined].sort()).toEqual(['ch_member_0', 'ch_member_1']);
    await h.service.tick();
    view = await h.service.view(fundId, key);
    expect(view.state).toBe('ACTIVE');
    expect(h.calls).toEqual([
      'createGroup:2',
      'bindGroup',
      'exec:0:2',
      'exec:1:2',
      'activateMandate',
    ]);
    await h.service.tick();
    expect(h.transfers).toEqual([FUND_LIMITS.starterUnits]);
    view = await h.service.view(fundId, key);
    expect(view.treasury).toEqual({ balance: '5', symbol: 'AUSD' });
    expect(view.recipients).toEqual([
      { name: 'Ana', recipientId: 'member:member_0' },
      { name: 'Ben', recipientId: 'member:member_1' },
    ]);
  });

  it('maps the group’s Sends to proposals with approver names and receipts', async () => {
    const h = harness();
    const { fundId, key, adminKey } = await h.service.create({ name: 'Rent' });
    await joinAs(h, fundId, key, 'ana', { name: 'Ana' });
    await joinAs(h, fundId, key, 'ben', { name: 'Ben' });
    await h.service.launch(fundId, adminKey);
    await h.service.tick();
    await activateAs(h, fundId, key, 'ana');
    await activateAs(h, fundId, key, 'ben');
    await h.service.tick();
    await h.service.tick();
    const send = (state: SendRecord['state'], receipt: SendRecord['receipt']) =>
      ({
        state,
        intentHash: `0x${'4'.repeat(64)}`,
        draftDigest: `0x${'d'.repeat(64)}`,
        preview: {
          amountDecimal: '1.5',
          asset: { symbol: 'AUSD' },
          recipient: { address: people.ben.address, label: 'member_1' },
        },
        sender: { memberId: 'member_0' },
        receipt,
        history: [{ state: 'PREVIEWED', at: 1 }],
      }) as unknown as SendRecord;
    h.sends.push(send('PENDING_APPROVAL', null));
    let [p] = (await h.service.view(fundId, key)).proposals;
    expect(p).toMatchObject({
      state: 'PENDING',
      amount: '1.5',
      recipient: 'Ben',
      sender: 'Ana',
      approvals: { counted: 1, required: 2, names: ['Ben'] },
      transactionHash: null,
    });
    h.sends[0] = send('INDEXED', {
      transactionHash: `0x${'7'.repeat(64)}`,
    } as SendRecord['receipt']);
    [p] = (await h.service.view(fundId, key)).proposals;
    expect(p).toMatchObject({
      state: 'PAID',
      explorer: `https://explorer/tx/0x${'7'.repeat(64)}`,
    });
  });

  it('refuses forged joins, stale joins, duplicates and wrong keys', async () => {
    const h = harness();
    const { fundId, key } = await h.service.create({ name: 'Club' });
    await expect(h.service.view(fundId, 'x'.repeat(32))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const join = {
      fundId,
      principalId: principalOf(people.ana),
      name: 'Ana',
      issuedAt: h.now(),
    };
    // Ben signs a join that claims to be Ana.
    const forged = await people.ben.signTypedData(fundJoinTypedData(join));
    await expect(
      h.service.join(fundId, { key, ...join, signature: forged }),
    ).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    await expect(
      joinAs(h, fundId, key, 'ana', { issuedAt: h.now() - 3_600 }),
    ).rejects.toMatchObject({ code: 'STALE_SIGNATURE' });
    await joinAs(h, fundId, key, 'ana');
    await expect(joinAs(h, fundId, key, 'ana')).rejects.toMatchObject({
      code: 'ALREADY_MEMBER',
    });
    await expect(
      joinAs(h, fundId, key, 'ben', { name: '\u0007' }),
    ).rejects.toBeInstanceOf(FundError);
  });

  it('rejects setup signatures from a member over a different transaction', async () => {
    const h = harness();
    const { fundId, key, adminKey } = await h.service.create({ name: 'Club' });
    await joinAs(h, fundId, key, 'ana');
    await joinAs(h, fundId, key, 'ben');
    await h.service.launch(fundId, adminKey);
    await h.service.tick();
    const { safeTransactions } = await h.service.activationChallenge(fundId, {
      key,
      principalId: principalOf(people.ana),
    });
    const real = {
      ...safeTransactions[0]!,
      nonce: BigInt(safeTransactions[0]!.nonce),
    };
    const other = { ...real, data: '0xdead' as Hex };
    await expect(
      h.service.activate(fundId, {
        key,
        principalId: principalOf(people.ana),
        joinSignature: null,
        safeSignatures: [
          {
            safeTxHash: safeTransactionHash(real),
            signature: await people.ana.signTypedData(
              safeTransactionTypedData(other),
            ),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });
    await expect(
      h.service.activationChallenge(fundId, {
        key,
        principalId: principalOf(people.cy),
      }),
    ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
  });

  it('caps test funds and refuses launches when the operator is out of gas', async () => {
    const h = harness();
    const { fundId, key, adminKey } = await h.service.create({ name: 'Club' });
    await joinAs(h, fundId, key, 'ana');
    await joinAs(h, fundId, key, 'ben');
    const broke = new FundService(h.service.store, {
      ...h.service.ports,
      operatorGas: async () => 0n,
    });
    await expect(broke.launch(fundId, adminKey)).rejects.toMatchObject({
      code: 'OPERATOR_OUT_OF_GAS',
    });
    await h.service.launch(fundId, adminKey);
    await h.service.tick();
    await activateAs(h, fundId, key, 'ana');
    await activateAs(h, fundId, key, 'ben');
    await h.service.tick();
    for (
      let i = 0;
      i < Number(FUND_LIMITS.faucetMaxUnits / FUND_LIMITS.faucetUnits);
      i++
    )
      await h.service.requestTestFunds(fundId, key);
    await expect(h.service.requestTestFunds(fundId, key)).rejects.toMatchObject(
      { code: 'FAUCET_LIMIT' },
    );
    await h.service.tick();
    expect(h.transfers).toEqual([
      FUND_LIMITS.starterUnits + FUND_LIMITS.faucetMaxUnits,
    ]);
  });

  it('cleans display names', () => {
    expect(cleanName('  Ana \n Lopez ', 32)).toBe('Ana Lopez');
    expect(cleanName('', 32)).toBeNull();
    expect(cleanName('x'.repeat(33), 32)).toBeNull();
    expect(cleanName('a‮b', 32)).toBeNull();
  });
});

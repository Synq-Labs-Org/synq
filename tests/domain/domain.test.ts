import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ACTION_MACHINE,
  ACTION_STATES,
  ActionIntentSchema,
  AddressSchema,
  AmountSchema,
  AssetSchema,
  BoundActionIntentSchema,
  DomainEventSchema,
  ExecutionGrantSchema,
  GroupIdSchema,
  MandateSchema,
  NetworkProfileSchema,
  PluginManifestSchema,
  TX_MACHINE,
  TX_STATES,
  TransitionError,
  UINT256_MAX,
  UniqueIds,
  ValidationError,
  actionStateOfTx,
  createDomainEvent,
  currentState,
  delegateCapabilities,
  formatDecimal,
  fromAmount,
  networkProfileForChain,
  newId,
  parseDecimal,
  recordTransition,
  toAmount,
  transition,
  verifyHistory,
  type ActionState,
  type PrincipalRef,
  type StateMachine,
  type TransitionRecord,
  type TxState,
} from '@synq/domain';
import { z } from 'zod';
import { asset, intent, mandate, network } from '../kernel/fixtures.js';

const actor: PrincipalRef = {
  principalId: 'principal_test' as PrincipalRef['principalId'],
  kind: 'SERVICE',
};
const evidenceHash = `0x${'a'.repeat(64)}` as const;
function walk<S extends string>(
  machine: StateMachine<S>,
  path: readonly S[],
  start = 0,
) {
  const history: TransitionRecord<S>[] = [];
  for (const [i, to] of path.entries())
    history.push(
      recordTransition(machine, history, {
        actor,
        at: new Date(Date.UTC(2026, 9, 9, 0, 0, start + i)).toISOString(),
        to,
        evidenceHash,
      }),
    );
  return history;
}
function reachable<S extends string>(
  machine: StateMachine<S>,
  from: S,
  without: readonly S[] = [],
): Set<S> {
  const seen = new Set<S>([from]);
  const queue = [from];
  while (queue.length) {
    const next = queue.shift()!;
    for (const s of machine.successors(next))
      if (!seen.has(s) && !without.includes(s)) {
        seen.add(s);
        queue.push(s);
      }
  }
  return seen;
}
const wireIntent = () =>
  ActionIntentSchema.parse({
    intentId: 'intent_wire',
    groupId: 'group_1',
    mandateId: 'mandate_1',
    mandateVersion: 1,
    action: 'SPOT_TRADE',
    chainId: 10143,
    pluginId: 'kuru',
    target: '0x1111111111111111111111111111111111111111',
    maxInputAmount: '25000000',
    inputToken: '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC',
    validAfter: 0,
    validUntil: 9999999999,
    nonce: '1',
    evidenceHash,
    riskPacketHash: evidenceHash,
  });

describe('Canonical domain boundaries', () => {
  it('DOM-001 rejects unknown ActionIntent fields and unsupported economic inputs', () => {
    for (const patch of [
      { extra: true },
      { network },
      { inputAsset: asset },
      { chainId: 1 },
      { action: 'OWNER_CHANGE' },
      { maxInputAmount: 25 },
      { maxInputAmount: '-1' },
      { maxInputAmount: '01' },
      { maxInputAmount: '1.5' },
      { maxInputAmount: '0' },
      { target: '0x123' },
      { target: `0x${'0'.repeat(40)}` },
      { validUntil: 900 },
      { selector: '0x1234' },
    ])
      expect(() => intent(patch), JSON.stringify(patch)).toThrow();
    expect(
      ActionIntentSchema.safeParse({ ...wireIntent(), secret: 'PAN' }).success,
    ).toBe(false);
  });
  it('DOM-007 rejects unknown fields in every nested wire record', () => {
    expect(() => mandate({ unknown: 'field' })).toThrow();
    expect(() =>
      mandate({ inputAsset: { ...asset, secret: 'PAN' } }),
    ).toThrow();
    expect(() => mandate({ quorum: 4 })).toThrow();
    expect(() => mandate({ perActionCap: '201' })).toThrow();
    expect(() => mandate({ autoCap: '1e18' })).toThrow();
    expect(
      ExecutionGrantSchema.safeParse({ schemaVersion: 1, extra: 1 }).success,
    ).toBe(false);
    expect(
      NetworkProfileSchema.safeParse({ ...network, rpc: 'x' }).success,
    ).toBe(false);
    const event = createDomainEvent(z.strictObject({ n: z.number() }), {
      type: 'test.created',
      actor,
      correlationId: 'corr_1',
      payload: { n: 1 },
    });
    expect(DomainEventSchema.safeParse({ ...event, extra: 1 }).success).toBe(
      false,
    );
    expect(
      PluginManifestSchema.safeParse({
        id: 'x',
        version: '1.0.0',
        capabilities: ['QUOTE'],
        chains: [10143],
        riskClass: 'READ_ONLY',
        requiresSimulation: false,
        maxGrantTtlSeconds: 60,
        apiKey: 'k',
      }).success,
    ).toBe(false);
  });
  it('DOM-002 losslessly serializes uint256 money as canonical decimal strings', () => {
    expect(fromAmount(JSON.parse(JSON.stringify(toAmount(UINT256_MAX))))).toBe(
      UINT256_MAX,
    );
    expect(() => AmountSchema.parse((UINT256_MAX + 1n).toString())).toThrow();
    expect(() => toAmount(-1n)).toThrow();
    expect(AmountSchema.parse(12n)).toBe('12');
    expect(AmountSchema.safeParse(12).success).toBe(false);
    expect(AmountSchema.safeParse('1.0').success).toBe(false);
  });
  it('DOM-008 round-trips a full ActionIntent through JSON with bigint inputs', () => {
    const bound = BoundActionIntentSchema.parse({
      ...intent(),
      maxInputAmount: UINT256_MAX,
      nonce: UINT256_MAX - 1n,
      nativeValue: 7n,
    });
    const wire = JSON.parse(JSON.stringify(bound));
    expect(BoundActionIntentSchema.parse(wire)).toEqual(bound);
    expect(BigInt(wire.maxInputAmount)).toBe(UINT256_MAX);
    expect(ActionIntentSchema.parse(wire)).toEqual(bound);
    const minimal = wireIntent();
    expect(minimal).toMatchObject({
      schemaVersion: 1,
      nativeValue: '0',
      maxSlippageBps: 0,
      leverageBps: 0,
    });
    expect(
      ActionIntentSchema.parse(JSON.parse(JSON.stringify(minimal))),
    ).toEqual(minimal);
  });
  it('DOM-003 permits the canonical lifecycle and rejects skipped custody states', () => {
    const path = ACTION_STATES.slice(0, 15);
    for (let i = 0; i < path.length - 1; i++)
      expect(transition(path[i]!, path[i + 1]!)).toBe(path[i + 1]);
    expect(() => transition('PROPOSED', 'SIGNED')).toThrow(TransitionError);
    expect(() => transition('EXPIRED', 'AUTHORIZED')).toThrow(
      'INVALID_TRANSITION',
    );
    expect(() => transition('CANCELLED', 'SUBMITTED')).toThrow();
    expect(() => transition('SIGNED', 'CONFIRMED')).toThrow();
  });
  it('DOM-009 records append-only transition history with actor, time and evidence', () => {
    const history = walk(ACTION_MACHINE, [
      'NORMALIZED',
      'PROPOSED',
      'RISKED',
      'SIMULATED',
      'PENDING_APPROVAL',
      'AUTHORIZED',
      'PREPARED',
      'SIGNED',
      'SUBMITTED',
      'CONFIRMED',
      'INDEXED',
      'RECONCILED',
      'EXPLAINED',
    ]);
    expect(history[0]).toMatchObject({
      from: 'RECEIVED',
      to: 'NORMALIZED',
      actor,
      evidenceHash,
    });
    expect(verifyHistory(ACTION_MACHINE, history)).toBe('EXPLAINED');
    expect(ACTION_MACHINE.isTerminal('EXPLAINED')).toBe(true);
    expect(() =>
      recordTransition(ACTION_MACHINE, history.slice(0, 2), {
        actor,
        at: history[1]!.at,
        to: 'SIGNED',
        evidenceHash,
      }),
    ).toThrow(TransitionError);
    expect(() =>
      recordTransition(ACTION_MACHINE, history.slice(0, 2), {
        actor,
        at: '2020-01-01T00:00:00Z',
        to: 'RISKED',
        evidenceHash,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      recordTransition(ACTION_MACHINE, [], {
        actor,
        at: 'yesterday',
        to: 'NORMALIZED',
        evidenceHash,
      }),
    ).toThrow(ValidationError);
    const forged = history.map((r, i) =>
      i === 3 ? { ...r, from: 'RECEIVED' as ActionState } : r,
    );
    expect(() => verifyHistory(ACTION_MACHINE, forged)).toThrow();
    const tx = walk(TX_MACHINE, [
      'SIGNED',
      'RECONCILIATION_REQUIRED',
      'INCLUDED',
      'CONFIRMED',
      'INDEXED',
      'RECONCILED',
      'SETTLED',
    ]);
    expect(currentState(TX_MACHINE, tx)).toBe('SETTLED');
    expect(TX_MACHINE.canTransition('SIGNED', 'CONFIRMED')).toBe(false);
    expect(TX_MACHINE.canTransition('SUBMITTED', 'CONFIRMED')).toBe(false);
    expect(TX_STATES).not.toContain('REVERTED');
  });
  it('DOM-009 property: random walks stay on canonical edges and cannot skip authorization', () => {
    const withoutAuthorization = reachable(ACTION_MACHINE, 'RECEIVED', [
      'AUTHORIZED',
    ]);
    for (const custody of ['PREPARED', 'SIGNED', 'SUBMITTED'] as const)
      expect(withoutAuthorization.has(custody)).toBe(false);
    const all = reachable(ACTION_MACHINE, 'RECEIVED');
    expect([...all].sort()).toEqual([...ACTION_STATES].sort());
    expect([...reachable(TX_MACHINE, 'PREPARED')].sort()).toEqual(
      [...TX_STATES].sort(),
    );
    for (const from of TX_STATES)
      for (const to of TX_MACHINE.successors(from)) {
        const a = actionStateOfTx(from),
          b = actionStateOfTx(to);
        expect(
          a === b || ACTION_MACHINE.canTransition(a, b),
          `${from}->${to}`,
        ).toBe(true);
      }
    fc.assert(
      fc.property(fc.array(fc.nat(), { maxLength: 40 }), (choices) => {
        let state: ActionState = ACTION_MACHINE.initial;
        const history: TransitionRecord<ActionState>[] = [];
        for (const [i, c] of choices.entries()) {
          const next = ACTION_MACHINE.successors(state);
          if (!next.length) break;
          const to = next[c % next.length]!;
          history.push(
            recordTransition(ACTION_MACHINE, history, {
              actor,
              at: new Date(1_800_000_000_000 + i * 1000).toISOString(),
              to,
              evidenceHash,
            }),
          );
          state = to;
          if (state === 'SIGNED')
            expect(history.some((r) => r.to === 'AUTHORIZED')).toBe(true);
        }
        expect(verifyHistory(ACTION_MACHINE, history)).toBe(state);
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...ACTION_STATES),
        fc.constantFrom(...ACTION_STATES),
        (from, to) => {
          expect(ACTION_MACHINE.canTransition(from, to)).toBe(
            ACTION_MACHINE.successors(from).includes(to),
          );
          if (!ACTION_MACHINE.canTransition(from, to))
            expect(() => transition(from, to)).toThrow(TransitionError);
        },
      ),
    );
  });
  it('DOM-004 rejects network/profile mismatches', () => {
    expect(NetworkProfileSchema.parse(network)).toEqual(network);
    expect(networkProfileForChain(10143).profile).toBe('sandbox/monad-testnet');
    expect(networkProfileForChain(143).profile).toBe('proof/monad-mainnet');
    for (const bad of [
      { ...network, chainId: 143 },
      { ...network, providerEnvironment: 'production' },
      { ...network, profile: 'local' },
      {
        profile: 'proof/monad-mainnet',
        chainId: 10143,
        providerEnvironment: 'production',
      },
    ])
      expect(NetworkProfileSchema.safeParse(bad).success).toBe(false);
    expect(() =>
      AssetSchema.parse({
        ...asset,
        canonicalAssetId: 'eip155:143/erc20:' + asset.address,
      }),
    ).toThrow();
  });
  it('DOM-010 rejects cross-profile assets and environments', () => {
    expect(() =>
      mandate({
        inputAsset: {
          ...asset,
          chainId: 10143,
          canonicalAssetId: `eip155:10143/erc20:${asset.address}`,
        },
      }),
    ).toThrow();
    expect(
      PluginManifestSchema.safeParse({
        id: 'kuru',
        version: '1.0.0',
        capabilities: ['QUOTE'],
        chains: [143],
        environments: ['sandbox/monad-testnet'],
        riskClass: 'READ_ONLY',
        requiresSimulation: false,
        maxGrantTtlSeconds: 60,
      }).success,
    ).toBe(false);
    expect(
      AddressSchema.safeParse('0xA9012a055bd4e0eDfF8Ce09f960291C09D5322dC')
        .success,
    ).toBe(false);
    expect(
      AddressSchema.parse('0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC'),
    ).toBe('0xa9012a055bd4e0edff8ce09f960291c09d5322dc');
  });
  it('DOM-005 generates unique branded identifiers and rejects replay insert', () => {
    const values = Array.from({ length: 500 }, () => newId('intent'));
    expect(new Set(values).size).toBe(values.length);
    const store = new UniqueIds();
    store.claim(values[0]!);
    expect(() => store.claim(values[0]!)).toThrow('DUPLICATE_ID');
  });
  it('DOM-011 branded identifiers are validated at every schema boundary', () => {
    expect(GroupIdSchema.safeParse('bad id with spaces').success).toBe(false);
    expect(GroupIdSchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(() => intent({ groupId: '../etc/passwd' })).toThrow();
    expect(() =>
      mandate({
        members: mandate().members.map((m) => ({ ...m, memberId: 'dup' })),
      }),
    ).toThrow();
    const id = newId('group');
    expect(GroupIdSchema.parse(id)).toBe(id);
    expect(id.startsWith('group_')).toBe(true);
  });
  it('DOM-006 parses decimal money without float rounding', () => {
    expect(parseDecimal('999999999999.123456', 6)).toBe(999999999999123456n);
    expect(parseDecimal('0.1', 18) + parseDecimal('0.2', 18)).toBe(
      parseDecimal('0.3', 18),
    );
    expect(() => parseDecimal('1.0000001', 6)).toThrow('DECIMAL_PRECISION');
    expect(() => parseDecimal('1e5', 6)).toThrow('INVALID_DECIMAL');
    expect(() => parseDecimal('1', 37)).toThrow('INVALID_DECIMAL');
    expect(() => formatDecimal(1n, -1)).toThrow('INVALID_DECIMALS');
    expect(formatDecimal(1n, 6)).toBe('0.000001');
  });
  it('DOM-012 property: decimal formatting and parsing are exact inverses', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: UINT256_MAX }),
        fc.integer({ min: 0, max: 36 }),
        (value, decimals) => {
          expect(parseDecimal(formatDecimal(value, decimals), decimals)).toBe(
            value,
          );
        },
      ),
      { numRuns: 300 },
    );
  });
  it('SynqError exposes a stable code and a safe public message', () => {
    try {
      parseDecimal('1.0000001', 6);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'DECIMAL_PRECISION' });
      expect(JSON.parse(JSON.stringify(error))).toEqual({
        code: 'DECIMAL_PRECISION',
        message: 'Amount has more precision than the token supports.',
      });
    }
  });
  it('domain events match the versioned envelope and are generic over payloads', () => {
    const payload = z.strictObject({ amount: z.string() });
    const event = createDomainEvent(payload, {
      type: 'treasury.deposit_observed',
      actor,
      correlationId: 'corr_1',
      groupId: 'group_1',
      payload: { amount: '1' },
    });
    expect(Object.keys(event).sort()).toEqual(
      [
        'actor',
        'correlationId',
        'eventId',
        'groupId',
        'occurredAt',
        'payload',
        'schemaVersion',
        'type',
      ].sort(),
    );
    expect(event.schemaVersion).toBe(1);
    expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt);
    expect(() =>
      createDomainEvent(payload, {
        type: 'treasury.deposit_observed',
        actor,
        correlationId: 'corr_1',
        payload: { amount: 1 } as unknown as { amount: string },
      }),
    ).toThrow(ValidationError);
    expect(
      DomainEventSchema.safeParse({ ...event, occurredAt: 1700000000 }).success,
    ).toBe(false);
  });
  it('delegation narrows capabilities and centralizes non-delegable powers', () => {
    expect(
      delegateCapabilities(
        ['READ_MARKET', 'PROPOSE_ACTION'],
        ['PROPOSE_ACTION'],
      ),
    ).toEqual(['PROPOSE_ACTION']);
    expect(() => delegateCapabilities(['SIGN'], ['SIGN'])).toThrow(
      'CAPABILITY_ESCALATION',
    );
    expect(() => delegateCapabilities(['READ_MARKET'], ['QUOTE'])).toThrow();
  });
  it('mock action moves through domain states without any provider SDK', () => {
    const tx = walk(TX_MACHINE, [
      'SIGNED',
      'SUBMITTED',
      'INCLUDED',
      'CONFIRMED',
      'INDEXED',
      'RECONCILED',
      'SETTLED',
    ] satisfies TxState[]);
    const projected = tx.map((r) => actionStateOfTx(r.to));
    const action = walk(ACTION_MACHINE, [
      'NORMALIZED',
      'PROPOSED',
      'RISKED',
      'SIMULATED',
      'AUTHORIZED',
      'PREPARED',
      ...projected.filter((s, i) => s !== projected[i - 1]),
      'EXPLAINED',
    ]);
    expect(currentState(ACTION_MACHINE, action)).toBe('EXPLAINED');
    expect(MandateSchema.parse(mandate())).toEqual(mandate());
  });
});

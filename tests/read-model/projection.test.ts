import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  DeterministicReadModel,
  verifyFresh,
} from '../../packages/read-model/src/index.js';
import {
  address,
  binding,
  chainId,
  event,
  hash,
  proof,
  treasuryToken,
} from './fixtures.js';
const create = () =>
  new DeterministicReadModel(chainId, treasuryToken, [binding]);
describe('deterministic chain projections', () => {
  it('reconstructs official testnet token fixtures, mandate terms and execution from shuffled duplicates', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(proof(), { minLength: 4, maxLength: 4 }),
        (events) => {
          const model = create();
          model.ingest([...events, ...events], 3);
          const snapshot = model.snapshot(binding.groupId, 3, 1000);
          expect(snapshot.treasuryBalance).toBe('900000');
          expect(snapshot.members).toHaveLength(3);
          expect(snapshot.mandates[hash(2)]?.version).toBe('1');
          expect(Object.keys(snapshot.executed)).toEqual(['1']);
          const rebuilt = create();
          rebuilt.rebuild(model.events(), 3);
          expect(rebuilt.snapshot(binding.groupId, 3, 1000)).toEqual(snapshot);
        },
      ),
      { numRuns: 50 },
    );
  });
  it('detects forks, rewinds dependent state and accepts replacement branch', () => {
    const model = create();
    model.ingest(proof(), 3);
    const pause = event(
      'PauseChanged',
      3,
      { groupId: binding.groupId, account: binding.account, paused: true },
      { blockHash: hash(999) },
    );
    expect(() => model.ingest([pause], 3)).toThrow('Fork');
    model.rollback(3);
    model.ingest([pause], 3);
    expect(model.snapshot(binding.groupId, 3, 1000)).toMatchObject({
      paused: true,
      treasuryBalance: '1000000',
      executed: {},
    });
  });
  it('rejects conflicting duplicates, version gaps, unsupported versions and foreign contracts without partial mutation', () => {
    const model = create();
    model.ingest(proof(), 3);
    const before = model.snapshot(binding.groupId, 3, 1000);
    expect(() =>
      model.ingest(
        [
          {
            ...proof()[0],
            payload: { from: address(0), to: binding.account, value: '999' },
          },
        ],
        3,
      ),
    ).toThrow('Conflicting');
    expect(() =>
      model.ingest([{ ...proof()[0], schemaVersion: 2 }], 3),
    ).toThrow();
    expect(() =>
      create().ingest(
        [{ ...proof()[1], payload: { ...proof()[1]!.payload, version: '2' } }],
        3,
      ),
    ).toThrow('version');
    expect(() =>
      create().ingest([{ ...proof()[0], contract: address(99) }], 3),
    ).toThrow('token');
    expect(model.snapshot(binding.groupId, 3, 1000)).toEqual(before);
  });
  it('revokes only matching versions and makes cache/snapshot copies independent', () => {
    const model = create();
    model.ingest(proof(), 3);
    model.ingest(
      [
        event('MandateRevoked', 4, {
          groupId: binding.groupId,
          account: binding.account,
          mandateId: hash(2),
          version: '1',
        }),
      ],
      4,
    );
    const s = model.snapshot(binding.groupId, 5, 1000);
    s.mandates[hash(2)]!.active = true;
    expect(
      model.snapshot(binding.groupId, 5, 1000).mandates[hash(2)]!.active,
    ).toBe(false);
  });
  it('fails closed on artificial lag and DB/chain mismatch; direct check must explicitly succeed', async () => {
    const model = create();
    model.ingest(proof(), 3);
    const s = model.snapshot(binding.groupId, 10, 1000);
    await expect(verifyFresh(s, 10, 2)).rejects.toThrow('Stale');
    await expect(verifyFresh(s, 10, 2, async () => false)).rejects.toThrow(
      'Stale',
    );
    await expect(
      verifyFresh(s, 10, 2, async (x) => x.treasuryBalance === '900000'),
    ).resolves.toBe('direct');
    await expect(verifyFresh(s, 2, 2)).rejects.toThrow('Inconsistent');
  });
});

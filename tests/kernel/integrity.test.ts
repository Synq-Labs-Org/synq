import { describe, expect, it } from 'vitest';
import {
  Kernel,
  artifactHash,
  stateHash,
  type AuditRecord,
  type KernelSnapshot,
  type NonceStatusQuery,
} from '../../packages/kernel/src/index.js';
import {
  AUDIT_KEY,
  allPlugins,
  evidence,
  executedObservation,
  grantFor,
  harness,
  hash,
  intent,
  mandate,
  network,
  MODULE,
  type Harness,
} from './fixtures.js';

const GENESIS = `0x${'0'.repeat(64)}` as const;
const deps = (h: Harness, extra: Record<string, unknown> = {}) => ({
  clock: h.clock,
  approvalLedger: h.ledger,
  membershipDirectory: h.directory,
  nonceStatus: h.chain,
  freshness: { probe: h.probe, maxLagBlocks: 0 },
  plugins: allPlugins(),
  ...extra,
});

async function reconciled(nonce = '7', amount = '100') {
  const input = evidence(intent({ maxInputAmount: amount, nonce }));
  const h = harness([input], [mandate()]);
  const { grant } = await grantFor(h, input);
  const claim = h.kernel.claimForExecution(grant, input.intent, 'w');
  h.kernel.prepare(claim, hash(0x55));
  h.kernel.reconcile(grant.grantId, executedObservation(grant));
  return { h, grant, input };
}

function forge(snapshot: KernelSnapshot): KernelSnapshot {
  const snap = structuredClone(snapshot) as KernelSnapshot & {
    audit: AuditRecord[];
  };
  snap.grants = [];
  snap.nonces = [];
  snap.budgets = [];
  snap.lifecycles = [];
  snap.trustedEvidence.riskPacketHashes.push(hash(0x1234));
  const kept = snap.audit.filter(
    (r) =>
      !['CLAIM', 'PREPARE', 'RECONCILE', 'SNAPSHOT'].includes(r.kind) &&
      !(
        r.kind === 'AUTHORIZATION' &&
        (r.payload as { status?: string } | null)?.status === 'AUTHORIZED'
      ),
  );
  const rebuilt: AuditRecord[] = [];
  const push = (r: Pick<AuditRecord, 'recordedAt' | 'kind' | 'payload'>) => {
    const body = {
      schemaVersion: 1 as const,
      sequence: rebuilt.length,
      previousHash: (rebuilt.at(-1)?.hash ?? GENESIS) as `0x${string}`,
      recordedAt: r.recordedAt,
      kind: r.kind,
      payload: r.payload,
    };
    rebuilt.push({ ...body, hash: artifactHash(body) as `0x${string}` });
  };
  kept.forEach(push);
  snap.audit = [];
  push({
    recordedAt: snap.lastNow ?? 0,
    kind: 'SNAPSHOT',
    payload: { stateHash: stateHash({ ...snap, audit: [] }) },
  });
  snap.audit = rebuilt;
  return snap;
}

describe('keyed audit chain and anchored restore', () => {
  it('R7: a snapshot whose audit chain was rebuilt without the key is refused', async () => {
    const { h } = await reconciled();
    const forged = forge(h.kernel.snapshot());
    expect(() =>
      Kernel.restore(forged, deps(h, { auditKey: AUDIT_KEY })),
    ).toThrow('AUDIT_CHAIN_BROKEN');
    expect(() => Kernel.restore(forged, deps(h))).toThrow('AUDIT_CHAIN_BROKEN');
  });

  it('a keyed chain does not verify under another key, and a genuine snapshot restores', async () => {
    const { h } = await reconciled();
    const snapshot = h.kernel.snapshot();
    expect(() =>
      Kernel.restore(
        snapshot,
        deps(h, { auditKey: new Uint8Array(32).fill(9) }),
      ),
    ).toThrow('AUDIT_CHAIN_BROKEN');
    const restored = Kernel.restore(snapshot, deps(h, { auditKey: AUDIT_KEY }));
    expect(restored.accounting('group_1', 'mandate_1').spentToken).toBe('100');
  });

  it('restore compares the snapshot head with the sink head (rollback to an older snapshot is refused)', async () => {
    const records: AuditRecord[] = [];
    const sink = {
      append: (r: AuditRecord) => void records.push(r),
      head: () => records.at(-1)?.hash ?? null,
    };
    const input = evidence(intent({ maxInputAmount: '100', nonce: '8' }));
    const h = harness([input], [mandate()], { auditSink: sink });
    const { grant } = await grantFor(h, input);
    const older = h.kernel.snapshot();
    const claim = h.kernel.claimForExecution(grant, input.intent, 'w');
    h.kernel.prepare(claim, hash(0x55));
    h.kernel.reconcile(grant.grantId, executedObservation(grant));
    const latest = h.kernel.snapshot();
    expect(() =>
      Kernel.restore(older, deps(h, { auditKey: AUDIT_KEY, auditSink: sink })),
    ).toThrow('AUDIT_CHAIN_BROKEN');
    const forged = forge(latest);
    const unkeyedSink = { append: () => undefined, head: () => sink.head() };
    expect(() =>
      Kernel.restore(forged, deps(h, { auditSink: unkeyedSink })),
    ).toThrow('AUDIT_CHAIN_BROKEN');
    expect(() =>
      Kernel.restore(latest, deps(h, { auditKey: AUDIT_KEY, auditSink: sink })),
    ).not.toThrow();
  });

  it('restore without a key or an anchoring sink fails closed', async () => {
    const { h } = await reconciled();
    expect(() => Kernel.restore(h.kernel.snapshot(), deps(h))).toThrow(
      'AUDIT_CHAIN_BROKEN',
    );
  });

  it('non-local profiles require an audit key; short keys are refused', () => {
    const base = harness();
    const options = {
      ...deps(base),
      executionModule: MODULE,
      mandates: [],
      network: {
        profile: 'sandbox/monad-testnet',
        chainId: 10143,
        providerEnvironment: 'sandbox',
      } as const,
    };
    expect(() => new Kernel(options)).toThrow('AUDIT_UNAVAILABLE');
    expect(
      () => new Kernel({ ...options, network, auditKey: new Uint8Array(8) }),
    ).toThrow('AUDIT_UNAVAILABLE');
  });
});

describe('nonce status echo', () => {
  it('release is refused when the reader answers for a different query', async () => {
    const input = evidence(intent({ maxInputAmount: '60', nonce: '11' }));
    const h = harness([input], [mandate()]);
    const { grant } = await grantFor(h, input);
    h.clock.t = grant.validUntil;
    const snapshot = h.kernel.snapshot();
    const tamper: [
      string,
      (q: NonceStatusQuery) => Partial<NonceStatusQuery>,
    ][] = [
      ['chainId', () => ({ chainId: 10143 })],
      ['module', () => ({ module: `0x${'9'.repeat(40)}` })],
      ['account', () => ({ account: `0x${'8'.repeat(40)}` })],
      ['nonce', (q) => ({ nonce: String(BigInt(q.nonce) + 1n) })],
      ['intentHash', () => ({ intentHash: hash(0x99) })],
    ];
    for (const [, change] of tamper) {
      const kernel = Kernel.restore(
        snapshot,
        deps(h, {
          auditKey: AUDIT_KEY,
          nonceStatus: {
            status: async (q: NonceStatusQuery) => ({
              ...(await h.chain.status(q)),
              ...change(q),
            }),
          },
        }),
      );
      expect(await kernel.releaseExpired()).toBe(0);
      await expect(kernel.releaseUnexecuted(grant.grantId)).rejects.toThrow(
        'RECONCILIATION_INVALID',
      );
    }
    const honest = Kernel.restore(snapshot, deps(h, { auditKey: AUDIT_KEY }));
    expect(await honest.releaseExpired()).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import {
  onchainMandateId,
  type DirectVerification,
  type DirectVerifier,
} from '../../packages/kernel/src/index.js';
import {
  ACCOUNT,
  asset,
  authorizeWith,
  evidence,
  harness,
  intent,
  mandate,
  owners,
} from './fixtures.js';

const input = () => evidence(intent());
const ownerAddresses = owners.map(
  (o) => o.address.toLowerCase() as `0x${string}`,
);
function lagging(verifier?: DirectVerifier) {
  const data = input();
  const h = harness(data, [mandate()], {
    freshness: {
      probe: {
        observe: async () => ({
          chainId: 31337,
          indexedThroughBlock: 95,
          headBlock: 100,
          accountPaused: false,
          mandate: { active: true, version: 1, minValidVersion: 1 },
          owners: ownerAddresses,
          threshold: 2,
        }),
      },
      maxLagBlocks: 2,
      ...(verifier ? { verifier } : {}),
    },
  });
  return { h, data };
}
const direct = (patch: Partial<DirectVerification> = {}): DirectVerifier => ({
  verify: async () => ({
    chainId: 31337,
    account: ACCOUNT,
    blockNumber: 100,
    paused: false,
    mandate: {
      mandateId: onchainMandateId(mandate()),
      active: true,
      version: 1,
      minValidVersion: 1,
    },
    owners: ownerAddresses,
    threshold: 2,
    balances: [{ account: ACCOUNT, asset, balance: '10000' }],
    ...patch,
  }),
});

describe('SEC-006 FreshnessGate (B02.7)', () => {
  it('indexer lag beyond the profile threshold refuses without a direct verifier', async () => {
    const { h, data } = lagging();
    expect(await h.kernel.authorize({ ...data, approvals: [] })).toMatchObject({
      status: 'RISK_REJECTED',
      code: 'STALE_READ_MODEL',
    });
  });
  it('indexer lag with a successful direct verification proceeds and is audited as DIRECT', async () => {
    const { h, data } = lagging(direct());
    expect((await authorizeWith(h, data)).status).toBe('AUTHORIZED');
    expect(h.kernel.auditLog().at(-1)?.payload).toMatchObject({
      freshness: { mode: 'DIRECT', lagBlocks: 5 },
    });
  });
  it.each([
    [
      'verifier throws',
      {
        verify: async () => {
          throw new Error('rpc');
        },
      },
      'DIRECT_VERIFICATION_FAILED',
    ],
    [
      'verifier behind head',
      direct({ blockNumber: 99 }),
      'DIRECT_VERIFICATION_FAILED',
    ],
    [
      'verifier other account',
      direct({ account: `0x${'9'.repeat(40)}` }),
      'DIRECT_VERIFICATION_FAILED',
    ],
    [
      'verifier missing asset',
      direct({ balances: [] }),
      'DIRECT_VERIFICATION_FAILED',
    ],
    ['account paused on chain', direct({ paused: true }), 'ACCOUNT_PAUSED'],
    [
      'mandate revoked on chain',
      direct({
        mandate: {
          mandateId: onchainMandateId(mandate()),
          active: false,
          version: 1,
          minValidVersion: 1,
        },
      }),
      'MANDATE_REVOKED',
    ],
    [
      'mandate version differs on chain',
      direct({
        mandate: {
          mandateId: onchainMandateId(mandate()),
          active: true,
          version: 2,
          minValidVersion: 1,
        },
      }),
      'MANDATE_VERSION',
    ],
    [
      'lower verified balance',
      direct({ balances: [{ account: ACCOUNT, asset, balance: '59' }] }),
      'INSUFFICIENT_BALANCE',
    ],
  ] as const)('%s fails closed', async (_name, verifier, code) => {
    const { h, data } = lagging(verifier as DirectVerifier);
    expect(await h.kernel.authorize({ ...data, approvals: [] })).toMatchObject({
      code,
    });
  });
  it('a failing or inconsistent read-model probe fails closed', async () => {
    const data = input();
    const broken = harness(data);
    broken.probe.observe = async () => {
      throw new Error('db down');
    };
    expect(
      await broken.kernel.authorize({ ...data, approvals: [] }),
    ).toMatchObject({
      code: 'STALE_READ_MODEL',
    });
    const behind = harness(data);
    behind.probe.observation = { ...behind.probe.observation, headBlock: 50 };
    expect(
      await behind.kernel.authorize({ ...data, approvals: [] }),
    ).toMatchObject({
      code: 'STALE_READ_MODEL',
    });
    const paused = harness(data);
    paused.probe.observation = {
      ...paused.probe.observation,
      accountPaused: true,
    };
    expect(
      await paused.kernel.authorize({ ...data, approvals: [] }),
    ).toMatchObject({
      code: 'ACCOUNT_PAUSED',
    });
  });
});

describe('indexed mode refuses on chain account state exactly as direct mode', () => {
  type AccountPatch = {
    paused?: boolean;
    mandate?: { active: boolean; version: number; minValidVersion: number };
    owners?: `0x${string}`[];
    threshold?: number;
  };
  const indexed = (patch: AccountPatch) => {
    const data = input();
    const h = harness(data);
    const { paused, ...rest } = patch;
    h.probe.observation = {
      ...h.probe.observation,
      ...rest,
      ...(paused === undefined ? {} : { accountPaused: paused }),
    };
    return { h, data };
  };
  const directMode = ({ mandate: m, ...rest }: AccountPatch) =>
    lagging(
      direct({
        ...rest,
        ...(m
          ? { mandate: { mandateId: onchainMandateId(mandate()), ...m } }
          : {}),
      }),
    );
  const cases: [string, AccountPatch, string][] = [
    ['account paused', { paused: true }, 'ACCOUNT_PAUSED'],
    [
      'mandate revoked',
      { mandate: { active: false, version: 1, minValidVersion: 1 } },
      'MANDATE_REVOKED',
    ],
    [
      'mandate version below the minimum valid version',
      { mandate: { active: true, version: 1, minValidVersion: 2 } },
      'MANDATE_VERSION',
    ],
    [
      'mandate version differs from the Kernel version',
      { mandate: { active: true, version: 2, minValidVersion: 1 } },
      'MANDATE_VERSION',
    ],
    ['Safe threshold differs', { threshold: 3 }, 'ONCHAIN_QUORUM_REQUIRED'],
    [
      'approver signer is no longer a Safe owner',
      { owners: ownerAddresses.slice(1) },
      'APPROVER_NOT_MEMBER',
    ],
  ];
  const modes = [
    ['INDEXED', indexed],
    ['DIRECT', directMode],
  ] as const;
  for (const [mode, build] of modes)
    it.each(cases)(`${mode}: %s refuses`, async (_name, patch, code) => {
      const { h, data } = build(patch);
      expect(await authorizeWith(h, data, [0, 1])).toMatchObject({ code });
      expect(h.kernel.auditLog().at(-1)?.payload).toMatchObject({ code });
    });
  for (const [mode, build] of modes)
    it(`${mode}: approvals from current owners authorize after an owner change`, async () => {
      const { h, data } = build({ owners: ownerAddresses.slice(1) });
      expect(await authorizeWith(h, data, [1, 2])).toMatchObject({
        status: 'AUTHORIZED',
      });
    });
});

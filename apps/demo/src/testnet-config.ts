import pg from 'pg';
import type { Address, Hex } from 'viem';
import {
  MandateSchema,
  type ExecutionGrant,
  type Mandate,
} from '@synq/schemas';
import type { AuthorizationDecision } from '@synq/kernel';
import { monadTestnetProfile } from '@synq/chain-registry';
import { ApiCallError } from './testnet-api.js';
import type { DraftOutcome } from './vertical.js';

export const PROFILE = monadTestnetProfile;
export const CHAIN_ID = PROFILE.network.chainId;
export const RP = {
  rpId: 'localhost',
  rpName: 'Synq testnet e2e',
  origin: 'http://localhost',
};
export const LABELS = ['alice', 'bob', 'carol'] as const;
export const MANDATE_ID = 'testnet_transfer';
export const PLUGIN_ID = 'ausd-transfer';
export const WORKER_ID = 'testnet-execution-worker';
export const MAX_MON_SPEND = 1_500_000_000_000_000_000n;
export const UNITS = {
  funding: 25_000_000n,
  transfer: 1_500_000n,
  perActionCap: 5_000_000n,
  cumulativeBudget: 20_000_000n,
  probe: 1_000_000n,
};

export type TestnetE2EOptions = {
  databaseUrl?: string;
  evidenceDirectory?: string;
  workDirectory?: string;
  authenticatorStore?: string;
};

export function databaseUrl(options: TestnetE2EOptions): string {
  return (
    options.databaseUrl ??
    process.env.SYNQ_E2E_TESTNET_DATABASE_URL ??
    'postgresql://postgres:synq_local@127.0.0.1:55432/synq_e2e_testnet'
  );
}

export async function ensureDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*e2e[a-z0-9_]*$/.test(name))
    throw new Error('E2E_DATABASE_NAME_MUST_CONTAIN_E2E');
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [name],
    );
    if (!exists.rows.length) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

export function testnetMandate(input: {
  chainGroupId: Hex;
  account: Address;
  executor: Address;
  recipient: Address;
  asset: Mandate['inputAsset'];
  members: { memberId: string; signer: Address }[];
  now: number;
}): Mandate {
  return MandateSchema.parse({
    schemaVersion: 2,
    mandateId: MANDATE_ID,
    groupId: input.chainGroupId,
    version: 1,
    status: 'ACTIVE',
    network: PROFILE.network,
    account: input.account,
    chainGroupId: input.chainGroupId,
    operators: [input.executor],
    bindings: [
      {
        pluginId: PLUGIN_ID,
        action: 'TRANSFER',
        target: input.asset.address,
        selector: '0xa9059cbb',
      },
    ],
    recipients: [{ address: input.recipient, purpose: 'COUNTERPARTY' }],
    inputAsset: input.asset,
    outputAssets: [],
    perActionCap: String(UNITS.perActionCap),
    cumulativeBudget: String(UNITS.cumulativeBudget),
    maxNativeValue: '0',
    cumulativeNativeBudget: '0',
    maxSlippageBps: 0,
    maxReferenceDeviationBps: 0,
    maxLeverageBps: 0,
    maxAllocationBps: 10_000,
    tierPolicy: {
      tokenSpend: { autoMax: '0', reviewMax: '0' },
      nativeSpend: { autoMax: '0', reviewMax: '0' },
      actionFloors: [],
      newOutputAsset: 'CONSENSUS',
      leverage: 'BLOCKED',
      withdrawal: 'UNANIMOUS',
    },
    approvalPolicy: {
      quorum: 2,
      reviewApprovals: 1,
      accountThreshold: 2,
      eligibleKinds: ['MERA_HUMAN'],
    },
    delegationScope: null,
    members: input.members.map((m) => ({ ...m, active: true })),
    validAfter: input.now - 60,
    validUntil: input.now + 7 * 86_400,
    quoteTtlSeconds: 300,
    evidenceTtlSeconds: 300,
    simulationTtlSeconds: 300,
    maxGrantTtlSeconds: 300,
    minIntervalSeconds: 0,
    maxExecutions: 10,
  });
}

export function errorCode(error: unknown): string {
  if (error instanceof ApiCallError)
    return error.rejectionCode ?? error.message;
  return (error as { code?: string }).code ?? String(error);
}

export function grantOf(
  d: AuthorizationDecision | DraftOutcome,
): ExecutionGrant {
  if (d.status !== 'AUTHORIZED')
    throw new Error(`EXPECTED_GRANT:${d.status}:${'code' in d ? d.code : ''}`);
  return d.grant;
}

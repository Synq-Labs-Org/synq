import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import {
  ExecutionJournal,
  JournaledBroadcaster,
  type JournalEntry,
} from '@synq/execution-worker/journal';
import { FLOW_SWAP_SELECTOR } from '@synq/plugin-kuru';
import {
  ROUTER,
  evidence,
  grantFor,
  harness,
  mandate,
  outputAsset,
  quote,
  swapIntent,
  transferBinding,
  ACCOUNT as SAFE,
  RECIPIENT,
} from '../kernel/fixtures.js';
import { ACCOUNT, AUSD, T0, WMON, recordedFlow } from './fixtures.js';

async function kuruSwapIntent(nonce = '1') {
  const { adapter } = recordedFlow();
  const q = await adapter.quote(
    {
      profile: 'proof/monad-mainnet',
      account: ACCOUNT,
      tokenIn: AUSD.address,
      tokenOut: WMON.address,
      amountIn: 1_000_000n,
      slippageBps: 50,
    },
    T0,
  );
  const prepared = adapter.prepare(q, {
    maxSlippageBps: 75,
    maxInputAmount: 1_000_000n,
    now: T0,
  });
  return {
    prepared,
    input: evidence(
      swapIntent({
        nonce,
        intentId: `kuru_${nonce}`,
        selector: FLOW_SWAP_SELECTOR,
        calldataHash: prepared.calldataHash,
        maxInputAmount: '10',
      }),
      quote,
    ),
  };
}
const kuruMandate = () =>
  mandate({
    bindings: [
      transferBinding,
      {
        pluginId: 'local-swap',
        action: 'SPOT_TRADE',
        target: ROUTER,
        selector: FLOW_SWAP_SELECTOR,
      },
    ],
    recipients: [
      { address: RECIPIENT, purpose: 'COUNTERPARTY' },
      { address: SAFE, purpose: 'SELF' },
    ],
    outputAssets: [outputAsset],
  });

describe('Kuru swap intents through the Kernel and the execution journal', () => {
  it('nonce replay: an authorized Kuru swap intent cannot be authorized again', async () => {
    const { input, prepared } = await kuruSwapIntent();
    const h = harness(input, [kuruMandate()]);
    const decision = await grantFor(h, input);
    expect(decision.grant).toMatchObject({
      selector: FLOW_SWAP_SELECTOR,
      calldataHash: prepared.calldataHash,
    });
    expect(await h.kernel.authorize({ ...input, approvals: [] })).toMatchObject(
      { code: 'NONCE_REPLAY' },
    );
  });

  it('duplicate submission and failed-submit reconciliation are handled by the journal, never a blind resend', async () => {
    const { input } = await kuruSwapIntent('2');
    const h = harness(input, [kuruMandate()]);
    const { grant } = await grantFor(h, input);
    const raw = `0x02${grant.calldataHash.slice(2)}` as Hex;
    const entry: JournalEntry = {
      schemaVersion: 1,
      grantId: grant.grantId,
      transactionHash: keccak256(raw),
      rawTransaction: raw,
      state: 'SIGNED',
      chainId: 31337,
      blockNumber: null,
    };
    const dir = mkdtempSync(join(tmpdir(), 'synq-kuru-journal-'));
    let sends = 0;
    let receipt: {
      status: 'success' | 'reverted';
      blockNumber: bigint;
    } | null = null;
    const port = {
      sendRawTransaction: async () => {
        sends++;
        throw new Error('connection reset after submit');
      },
      receipt: async () => receipt,
    };
    try {
      const worker = new JournaledBroadcaster(new ExecutionJournal(dir), port);
      expect((await worker.submit(entry)).state).toBe(
        'RECONCILIATION_REQUIRED',
      );
      expect((await worker.submit(entry)).state).toBe(
        'RECONCILIATION_REQUIRED',
      );
      expect(sends).toBe(1);
      await expect(
        worker.submit({
          ...entry,
          rawTransaction: '0x03',
          transactionHash: keccak256('0x03'),
        }),
      ).rejects.toThrow('GRANT_REPREPARATION_FORBIDDEN');
      receipt = { status: 'reverted', blockNumber: 12n };
      const reconciled = await worker.reconcile(grant.grantId);
      expect(reconciled).toMatchObject({ outcome: 'REVERTED' });
      expect(sends).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

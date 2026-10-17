import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { privateKeyToAccount } from 'viem/accounts';
import { erc20Abi, getAddress, parseEventLogs, type Hex } from 'viem';
import { connectChain } from '@synq/execution-worker/arc';
import { readWorkspaceAuthority } from '@synq/execution-worker/workspace-authority';
import { WorkspacePayoutExecutor } from '@synq/execution-worker/workspace-payout';
import { WorkspaceFinance } from '@synq/workspaces/finance';
import { WorkspacePayouts } from '@synq/workspaces/payouts';
import {
  financeChangeTypedData,
  payoutIntent,
  payoutMandate,
} from '@synq/workspaces/finance-contracts';
import {
  PostgresWorkspaceStore,
  WorkspaceVaultSetups,
  loginTypedData,
} from '@synq/workspaces';
import {
  intentApprovalTypedData,
  mandateTypedData,
} from '@synq/kernel/arc-payment-data';
import { VaultSetupSchema } from '@synq/kernel/arc-vault-setup';
import { OfacSdnScreening } from '@synq/plugin-risk';
import { PostgresSdnSnapshotStore } from '@synq/plugin-risk/postgres';
import { CardBannerRenderer } from '@synq/channels/cards';
import { payoutReceiptCard } from '../apps/demo/src/workspace-notifications.js';

/**
 * LIVE_ARC_TESTNET proof: one owner-quorum payout from the fresh 2-of-2
 * workspace vault to its verified, allowlisted vendor, screened against the
 * OFAC SDN list (list-only). Bounded to 0.005 USDC. Keys stay in mode-600
 * files under ~/.synq and are never printed.
 */
if (process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
  throw new Error('MAINNET_FORBIDDEN');
const AMOUNT = 5000n; // 0.005 USDC
const runId = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/)
  .parse(process.env.SYNQ_DYNAMIC_RUN_ID);
if (process.env.SYNQ_DYNAMIC_PAYOUT_LIVE !== '1') {
  process.stdout.write(
    'Read-only mode: no signatures or transactions. Set SYNQ_DYNAMIC_PAYOUT_LIVE=1 for the authorized Arc testnet payout proof.\n',
  );
} else {
  const dir = join(homedir(), '.synq');
  const secret = (path: string) => {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error('KEY_FILE_PERMISSIONS');
    return readFileSync(path, 'utf8').trim();
  };
  const actor = (label: string) => {
    const text = secret(join(dir, `e2e-user-${runId}-${label}.key`));
    return privateKeyToAccount(
      (text.startsWith('0x') ? text : `0x${text}`) as Hex,
    );
  };
  const owner = actor('owner'),
    coowner = actor('coowner'),
    operator = actor('operator'),
    vendor = actor('vendor');
  const workspaceId = z
    .string()
    .uuid()
    .parse(
      (
        JSON.parse(secret(join(dir, `e2e-user-${runId}-run.json`))) as {
          workspaceId: unknown;
        }
      ).workspaceId,
    );
  const vendorId = z
    .string()
    .uuid()
    .parse(
      (
        JSON.parse(secret(join(dir, `e2e-user-${runId}-finance.json`))) as {
          vendorId: unknown;
        }
      ).vendorId,
    );
  const path = join(dir, `e2e-user-${runId}-payout.json`);
  type Manifest = {
    budgetHash: Hex | null;
    payoutId: string | null;
    idempotencyKey: string;
    obligation: string;
    operatorBefore: string | null;
    vendorBefore: string | null;
    vaultBefore: string | null;
  };
  const manifest: Manifest = existsSync(path)
    ? (JSON.parse(secret(path)) as Manifest)
    : {
        budgetHash: null,
        payoutId: null,
        idempotencyKey: randomUUID(),
        obligation: `dynamic-${runId}-supply-1`,
        operatorBefore: null,
        vendorBefore: null,
        vaultBefore: null,
      };
  const save = () =>
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
  save();
  mkdirSync(join('bounty-evidence', 'arc'), { recursive: true });
  const evidencePath = join(
    'bounty-evidence',
    'arc',
    `dynamic-payout-${runId}.json`,
  );
  const evidence: Record<string, unknown> = existsSync(evidencePath)
    ? (JSON.parse(readFileSync(evidencePath, 'utf8')) as Record<
        string,
        unknown
      >)
    : {};
  const persist = () =>
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  const url =
    process.env.SYNQ_DYNAMIC_DATABASE_URL ??
    'postgresql://postgres@127.0.0.1:55433/synq_m2_dynamic';
  if (!/^synq_m2_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1)))
    throw new Error('TEST_DATABASE_REQUIRED');
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  try {
    const chain = await connectChain('arc-testnet'),
      store = new PostgresWorkspaceStore(pool, 'https://synq.test');
    await store.migrate();
    const setup = VaultSetupSchema.parse(
      (
        await pool.query(
          'SELECT data FROM synq_ws_vault_setups WHERE workspace_id=$1',
          [workspaceId],
        )
      ).rows[0]?.data,
    );
    const setups = new WorkspaceVaultSetups(store, setup);
    const finance = new WorkspaceFinance(store, (id) =>
      readWorkspaceAuthority(chain, setups, id),
    );
    await finance.migrate();
    const a = await finance.authority(workspaceId);
    if (
      a.threshold !== 2 ||
      !a.owners.includes(owner.address) ||
      !a.owners.includes(coowner.address)
    )
      throw new Error('EXPECTED_FRESH_TWO_OWNER_VAULT');
    const usdc = (address: Hex) =>
      chain.client.readContract({
        address: a.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      });
    if (!manifest.operatorBefore) {
      manifest.operatorBefore = String(
        await chain.client.getBalance({ address: operator.address }),
      );
      manifest.vendorBefore = String(await usdc(vendor.address));
      manifest.vaultBefore = String(await usdc(a.vault));
      save();
    }
    const login = async (who: typeof owner) => {
      const c = await store.challenge({
        wallet: who.address,
        audience: 'native',
      });
      return store.login(
        c.id,
        await who.signTypedData({
          ...loginTypedData(c),
          message: {
            ...loginTypedData(c).message,
            wallet: who.address,
            expiresAt: BigInt(c.expiresAt),
          },
        }),
      );
    };
    const [p0, p1] = await Promise.all([login(owner), login(coowner)]);
    // Budget: both owners sign; the payout binds this exact revision.
    if (!manifest.budgetHash) {
      const c = await finance.propose(workspaceId, p0!.principalId, {
        kind: 'BUDGET',
        perPayment: '5000',
        daily: '10000',
        reserve: '2000',
        aiDaily: '0',
      });
      manifest.budgetHash = c.hash;
      save();
    }
    const change = await finance.change(
      workspaceId,
      p0!.principalId,
      manifest.budgetHash,
    );
    if (change.state !== 'APPLIED')
      for (const [i, who] of [owner, coowner].entries())
        await finance.approve(
          workspaceId,
          [p0, p1][i]!.principalId,
          manifest.budgetHash,
          await who.signTypedData(financeChangeTypedData(change.change)),
        );
    const payouts = new WorkspacePayouts(finance);
    if (!manifest.payoutId) {
      const p = await payouts.propose(workspaceId, p0!.principalId, {
        vendorId,
        amount: String(AMOUNT),
        purpose: 'Accepted delivery of supplies',
        obligation: manifest.obligation,
        idempotencyKey: manifest.idempotencyKey,
      });
      manifest.payoutId = p.data.id;
      save();
    }
    const payoutId = manifest.payoutId;
    let record = await payouts.record(payoutId);
    if (!record) throw new Error('PAYOUT_MISSING');
    if (record.state === 'REVIEW') {
      for (const [i, who] of [owner, coowner].entries()) {
        if (record.signatures[who.address.toLowerCase()]) continue;
        await payouts.approve(workspaceId, [p0, p1][i]!.principalId, payoutId, {
          signature: await who.signTypedData(
            intentApprovalTypedData(
              payoutIntent(record.data),
              record.data.approval,
            ),
          ),
          ...(i === 0
            ? {
                mandateSignature: await who.signTypedData(
                  mandateTypedData(payoutMandate(record.data)),
                ),
              }
            : {}),
        });
      }
      record = (await payouts.record(payoutId))!;
    }
    const sdn = new OfacSdnScreening(
      new PostgresSdnSnapshotStore(pool),
      store.now,
    );
    await new PostgresSdnSnapshotStore(pool).migrate();
    await sdn.load();
    const refreshed = await sdn.refresh();
    if (sdn.status().status !== 'AVAILABLE')
      throw new Error('SCREENING_UNAVAILABLE');
    const snapshot = sdn.snapshot()!;
    const executor = new WorkspacePayoutExecutor(
      finance,
      chain,
      operator,
      {
        operator: 'dynamic-payout-proof',
        grantKey: Buffer.from(
          secret(join(dir, `e2e-user-${runId}-grant.key`)),
          'hex',
        ),
        grantTtlSeconds: 60,
        riskRequiredAbove: 0n,
      },
      sdn,
    );
    await executor.migrate();
    const result = await executor.execute(payoutId);
    if (!('record' in result) || result.record.state !== 'CONFIRMED')
      throw new Error(
        'state' in result && result.state === 'HOLD'
          ? `PAYOUT_HELD_${String(result.reason)}`
          : 'PAYOUT_NOT_CONFIRMED',
      );
    const hash = result.record.hash as Hex;
    const receipt = await chain.client.getTransactionReceipt({ hash });
    const transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: 'Transfer',
      logs: receipt.logs,
    }).filter(
      (l) =>
        l.address.toLowerCase() === a.token.toLowerCase() &&
        getAddress(l.args.from) === a.vault &&
        getAddress(l.args.to) === vendor.address,
    );
    if (transfers.length !== 1 || transfers[0]!.args.value !== AMOUNT)
      throw new Error('TRANSFER_MISMATCH');
    const [vendorAfter, vaultAfter, operatorAfter] = await Promise.all([
      usdc(vendor.address),
      usdc(a.vault),
      chain.client.getBalance({ address: operator.address }),
    ]);
    const gas = receipt.gasUsed * receipt.effectiveGasPrice;
    const vendorDiff = vendorAfter - BigInt(manifest.vendorBefore!) - AMOUNT,
      vaultDiff = BigInt(manifest.vaultBefore!) - vaultAfter - AMOUNT,
      gasDiff = BigInt(manifest.operatorBefore!) - operatorAfter - gas;
    if (vendorDiff !== 0n || vaultDiff !== 0n || gasDiff !== 0n)
      throw new Error('RECONCILIATION_MISMATCH');
    const paid = (await payouts.record(payoutId))!;
    if (paid.state !== 'PAID' || paid.txHash !== hash)
      throw new Error('PAYOUT_NOT_BOOKED');
    const card = payoutReceiptCard(paid, {
      displayName: (await store.get(workspaceId, p0!.principalId)).workspace
        .displayName,
      threshold: a.threshold,
      executedAt: store.now(),
      mode: 'LIVE_ARC_TESTNET',
    });
    const pngPath = join(
      'bounty-evidence',
      'arc',
      `dynamic-payout-${runId}-receipt.png`,
    );
    writeFileSync(pngPath, await new CardBannerRenderer().render(card));
    Object.assign(evidence, {
      runId,
      workspaceId,
      mode: 'LIVE_ARC_TESTNET',
      status: 'PASS_SCREENED_OWNER_QUORUM_PAYOUT',
      onboardingActors: 'LOCAL_FIXTURE_SOFTWARE_WALLETS',
      independentHumanUsers: 0,
      vault: a.vault,
      policy: a.policy,
      vendorId,
      vendorAddress: vendor.address,
      amountBaseUnits: String(AMOUNT),
      payoutId,
      budgetChangeHash: manifest.budgetHash,
      approvals: Object.keys(paid.signatures).length,
      threshold: a.threshold,
      txHash: hash,
      blockNumber: String(receipt.blockNumber),
      screening: {
        provider: 'OFAC_SDN_LIST_ONLY',
        scope:
          'US Treasury SDN list only; not full wallet screening (no KYT or chain analytics)',
        snapshotSha256: snapshot.sha256,
        publishedOn: snapshot.publishedOn,
        evmAddresses: snapshot.addresses.length,
        refresh: refreshed.ok ? 'DOWNLOADED' : 'PERSISTED_SNAPSHOT',
        verdict: 'CLEAR',
      },
      reconciliation: {
        vendorDifferenceBaseUnits: String(vendorDiff),
        vaultDifferenceBaseUnits: String(vaultDiff),
        operatorGasDifferenceWei: String(gasDiff),
        gasNativeWei: String(gas),
      },
      receiptCard: {
        rendered: pngPath,
        delivered: 'NOT_RUN: no verified chat destination in this run',
      },
    });
    persist();
    process.stdout.write(
      `LIVE_ARC_TESTNET ${evidencePath}; payout ${hash}; reconciliation 0\n`,
    );
  } catch (error) {
    evidence.lastAttempt = {
      status: 'BLOCKED',
      code:
        error instanceof Error && /^[A-Z_0-9]{1,100}$/.test(error.message)
          ? error.message
          : 'EXECUTION_UNAVAILABLE',
    };
    persist();
    process.stderr.write(`BLOCKED ${evidencePath}; see bounded code.\n`);
    if (process.env.SYNQ_DYNAMIC_DEBUG === '1') console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

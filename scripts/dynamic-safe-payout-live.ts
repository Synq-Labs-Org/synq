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
import { WorkspaceGovernanceExecutor } from '@synq/execution-worker/workspace-governance';
import { WorkspaceGovernance } from '@synq/workspaces/governance';
import { WorkspaceFinance } from '@synq/workspaces/finance';
import { WorkspacePayouts } from '@synq/workspaces/payouts';
import { financeChangeTypedData } from '@synq/workspaces/finance-contracts';
import {
  PostgresWorkspaceStore,
  WorkspaceVaultSetups,
  loginTypedData,
} from '@synq/workspaces';
import {
  safeActionApprovalTypedData,
  safeActionTypedData,
} from '@synq/kernel/arc-safe-action';
import { VaultSetupSchema } from '@synq/kernel/arc-vault-setup';
import { OfacSdnScreening } from '@synq/plugin-risk';
import { PostgresSdnSnapshotStore } from '@synq/plugin-risk/postgres';
import { CardBannerRenderer } from '@synq/channels/cards';
import { payoutReceiptCard } from '../apps/demo/src/workspace-notifications.js';

/**
 * LIVE_ARC_TESTNET proof: an above-budget payout (0.008 USDC, budget 0.005)
 * that the operator cannot pay. Both Safe owners sign one direct USDC
 * transfer; the Kernel admits it after OFAC SDN (list-only) screening and the
 * reserve check, and the payout is booked once. Keys stay in mode-600 files
 * under ~/.synq and are never printed.
 */
if (process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
  throw new Error('MAINNET_FORBIDDEN');
const AMOUNT = 8000n; // 0.008 USDC, above the signed 0.005 per-payment budget
const runId = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/)
  .parse(process.env.SYNQ_DYNAMIC_RUN_ID);
if (process.env.SYNQ_DYNAMIC_SAFE_PAYOUT_LIVE !== '1') {
  process.stdout.write(
    'Read-only mode: no signatures or transactions. Set SYNQ_DYNAMIC_SAFE_PAYOUT_LIVE=1 for the authorized Arc testnet Safe-quorum payout proof.\n',
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
  const path = join(dir, `e2e-user-${runId}-safe-payout.json`);
  type Manifest = {
    budgetHash: Hex | null;
    payoutId: string | null;
    actionId: string | null;
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
        actionId: null,
        idempotencyKey: randomUUID(),
        obligation: `dynamic-${runId}-supply-quarterly`,
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
    `dynamic-safe-payout-${runId}.json`,
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
    // The signed budget from the operator payout proof stays in force (0.005 per payment, 0.002 reserve).
    const budget = (
      await pool.query(
        'SELECT data,change_hash FROM synq_ws_budgets WHERE workspace_id=$1',
        [workspaceId],
      )
    ).rows[0];
    if (!budget || BigInt(budget.data.perPayment) >= AMOUNT)
      throw new Error('ABOVE_BUDGET_SETUP_MISSING');
    manifest.budgetHash = budget.change_hash;
    save();
    void financeChangeTypedData;
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
    const created = await payouts.record(payoutId);
    if (!created || created.data.route !== 'SAFE_QUORUM')
      throw new Error('EXPECTED_SAFE_QUORUM_ROUTE');
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
    const governance = new WorkspaceGovernance(finance);
    let action = manifest.actionId
      ? await governance.record(manifest.actionId)
      : null;
    if (
      !action ||
      (action.state === 'REVIEW' && action.action.expiresAt <= store.now() + 60)
    ) {
      const proposed = await governance.propose(workspaceId, p0!.principalId, {
        kind: 'PAY_VENDOR',
        payoutId,
      });
      manifest.actionId = proposed.action.id;
      save();
      action = (await governance.record(proposed.action.id))!;
    }
    const actionId = manifest.actionId!;
    if (action.state === 'REVIEW')
      for (const [i, who] of [owner, coowner].entries())
        await governance.approve(
          workspaceId,
          [p0, p1][i]!.principalId,
          actionId,
          {
            approvalSignature: await who.signTypedData(
              safeActionApprovalTypedData(action.action),
            ),
            safeSignature: await who.signTypedData(
              safeActionTypedData(action.action),
            ),
          },
        );
    const executor = new WorkspaceGovernanceExecutor(
      finance,
      chain,
      operator,
      {
        operator: 'dynamic-safe-payout-proof',
        grantKey: Buffer.from(
          secret(join(dir, `e2e-user-${runId}-grant.key`)),
          'hex',
        ),
        grantTtlSeconds: 60,
        riskRequiredAbove: 0n,
      },
      sdn,
    );
    await executor.outbox.migrate();
    const result = await executor.execute(actionId);
    if (result.state !== 'CONFIRMED')
      throw new Error(
        `SAFE_PAYOUT_${String('reason' in result ? result.reason : result.state)}`,
      );
    const outboxRecord = await executor.outbox.get(
      `workspace-action:${actionId}`,
    );
    if (!outboxRecord) throw new Error('OUTBOX_MISSING');
    const record = outboxRecord;
    const hash = record.hash as Hex;
    const receipt = await chain.client.getTransactionReceipt({ hash });
    const transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: 'Transfer',
      logs: receipt.logs,
    }).filter(
      (l) =>
        l.address.toLowerCase() === a.token.toLowerCase() &&
        getAddress(l.args.from) === getAddress(a.vault) &&
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
      approvalsCounted: (await governance.record(actionId))!.signatures.length,
    });
    const pngPath = join(
      'bounty-evidence',
      'arc',
      `dynamic-safe-payout-${runId}-receipt.png`,
    );
    writeFileSync(pngPath, await new CardBannerRenderer().render(card));
    Object.assign(evidence, {
      runId,
      workspaceId,
      mode: 'LIVE_ARC_TESTNET',
      status: 'PASS_ABOVE_BUDGET_SAFE_QUORUM_PAYOUT',
      route: 'SAFE_QUORUM direct USDC transfer (operator caps not used)',
      governanceActionId: actionId,
      onboardingActors: 'LOCAL_FIXTURE_SOFTWARE_WALLETS',
      independentHumanUsers: 0,
      vault: a.vault,
      policy: a.policy,
      vendorId,
      vendorAddress: vendor.address,
      amountBaseUnits: String(AMOUNT),
      payoutId,
      budgetChangeHash: manifest.budgetHash,
      approvals: (await governance.record(actionId))!.signatures.length,
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

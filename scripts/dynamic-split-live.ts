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
import { WorkspaceSplitWorker } from '@synq/execution-worker/workspace-splits';
import { WorkspaceFinance } from '@synq/workspaces/finance';
import { WorkspaceBooks } from '@synq/workspaces/books';
import { WorkspaceRevenue } from '@synq/workspaces/revenue';
import { RevenuePolicyWireSchema } from '@synq/workspaces/revenue-contracts';
import { financeChangeTypedData } from '@synq/workspaces/finance-contracts';
import {
  PostgresWorkspaceStore,
  WorkspaceVaultSetups,
  loginTypedData,
} from '@synq/workspaces';
import { mandateTypedData } from '@synq/kernel/arc-payment-data';
import { VaultSetupSchema } from '@synq/kernel/arc-vault-setup';
import {
  mandateFromPolicy,
  policyTypedData,
} from '@synq/allocations/policy-data';
import { OfacSdnScreening } from '@synq/plugin-risk';
import { PostgresSdnSnapshotStore } from '@synq/plugin-risk/postgres';

/**
 * LIVE_ARC_TESTNET proof of an automatic split. SETUP: both Safe owners sign a
 * budget with an autonomous allowance, a revenue policy, an accepted milestone
 * and a vendor bill. A fresh invoice is then paid by the outside payer
 * (dynamic-invoice-live, sequence 3). RUN: the split worker pays the bill and
 * distributes the surplus from the finalized receipt, OFAC SDN (list-only)
 * screened, through the vault policy. Keys stay in mode-600 files.
 */
if (process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
  throw new Error('MAINNET_FORBIDDEN');
const runId = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/)
  .parse(process.env.SYNQ_DYNAMIC_RUN_ID);
const phase = z
  .enum(['SETUP', 'RUN'])
  .parse(process.env.SYNQ_DYNAMIC_SPLIT_PHASE ?? 'SETUP');
const BILL = 3000n;
if (process.env.SYNQ_DYNAMIC_SPLIT_LIVE !== '1') {
  process.stdout.write(
    'Read-only mode: no signatures or transactions. Set SYNQ_DYNAMIC_SPLIT_LIVE=1 for the authorized Arc testnet split proof.\n',
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
    .uuid()
    .parse(
      JSON.parse(secret(join(dir, `e2e-user-${runId}-run.json`))).workspaceId,
    );
  const vendorId = z
    .uuid()
    .parse(
      JSON.parse(secret(join(dir, `e2e-user-${runId}-finance.json`))).vendorId,
    );
  const path = join(dir, `e2e-user-${runId}-split.json`);
  type Manifest = {
    budgetHash: Hex | null;
    policyId: string | null;
    obligationHash: Hex | null;
    payableId: string;
    payableHash: Hex | null;
    vendorBefore: string | null;
    vaultBefore: string | null;
  };
  const manifest: Manifest = existsSync(path)
    ? (JSON.parse(secret(path)) as Manifest)
    : {
        budgetHash: null,
        policyId: null,
        obligationHash: null,
        payableId: randomUUID(),
        payableHash: null,
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
    `dynamic-split-${runId}.json`,
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
    const signers = [
      [owner, p0!],
      [coowner, p1!],
    ] as const;
    const quorum = async (hash: Hex) => {
      const c = await finance.change(workspaceId, p0!.principalId, hash);
      if (c.state === 'APPLIED') return;
      for (const [who, p] of signers)
        await finance.approve(
          workspaceId,
          p.principalId,
          hash,
          await who.signTypedData(financeChangeTypedData(c.change)),
        );
    };
    const usdc = (address: Hex) =>
      chain.client.readContract({
        address: a.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      });
    if (phase === 'SETUP') {
      if (!manifest.budgetHash) {
        manifest.budgetHash = (
          await finance.propose(workspaceId, p0!.principalId, {
            kind: 'BUDGET',
            perPayment: '5000',
            daily: '10000',
            reserve: '2000',
            aiDaily: '5000',
          })
        ).hash as Hex;
        save();
      }
      await quorum(manifest.budgetHash);
      if (!manifest.obligationHash) {
        manifest.obligationHash = (
          await finance.propose(workspaceId, p0!.principalId, {
            kind: 'OBLIGATION',
            reference: `PO-${runId}`,
            vendorId,
            approvedAmount: String(BILL),
            status: 'ACCEPTED',
          })
        ).hash as Hex;
        save();
      }
      await quorum(manifest.obligationHash);
      if (!manifest.payableHash) {
        const today = new Date(store.now() * 1000).toISOString().slice(0, 10);
        manifest.payableHash = (
          await finance.propose(workspaceId, p0!.principalId, {
            kind: 'PAYABLE',
            payableId: manifest.payableId,
            vendorId,
            number: `BILL-${runId}`,
            amount: String(BILL),
            issuedOn: today,
            dueOn: today,
            reference: `PO-${runId}`,
            documentText: `Supplier bill BILL-${runId} for accepted milestone PO-${runId}`,
          })
        ).hash as Hex;
        save();
      }
      await quorum(manifest.payableHash);
      const revenue = new WorkspaceRevenue(finance);
      if (!manifest.policyId) {
        manifest.policyId = (
          await revenue.propose(workspaceId, p0!.principalId, {
            taxReserveBps: 0,
            operatingFloor: '2000',
            obligationHorizonDays: 7,
            vendorIds: [vendorId],
            distributions: [
              {
                kind: 'PERCENT_OF_SURPLUS',
                label: 'Supplier share',
                beneficiaryId: vendorId,
                bps: 10000,
              },
            ],
            validForSeconds: 86400,
            limits: {
              maxAutonomousPerLeg: '5000',
              maxAutonomousPerWindow: '5000',
              windowSeconds: 86400,
              maxSplitsPerWindow: 3,
            },
          })
        ).id;
        save();
      }
      const draft = (
        await pool.query(
          'SELECT data,state FROM synq_ws_revenue_policies WHERE id=$1',
          [manifest.policyId],
        )
      ).rows[0]!;
      if (draft.state === 'REVIEW') {
        const policy = RevenuePolicyWireSchema.parse(draft.data);
        for (const [who, p] of signers)
          await revenue.approve(workspaceId, p.principalId, manifest.policyId, {
            policy: await who.signTypedData(policyTypedData(policy)),
            mandate: await who.signTypedData(
              mandateTypedData(mandateFromPolicy(policy)),
            ),
          });
      }
      if (!(await revenue.active(workspaceId)))
        throw new Error('REVENUE_POLICY_NOT_ACTIVE');
      manifest.vendorBefore = String(await usdc(vendor.address));
      manifest.vaultBefore = String(await usdc(a.vault));
      save();
      Object.assign(evidence, {
        runId,
        workspaceId,
        mode: 'LIVE_ARC_TESTNET',
        setup: 'BUDGET_POLICY_MILESTONE_BILL_SIGNED_BY_BOTH_OWNERS',
        payableId: manifest.payableId,
        policyId: manifest.policyId,
      });
      persist();
      process.stdout.write(
        `SETUP done; pay invoice sequence 3 next, then run SYNQ_DYNAMIC_SPLIT_PHASE=RUN\n`,
      );
    } else {
      const sdn = new OfacSdnScreening(
        new PostgresSdnSnapshotStore(pool),
        store.now,
      );
      await sdn.load();
      await sdn.refresh();
      if (sdn.status().status !== 'AVAILABLE')
        throw new Error('SCREENING_UNAVAILABLE');
      const books = new WorkspaceBooks(finance);
      const worker = new WorkspaceSplitWorker(
        finance,
        chain,
        operator,
        {
          operator: 'dynamic-split-proof',
          grantKey: Buffer.from(
            secret(join(dir, `e2e-user-${runId}-grant.key`)),
            'hex',
          ),
          grantTtlSeconds: 60,
          riskRequiredAbove: 0n,
        },
        sdn,
        (id) => books.reader(id),
      );
      await worker.migrate();
      const receipt = (
        await pool.query(
          'SELECT key FROM synq_ws_receipts WHERE workspace_id=$1 AND invoice_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
          [workspaceId],
        )
      ).rows[0];
      if (!receipt) throw new Error('RECEIPT_MISSING');
      let split = await worker.store.byReceipt(String(receipt.key));
      for (let i = 0; i < 40 && split?.state !== 'COMPLETED'; i++) {
        await worker.pump();
        split = await worker.store.byReceipt(String(receipt.key));
        if (split?.state === 'NEEDS_REVIEW') break;
        if (split?.state !== 'COMPLETED')
          await new Promise((r) => setTimeout(r, 3000));
      }
      if (!split || split.state !== 'COMPLETED')
        throw new Error(`SPLIT_${split?.state ?? 'NOT_STARTED'}`);
      const legs = await worker.store.legs(split.splitId);
      const paid: { purpose: string; amount: string; txHash: Hex }[] = [];
      for (const l of legs) {
        if (l.kind !== 'TRANSFER' || !l.evidence) continue;
        const r = await chain.client.getTransactionReceipt({
          hash: l.evidence.txHash,
        });
        const t = parseEventLogs({
          abi: erc20Abi,
          eventName: 'Transfer',
          logs: r.logs,
        }).filter(
          (e) =>
            e.address.toLowerCase() === a.token.toLowerCase() &&
            getAddress(e.args.from) === getAddress(a.vault) &&
            getAddress(e.args.to) === getAddress(vendor.address) &&
            e.args.value === l.amount,
        );
        if (t.length !== 1) throw new Error('TRANSFER_MISMATCH');
        paid.push({
          purpose: l.purpose,
          amount: String(l.amount),
          txHash: l.evidence.txHash,
        });
      }
      const received = split.receipt.amount;
      const vendorAfter = await usdc(vendor.address),
        vaultAfter = await usdc(a.vault),
        sent = paid.reduce((n, p) => n + BigInt(p.amount), 0n);
      const vendorDiff = vendorAfter - BigInt(manifest.vendorBefore!) - sent;
      const vaultDiff =
        vaultAfter - BigInt(manifest.vaultBefore!) - (received - sent);
      if (vendorDiff !== 0n || vaultDiff !== 0n)
        throw new Error('RECONCILIATION_MISMATCH');
      if (!paid.some((p) => p.purpose === 'CONTRACTOR_PAYABLE'))
        throw new Error('BILL_NOT_PAID');
      const view = await books.view(workspaceId, p0!.principalId);
      Object.assign(evidence, {
        status: 'PASS_AUTOMATIC_SPLIT_FROM_FINALIZED_RECEIPT',
        receiptId: receipt.key,
        receivedBaseUnits: String(received),
        splitId: split.splitId,
        legs: legs.map((l) => ({
          purpose: l.purpose,
          kind: l.kind,
          amount: String(l.amount),
          state: l.state,
        })),
        transfers: paid,
        billStatus: view.payables.find((p) => p.id === manifest.payableId)
          ?.status,
        screening: 'OFAC_SDN_LIST_ONLY',
        reconciliation: {
          vendorDifferenceBaseUnits: String(vendorDiff),
          vaultDifferenceBaseUnits: String(vaultDiff),
        },
        independentHumanUsers: 0,
      });
      persist();
      process.stdout.write(
        `LIVE_ARC_TESTNET ${evidencePath}; split ${split.splitId}; ${paid.length} transfers; reconciliation 0\n`,
      );
    }
  } catch (error) {
    evidence.lastAttempt = {
      phase,
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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  type Hex,
  type PrivateKeyAccount,
} from 'viem';
import { token } from '@synq/chain-registry/arc';
import { connectChain } from '@synq/execution-worker/arc';
import { readWorkspaceAuthority } from '@synq/execution-worker/workspace-authority';
import { WorkspaceGovernanceExecutor } from '@synq/execution-worker/workspace-governance';
import { WorkspaceTreasury } from '@synq/execution-worker/workspace-treasury';
import { WorkspaceFinance } from '@synq/workspaces/finance';
import { WorkspaceBooks } from '@synq/workspaces/books';
import { WorkspaceContributions } from '@synq/workspaces/contributions';
import { WorkspaceGovernance } from '@synq/workspaces/governance';
import { WorkspaceReceipts } from '@synq/workspaces/receipts';
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
import { InvoiceService, PostgresInvoiceStore } from '@synq/invoices';
import { Ledger, PostgresLedgerStore, viemIndexerChain } from '@synq/ledger';
import { WorkspaceIndexer } from '../apps/demo/src/workspace-indexer.js';

/**
 * LIVE_ARC_TESTNET group fund proof: two members contribute from their own
 * wallets with one-time Memo references; the persistent indexer credits each
 * to the paying member only; the owners then wind the fund down and each
 * member's exact equity is refunded by a 2-of-2 vault transfer.
 */
if (process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
  throw new Error('MAINNET_FORBIDDEN');
const runId = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/)
  .parse(process.env.SYNQ_DYNAMIC_RUN_ID);
if (process.env.SYNQ_DYNAMIC_GROUP_LIVE !== '1') {
  process.stdout.write(
    'Read-only mode. Set SYNQ_DYNAMIC_GROUP_LIVE=1 for the authorized Arc testnet group fund proof.\n',
  );
} else {
  const dir = join(homedir(), '.synq');
  const secret = (path: string) => {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error('KEY_FILE_PERMISSIONS');
    return readFileSync(path, 'utf8').trim();
  };
  const key = (name: string) => {
    const t = secret(join(dir, name));
    return privateKeyToAccount((t.startsWith('0x') ? t : `0x${t}`) as Hex);
  };
  const owner = key(`e2e-user-${runId}-owner.key`),
    coowner = key(`e2e-user-${runId}-coowner.key`),
    member = key(`e2e-user-${runId}-arbiter.key`),
    operator = key(`e2e-user-${runId}-operator.key`),
    deployer = key('testnet.key');
  const workspaceId = z
    .uuid()
    .parse(
      JSON.parse(secret(join(dir, `e2e-user-${runId}-run.json`))).workspaceId,
    );
  const path = join(dir, `e2e-user-${runId}-group.json`);
  type Manifest = {
    contributions: Record<string, { id: string; hash: Hex | null }>;
    funding: Record<string, Hex>;
    before: Record<string, string> | null;
  };
  const manifest: Manifest = existsSync(path)
    ? JSON.parse(secret(path))
    : { contributions: {}, funding: {}, before: null };
  const save = () =>
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
  save();
  mkdirSync(join('bounty-evidence', 'arc'), { recursive: true });
  const evidencePath = join(
    'bounty-evidence',
    'arc',
    `dynamic-group-${runId}.json`,
  );
  const evidence: Record<string, unknown> = {};
  const persist = () =>
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  const url =
    process.env.SYNQ_DYNAMIC_DATABASE_URL ??
    'postgresql://postgres@127.0.0.1:55433/synq_m2_dynamic';
  if (!/^synq_m2_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1)))
    throw new Error('TEST_DATABASE_REQUIRED');
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  try {
    const chain = await connectChain('arc-testnet');
    const arc = defineChain({
      id: 5042002,
      name: 'Arc Testnet',
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
      rpcUrls: { default: { http: [chain.profile.rpcUrls[0]!] } },
    });
    const walletOf = (a: PrivateKeyAccount) =>
      createWalletClient({ chain: arc, account: a, transport: http() });
    const usdc = token('arc-testnet', 'USDC');
    const balance = (a: Hex) =>
      chain.client.readContract({
        address: usdc.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [a],
      });
    const store = new PostgresWorkspaceStore(pool, 'https://synq.test');
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
    const login = async (who: PrivateKeyAccount) => {
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
    const [po, pc, pm] = await Promise.all([
      login(owner),
      login(coowner),
      login(member),
    ]);
    const contributions = new WorkspaceContributions(finance);
    const plan = [
      ['coowner', coowner, pc!, 4000n],
      ['member', member, pm!, 2000n],
    ] as const;
    // Test funding of the software wallets (not a Synq payment).
    for (const [label, who, , amount] of plan) {
      if (manifest.funding[label]) continue;
      if ((await balance(who.address)) >= amount + 4000n) continue;
      const hash = await walletOf(deployer).writeContract({
        address: usdc.address,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [who.address, 10000n],
      });
      await chain.client.waitForTransactionReceipt({ hash });
      manifest.funding[label] = hash;
      save();
    }
    if (!manifest.before) {
      manifest.before = Object.fromEntries(
        await Promise.all(
          plan.map(
            async ([label, who]) =>
              [label, String(await balance(who.address))] as const,
          ),
        ),
      );
      save();
    }
    const fees: Record<string, bigint> = {};
    for (const [label, who, p, amount] of plan) {
      let c = manifest.contributions[label];
      if (!c) {
        const req = await contributions.request(workspaceId, p.principalId, {
          amount: String(amount),
          note: `Group trip share (${label})`,
        });
        c = { id: req.id, hash: null };
        manifest.contributions[label] = c;
        save();
        // The member's own wallet pays, with the one-time reference.
        c.hash = await walletOf(who).sendTransaction({
          to: req.transaction.to,
          data: req.transaction.data,
          value: 0n,
        });
        save();
      }
      const r = await chain.client.waitForTransactionReceipt({ hash: c.hash! });
      fees[label] = r.gasUsed * r.effectiveGasPrice;
    }
    const ledger = new Ledger(new PostgresLedgerStore(pool));
    const indexer = new WorkspaceIndexer(
      new WorkspaceReceipts(
        finance,
        new InvoiceService(new PostgresInvoiceStore(pool), ledger, store.now),
        ledger,
      ),
      [viemIndexerChain(chain.client)],
    );
    await indexer.migrate();
    for (let n = 0; n < 80; n++) {
      await indexer.tick();
      const rows = await pool.query(
        "SELECT count(*)::int AS n FROM synq_ws_contributions WHERE workspace_id=$1 AND id = ANY($2::uuid[]) AND state='PAID'",
        [workspaceId, Object.values(manifest.contributions).map((c) => c.id)],
      );
      if (rows.rows[0].n === plan.length) break;
    }
    const credited = await pool.query(
      "SELECT principal_id,amount FROM synq_ws_contributions WHERE id = ANY($1::uuid[]) AND state='PAID'",
      [Object.values(manifest.contributions).map((c) => c.id)],
    );
    for (const [, , p, amount] of plan)
      if (
        !credited.rows.some(
          (r) =>
            r.principal_id === p.principalId && BigInt(r.amount) === amount,
        )
      )
        throw new Error('CONTRIBUTION_NOT_CREDITED');
    const treasury = new WorkspaceTreasury(
      finance,
      chain,
      chain.profile.rpcUrls[0]!,
      new WorkspaceBooks(finance),
    );
    const a = await finance.authority(workspaceId);
    let refunds = await contributions.refunds(workspaceId, po!.principalId);
    if (!refunds.some((r) => r.state !== 'PAID'))
      refunds = await contributions.proposeRefunds(
        workspaceId,
        po!.principalId,
        await treasury.freeUsdc(workspaceId, a.vault, false),
      );
    const governance = new WorkspaceGovernance(finance);
    const executor = new WorkspaceGovernanceExecutor(finance, chain, operator, {
      operator: 'dynamic-group-proof',
      grantKey: Buffer.from(
        secret(join(dir, `e2e-user-${runId}-grant.key`)),
        'hex',
      ),
      grantTtlSeconds: 60,
      riskRequiredAbove: 0n,
    });
    const refundHashes: string[] = [];
    for (const r of refunds) {
      if (r.state === 'PAID') {
        refundHashes.push(r.txHash!);
        continue;
      }
      let action;
      for (let i = 0; ; i++) {
        try {
          action = await governance.proposeRefund(
            workspaceId,
            po!.principalId,
            r.id,
          );
          break;
        } catch (e) {
          // The vault's nonce read lags the last confirmed action briefly.
          if ((e as { code?: string }).code !== 'SAFE_NONCE_PENDING' || i > 20)
            throw e;
          await new Promise((res) => setTimeout(res, 3000));
        }
      }
      const rec = (await governance.record(action.action.id))!;
      if (rec.state === 'REVIEW')
        for (const [who, p] of [
          [owner, po!],
          [coowner, pc!],
        ] as const)
          await governance.approve(workspaceId, p.principalId, rec.action.id, {
            approvalSignature: await who.signTypedData(
              safeActionApprovalTypedData(rec.action),
            ),
            safeSignature: await who.signTypedData(
              safeActionTypedData(rec.action),
            ),
          });
      const out = await executor.execute(rec.action.id);
      if (out.state !== 'CONFIRMED') throw new Error(`REFUND_${out.state}`);
      refundHashes.push(String(out.evidence?.hash));
    }
    const after = await contributions.equity(workspaceId);
    const results = [];
    for (const [label, who, p, amount] of plan) {
      const now = await balance(who.address);
      // Native USDC pays gas: contributed, refunded, minus the contribution fee.
      const diff =
        now - BigInt(manifest.before![label]!) + fees[label]! / 10n ** 12n;
      results.push({
        label,
        wallet: who.address,
        contributed: String(amount),
        equityAfter: String(after.get(p.principalId) ?? 0n),
        netChangeExcludingGasBaseUnits: String(diff),
      });
      if ((after.get(p.principalId) ?? 0n) !== 0n)
        throw new Error('EQUITY_NOT_REFUNDED');
    }
    Object.assign(evidence, {
      runId,
      workspaceId,
      mode: 'LIVE_ARC_TESTNET',
      status: 'PASS_GROUP_FUND_CONTRIBUTE_AND_QUORUM_REFUND',
      vault: a.vault,
      contributions: Object.fromEntries(
        Object.entries(manifest.contributions).map(([k, v]) => [k, v.hash]),
      ),
      refunds: refundHashes,
      members: results,
      testFunding: manifest.funding,
      independentHumanUsers: 0,
    });
    persist();
    process.stdout.write(
      `LIVE_ARC_TESTNET ${evidencePath}; ${plan.length} contributions credited, ${refundHashes.length} refunds\n`,
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

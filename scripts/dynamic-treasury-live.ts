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
import { erc20Abi, type Hex } from 'viem';
import { token } from '@synq/chain-registry/arc';
import { connectChain } from '@synq/execution-worker/arc';
import { readWorkspaceAuthority } from '@synq/execution-worker/workspace-authority';
import { WorkspaceGovernanceExecutor } from '@synq/execution-worker/workspace-governance';
import { WorkspaceTreasury } from '@synq/execution-worker/workspace-treasury';
import { WorkspaceFinance } from '@synq/workspaces/finance';
import { WorkspaceBooks } from '@synq/workspaces/books';
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

/**
 * LIVE_ARC_TESTNET proof of a workspace treasury swap: 0.002 USDC to EURC
 * from the fresh 2-of-2 vault. Both owners sign the exact allowance, then the
 * Circle App Kit adapter call captured for the vault and checked against the
 * plan; the operator only relays Safe transactions under one-use Kernel grants.
 */
if (process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
  throw new Error('MAINNET_FORBIDDEN');
const runId = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/)
  .parse(process.env.SYNQ_DYNAMIC_RUN_ID);
const AMOUNT = 2000n;
if (process.env.SYNQ_DYNAMIC_TREASURY_LIVE !== '1') {
  process.stdout.write(
    'Read-only mode. Set SYNQ_DYNAMIC_TREASURY_LIVE=1 for the authorized Arc testnet swap proof.\n',
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
    const t = secret(join(dir, `e2e-user-${runId}-${label}.key`));
    return privateKeyToAccount((t.startsWith('0x') ? t : `0x${t}`) as Hex);
  };
  const owner = actor('owner'),
    coowner = actor('coowner'),
    operator = actor('operator');
  const workspaceId = z
    .uuid()
    .parse(
      JSON.parse(secret(join(dir, `e2e-user-${runId}-run.json`))).workspaceId,
    );
  const path = join(dir, `e2e-user-${runId}-treasury.json`);
  const manifest: {
    opId: string | null;
    before: Record<string, string> | null;
  } = existsSync(path)
    ? JSON.parse(secret(path))
    : { opId: null, before: null };
  const save = () =>
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
  save();
  mkdirSync(join('bounty-evidence', 'arc'), { recursive: true });
  const evidencePath = join(
    'bounty-evidence',
    'arc',
    `dynamic-treasury-${runId}.json`,
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
    const bal = (sym: 'USDC' | 'EURC') =>
      chain.client.readContract({
        address: token('arc-testnet', sym).address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [a.vault],
      });
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
    const treasury = new WorkspaceTreasury(
      finance,
      chain,
      chain.profile.rpcUrls[0]!,
      new WorkspaceBooks(finance),
    );
    const executor = new WorkspaceGovernanceExecutor(finance, chain, operator, {
      operator: 'dynamic-treasury-proof',
      grantKey: Buffer.from(
        secret(join(dir, `e2e-user-${runId}-grant.key`)),
        'hex',
      ),
      grantTtlSeconds: 60,
      riskRequiredAbove: 0n,
    });
    const signAndRun = async (actionId: string) => {
      let r = (await treasury.governance.record(actionId))!;
      if (r.state === 'REVIEW')
        for (const [who, p] of [
          [owner, p0!],
          [coowner, p1!],
        ] as const)
          await treasury.governance.approve(
            workspaceId,
            p.principalId,
            actionId,
            {
              approvalSignature: await who.signTypedData(
                safeActionApprovalTypedData(r.action),
              ),
              safeSignature: await who.signTypedData(
                safeActionTypedData(r.action),
              ),
            },
          );
      const out = await executor.execute(actionId);
      if (out.state !== 'CONFIRMED') throw new Error(`ACTION_${out.state}`);
      r = (await treasury.governance.record(actionId))!;
      return r.evidence;
    };
    if (!manifest.before) {
      manifest.before = {
        usdc: String(await bal('USDC')),
        eurc: String(await bal('EURC')),
      };
      save();
    }
    if (!manifest.opId) {
      const op = await treasury.proposeSwap(workspaceId, p0!.principalId, {
        from: 'USDC',
        to: 'EURC',
        amount: String(AMOUNT),
        slippageBps: 100,
      });
      manifest.opId = op!.id;
      save();
    }
    let op = (await treasury.record(manifest.opId))!;
    const approveEvidence =
      op.state === 'APPROVE' && op.approveActionId
        ? await signAndRun(op.approveActionId)
        : null;
    op = (await treasury.record(manifest.opId))!;
    if (op.state === 'EXECUTE') {
      op = (await treasury.prepareExecution(
        workspaceId,
        p0!.principalId,
        op.id,
      ))!;
      await signAndRun(op.executeActionId!);
    }
    op = (await treasury.record(manifest.opId))!;
    if (op.state !== 'DONE') throw new Error(`TREASURY_${op.state}`);
    const [usdcAfter, eurcAfter] = await Promise.all([
      bal('USDC'),
      bal('EURC'),
    ]);
    const spent = BigInt(manifest.before!.usdc!) - usdcAfter,
      received = eurcAfter - BigInt(manifest.before!.eurc!);
    if (
      String(spent) !== op.evidence!.spent ||
      String(received) !== op.evidence!.received ||
      received < BigInt(op.data.minOut)
    )
      throw new Error('RECONCILIATION_MISMATCH');
    Object.assign(evidence, {
      runId,
      workspaceId,
      mode: 'LIVE_ARC_TESTNET',
      status: 'PASS_QUORUM_TREASURY_SWAP_USDC_TO_EURC',
      vault: a.vault,
      opId: op.id,
      terms: op.data,
      approveAction: approveEvidence,
      execute: op.evidence,
      reconciliation: {
        usdcSpentBaseUnits: String(spent),
        eurcReceivedBaseUnits: String(received),
        minOut: op.data.minOut,
        difference: 0,
      },
      route:
        'Circle App Kit adapter, called by the Safe after 2-of-2 owner signatures',
      independentHumanUsers: 0,
    });
    persist();
    process.stdout.write(
      `LIVE_ARC_TESTNET ${evidencePath}; swapped ${spent} USDC units for ${received} EURC units\n`,
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

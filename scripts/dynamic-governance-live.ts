import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { connectChain } from '@synq/execution-worker/arc';
import { readWorkspaceAuthority } from '@synq/execution-worker/workspace-authority';
import { WorkspaceGovernanceExecutor } from '@synq/execution-worker/workspace-governance';
import { WorkspaceGovernance } from '@synq/workspaces/governance';
import { WorkspaceFinance } from '@synq/workspaces/finance';
import {
  PostgresWorkspaceStore,
  WorkspaceVaultSetups,
  loginTypedData,
} from '@synq/workspaces';
import { financeChangeTypedData } from '@synq/workspaces/finance-contracts';
import {
  safeActionApprovalTypedData,
  safeActionTypedData,
} from '@synq/kernel/arc-safe-action';
import { VaultSetupSchema } from '@synq/kernel/arc-vault-setup';

if (process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
  throw new Error('MAINNET_FORBIDDEN');
const runId = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/)
  .parse(process.env.SYNQ_DYNAMIC_RUN_ID);
const kind = z
  .enum(['QUEUE_VENDOR', 'ALLOW_VENDOR', 'REMOVE_VENDOR'])
  .parse(process.env.SYNQ_DYNAMIC_GOV_ACTION ?? 'QUEUE_VENDOR');
if (process.env.SYNQ_DYNAMIC_GOV_LIVE !== '1') {
  process.stdout.write(
    'Read-only mode: no files, signatures or transactions created. Set SYNQ_DYNAMIC_GOV_LIVE=1 for the authorized Arc testnet proof.\n',
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
  const vendorPath = join(dir, `e2e-user-${runId}-vendor.key`);
  if (!existsSync(vendorPath))
    writeFileSync(vendorPath, generatePrivateKey(), {
      mode: 0o600,
      flag: 'wx',
    });
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
  const path = join(dir, `e2e-user-${runId}-finance.json`);
  type Manifest = {
    vendorId: string;
    changeHash: Hex | null;
    actions: Partial<Record<typeof kind, string>>;
    operatorBefore: string | null;
    hashes: Hex[];
  };
  const manifest: Manifest = existsSync(path)
    ? (JSON.parse(secret(path)) as Manifest)
    : {
        vendorId: randomUUID(),
        changeHash: null,
        actions: {},
        operatorBefore: null,
        hashes: [],
      };
  const save = () =>
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
  save();
  const evidencePath = join(
    'bounty-evidence',
    'arc',
    `dynamic-governance-${runId}.json`,
  );
  mkdirSync(join('bounty-evidence', 'arc'), { recursive: true });
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
    const existing = await pool.query(
      'SELECT data FROM synq_ws_vault_setups WHERE workspace_id=$1',
      [workspaceId],
    );
    const setup = VaultSetupSchema.parse(existing.rows[0]?.data);
    const setups = new WorkspaceVaultSetups(store, setup);
    const finance = new WorkspaceFinance(store, (id) =>
      readWorkspaceAuthority(chain, setups, id),
    );
    await finance.migrate();
    const current = await finance.authority(workspaceId);
    if (
      current.threshold !== 2 ||
      current.owners.length !== 2 ||
      !current.owners.includes(owner.address) ||
      !current.owners.includes(coowner.address)
    )
      throw new Error('EXPECTED_FRESH_TWO_OWNER_VAULT');
    const balance = await chain.client.getBalance({
      address: operator.address,
    });
    if (!manifest.operatorBefore) {
      manifest.operatorBefore = String(balance);
      save();
    }
    const login = async (a: typeof owner) => {
      const c = await store.challenge({
        wallet: a.address,
        audience: 'native',
      });
      return store.login(
        c.id,
        await a.signTypedData({
          ...loginTypedData(c),
          message: {
            ...loginTypedData(c).message,
            wallet: a.address,
            expiresAt: BigInt(c.expiresAt),
          },
        }),
      );
    };
    const principals = await Promise.all([login(owner), login(coowner)]);
    if (!manifest.changeHash) {
      const c = await finance.propose(workspaceId, principals[0]!.principalId, {
        kind: 'VENDOR',
        vendorId: manifest.vendorId,
        name: `Workspace supplier ${runId}`,
        address: vendor.address,
        verification: 'OWNER_ATTESTATION',
      });
      manifest.changeHash = c.hash;
      save();
    }
    const change = await finance.change(
      workspaceId,
      principals[0]!.principalId,
      manifest.changeHash,
    );
    if (change.state !== 'APPLIED')
      for (const [index, a] of [owner, coowner].entries())
        await finance.approve(
          workspaceId,
          principals[index]!.principalId,
          manifest.changeHash,
          await a.signTypedData(financeChangeTypedData(change.change)),
        );
    const service = new WorkspaceGovernance(finance);
    let id = manifest.actions[kind];
    if (!id) {
      const proposed = await service.propose(
        workspaceId,
        principals[0]!.principalId,
        { kind, vendorId: manifest.vendorId },
      );
      id = proposed.action.id;
      manifest.actions[kind] = id;
      save();
    }
    const record = await service.record(id);
    if (!record) throw new Error('ACTION_MISSING');
    if (record.state === 'REVIEW')
      for (const [index, a] of [owner, coowner].entries())
        await service.approve(workspaceId, principals[index]!.principalId, id, {
          approvalSignature: await a.signTypedData(
            safeActionApprovalTypedData(record.action),
          ),
          safeSignature: await a.signTypedData(
            safeActionTypedData(record.action),
          ),
        });
    const executor = new WorkspaceGovernanceExecutor(finance, chain, operator, {
      operator: 'dynamic-governance-proof',
      grantKey: Buffer.from(
        secret(join(dir, `e2e-user-${runId}-grant.key`)),
        'hex',
      ),
      grantTtlSeconds: 60,
      riskRequiredAbove: 0n,
    });
    await executor.outbox.migrate();
    const result = await executor.execute(id);
    const outbox = await executor.outbox.get(`workspace-action:${id}`);
    if (!outbox || outbox.state !== 'CONFIRMED' || result.state !== 'CONFIRMED')
      throw new Error('GOVERNANCE_NOT_CONFIRMED');
    if (!manifest.hashes.includes(outbox.hash)) {
      manifest.hashes.push(outbox.hash);
      save();
    }
    let gas = 0n;
    for (const hash of manifest.hashes) {
      const receipt = await chain.client.getTransactionReceipt({ hash });
      gas += receipt.gasUsed * receipt.effectiveGasPrice;
    }
    const after = await chain.client.getBalance({ address: operator.address }),
      difference = BigInt(manifest.operatorBefore) - after - gas;
    if (difference !== 0n)
      throw new Error('GOVERNANCE_GAS_RECONCILIATION_MISMATCH');
    Object.assign(evidence, {
      runId,
      workspaceId,
      mode: 'LIVE_ARC_TESTNET',
      onboardingActors: 'LOCAL_FIXTURE_SOFTWARE_WALLETS',
      independentHumanUsers: 0,
      vendorId: manifest.vendorId,
      vendorAddress: vendor.address,
      verification: 'OWNER_ATTESTATION_SIGNED_BY_BOTH_OWNERS',
      actions: { ...((evidence.actions as object) ?? {}), [kind]: result },
      hashes: manifest.hashes,
      gasNativeWei: String(gas),
      operatorBeforeNativeWei: manifest.operatorBefore,
      operatorAfterNativeWei: String(after),
      reconciliationDifferenceWei: '0',
      status:
        kind === 'QUEUE_VENDOR'
          ? 'PASS_VENDOR_QUEUE_ONLY'
          : `PASS_${kind}_ONLY`,
      limits:
        'Payout screening is unavailable; no live payout is claimed. No independent human onboarding proof.',
    });
    persist();
    process.stdout.write(
      `LIVE_ARC_TESTNET ${evidencePath}; ${kind} ${outbox.hash}; gas reconciliation 0 wei\n`,
    );
  } catch (error) {
    evidence.lastAttempt = {
      kind,
      status: 'BLOCKED',
      code:
        error instanceof Error && /^[A-Z_]{1,100}$/.test(error.message)
          ? error.message
          : 'EXECUTION_UNAVAILABLE',
    };
    persist();
    process.stderr.write(
      `BLOCKED ${evidencePath}; see bounded diagnostic code.\n`,
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

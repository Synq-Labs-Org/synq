import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, keccak256, toHex, type Hex } from 'viem';
import { z } from 'zod';
import { token } from '@synq/chain-registry/arc';
import { money } from '@synq/domain';
import {
  decide,
  mandateTypedData,
  type PaymentMandate,
  type PaymentIntent,
} from '@synq/kernel/arc';
import { vaultSetupTypedData } from '@synq/kernel/arc-vault-setup';
import { connectChain, prepareTransfer } from '@synq/execution-worker/arc';
import { payGrantOnce, recover } from '@synq/execution-worker/arc-outbox';
import {
  PostgresGrantFence,
  PostgresOutboxStore,
} from '@synq/execution-worker/pg-outbox';
import { workspaceVaultRuntime } from '@synq/execution-worker/workspace-vault';
import {
  PostgresWorkspaceStore,
  WorkspaceVaultSetups,
  loginTypedData,
} from '@synq/workspaces';

if (process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
  throw new Error('MAINNET_FORBIDDEN');
const runId = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/)
  .parse(process.env.SYNQ_DYNAMIC_RUN_ID ?? randomBytes(6).toString('hex'));
const dir = join(homedir(), '.synq');
const manifestPath = join(dir, `e2e-user-${runId}-run.json`);
const evidencePath = join(
  'bounty-evidence',
  'arc',
  `dynamic-vault-${runId}.json`,
);
mkdirSync(dir, { recursive: true, mode: 0o700 });
mkdirSync(join('bounty-evidence', 'arc'), { recursive: true });
function secret(path: string) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.mode & 0o077)
    throw new Error('KEY_FILE_PERMISSIONS');
  return readFileSync(path, 'utf8').trim();
}
function actor(label: string) {
  const path = join(dir, `e2e-user-${runId}-${label}.key`);
  if (!existsSync(path))
    writeFileSync(path, generatePrivateKey(), { flag: 'wx', mode: 0o600 });
  const raw = secret(path);
  return {
    path,
    account: privateKeyToAccount(
      (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex,
    ),
  };
}
const first = actor('owner');
const second = actor('coowner');
const operator = actor('operator');
const grantPath = join(dir, `e2e-user-${runId}-grant.key`);
if (!existsSync(grantPath))
  writeFileSync(grantPath, randomBytes(32).toString('hex'), {
    flag: 'wx',
    mode: 0o600,
  });
const grantKey = Buffer.from(secret(grantPath), 'hex');
type Manifest = {
  createdAt: number;
  workspaceId: string | null;
  ownerBefore: string | null;
  operatorBefore: string | null;
};
const manifest: Manifest = existsSync(manifestPath)
  ? (JSON.parse(secret(manifestPath)) as Manifest)
  : {
      createdAt: Math.floor(Date.now() / 1000),
      workspaceId: null,
      ownerBefore: null,
      operatorBefore: null,
    };
const save = () =>
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
save();
const evidence: Record<string, unknown> = {
  runId,
  mode: 'BLOCKED',
  onboardingActors: 'LOCAL_FIXTURE_SOFTWARE_WALLETS',
  independentHumanUsers: 0,
  fundingLimitUsdcBaseUnits: '150000',
  creationGasCeilingNativeWei: '140000000000000000',
};
const persist = () =>
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
let pool: pg.Pool | undefined;
let runtime: Awaited<ReturnType<typeof workspaceVaultRuntime>> | undefined;
try {
  const chain = await connectChain('arc-testnet');
  const usdc = token('arc-testnet', 'USDC');
  const funderText = secret(join(dir, 'testnet.key'));
  const funder = privateKeyToAccount(
    (funderText.startsWith('0x') ? funderText : `0x${funderText}`) as Hex,
  );
  const ownerBalance = await chain.client.getBalance({
    address: funder.address,
  });
  const operatorBalance = await chain.client.getBalance({
    address: operator.account.address,
  });
  evidence.preflight = {
    chainId: chain.profile.chainId,
    ownerNativeWei: String(ownerBalance),
    operatorNativeWei: String(operatorBalance),
  };
  persist();
  if (process.env.SYNQ_DYNAMIC_LIVE !== '1') {
    process.stdout.write(
      `READ_ONLY_PREFLIGHT ${evidencePath}; runId=${runId}\n`,
    );
  } else {
    const url =
      process.env.SYNQ_DYNAMIC_DATABASE_URL ??
      'postgresql://postgres@127.0.0.1:55433/synq_m2_dynamic';
    const parsed = new URL(url);
    const db = parsed.pathname.slice(1);
    if (!/^synq_m2_[a-z0-9_]+$/.test(db)) throw new Error('LIVE_DATABASE_NAME');
    const adminUrl = new URL(url);
    adminUrl.pathname = '/postgres';
    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      if (
        !(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [db]))
          .rowCount
      )
        await admin.query(`CREATE DATABASE ${db}`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: url, max: 8 });
    const store = new PostgresWorkspaceStore(pool, 'https://synq.test');
    await store.migrate();
    async function login(actor: typeof first) {
      const c = await store.challenge({
        wallet: actor.account.address,
        audience: 'native',
      });
      return store.login(
        c.id,
        await actor.account.signTypedData({
          ...loginTypedData(c),
          message: {
            ...loginTypedData(c).message,
            wallet: getAddress(c.wallet),
            expiresAt: BigInt(c.expiresAt),
          },
        }),
      );
    }
    const ownerSession = await login(first);
    const coownerSession = await login(second);
    if (!manifest.workspaceId) {
      const created = await store.create(ownerSession.principalId, {
        displayName: `Workspace ${runId}`,
        kind: 'GROUP',
      });
      manifest.workspaceId = created.workspace.id;
      save();
    }
    const id = manifest.workspaceId;
    if (
      !(await store.get(id, ownerSession.principalId)).members.some(
        (m) => m.principalId === coownerSession.principalId,
      )
    ) {
      const invite = await store.invite(id, ownerSession.principalId, {
        role: 'OWNER',
      });
      await store.accept(coownerSession.principalId, invite.token);
    }
    const outbox = new PostgresOutboxStore(pool);
    await outbox.migrate();
    const fence = new PostgresGrantFence(pool);
    const mandate: PaymentMandate = {
      mandateId: `dynamic-sponsor:${runId}`,
      version: 1,
      workspaceId: id,
      chainId: chain.profile.chainId,
      token: usdc.address as `0x${string}`,
      payer: funder.address,
      owner: funder.address,
      recipients: [operator.account.address],
      purposes: ['GROUP_EXPENSE'],
      perActionCap: 50000n,
      periodBudget: 150000n,
      periodSeconds: 86400,
      validFrom: manifest.createdAt - 60,
      validUntil: manifest.createdAt + 86400,
    };
    const mandateSignature = await funder.signTypedData(
      mandateTypedData(mandate),
    );
    if (!manifest.ownerBefore) {
      if (ownerBalance < 300_000_000_000_000_000n)
        throw new Error('SPONSOR_FUNDING_BALANCE_LOW');
      manifest.ownerBefore = String(ownerBalance);
      manifest.operatorBefore = String(operatorBalance);
      save();
    }
    const funding: { hash: string; baseUnits: string; feeWei: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const key = `dynamic-sponsor:${runId}:${i}`;
      let record = await outbox.get(key);
      if (record)
        record = await recover(outbox, chain, record, () =>
          Math.floor(Date.now() / 1000),
        );
      else {
        const amount = money(usdc, 50000n);
        await prepareTransfer(chain, {
          from: funder.address,
          to: operator.account.address,
          amount,
        });
        const intent: PaymentIntent = {
          intentId: key,
          mandateId: mandate.mandateId,
          mandateVersion: 1,
          chainId: chain.profile.chainId,
          token: mandate.token,
          payer: funder.address,
          recipient: operator.account.address,
          amount: 50000n,
          purpose: 'GROUP_EXPENSE',
          obligationRef: key,
          evidenceHash: keccak256(
            toHex(`testnet internal gas provisioning:${runId}`),
          ),
          proposedBy: 'owner-signed-testnet-proof',
        };
        const decision = await decide({
          config: {
            grantKey,
            operator: 'testnet-gas-provisioning',
            grantTtlSeconds: 120,
            riskRequiredAbove: 0n,
          },
          mandate,
          mandateSignature,
          intent,
          state: {
            revoked: false,
            spends: funding.map(() => ({
              amount: 50000n,
              at: manifest.createdAt,
            })),
          },
          risk: { available: true, flags: [] },
          simulationOk: true,
          now: Math.floor(Date.now() / 1000),
        });
        if (decision.outcome !== 'ALLOW')
          throw new Error('SPONSOR_FUNDING_KERNEL_DENIED');
        record = (
          await payGrantOnce({
            key,
            store: outbox,
            fence,
            chain,
            signer: funder,
            grant: decision.grant,
            grantKey,
            mandateRevoked: false,
            transfer: {
              from: funder.address,
              to: operator.account.address,
              amount,
            },
            now: () => Math.floor(Date.now() / 1000),
          })
        ).record;
      }
      if (record.state !== 'CONFIRMED' || !record.evidence)
        throw new Error('SPONSOR_FUNDING_NOT_RECONCILED');
      funding.push({
        hash: record.hash,
        baseUnits: '50000',
        feeWei: String(record.evidence.feeWei),
      });
      evidence.funding = funding;
      persist();
    }
    runtime = await workspaceVaultRuntime({
      setups: (defaults) => new WorkspaceVaultSetups(store, defaults),
      operatorKeyFile: operator.path,
      grantKeyFile: grantPath,
      dailyGasLimitWei: 10n ** 18n,
      maxCreationGasWei: 140_000_000_000_000_000n,
    });
    const proposal = (await runtime.setups.propose(
      id,
      ownerSession.principalId,
      { threshold: 2, delay: 3600 },
    ))!;
    if (proposal.state === 'AWAITING_SIGNATURES') {
      await runtime.setups.approve(
        id,
        ownerSession.principalId,
        await first.account.signTypedData(vaultSetupTypedData(proposal.setup)),
      );
      await runtime.setups.approve(
        id,
        coownerSession.principalId,
        await second.account.signTypedData(vaultSetupTypedData(proposal.setup)),
      );
    }
    const result = await runtime.execute(id);
    if (result.state !== 'ACTIVE' || !('hash' in result))
      throw new Error('VAULT_NOT_ACTIVE');
    const receipt = await chain.client.getTransactionReceipt({
      hash: result.hash,
    });
    const creationFee = receipt.gasUsed * receipt.effectiveGasPrice;
    const finalOwner = await chain.client.getBalance({
      address: funder.address,
    });
    const finalOperator = await chain.client.getBalance({
      address: operator.account.address,
    });
    const finalVault = await chain.client.getBalance({
      address: getAddress(result.safe),
    });
    const fees = funding.reduce((n, tx) => n + BigInt(tx.feeWei), creationFee);
    const difference =
      BigInt(manifest.ownerBefore!) +
      BigInt(manifest.operatorBefore!) -
      finalOwner -
      finalOperator -
      finalVault -
      fees;
    evidence.creation = result;
    evidence.reconciliation = {
      initialOwnerNativeWei: manifest.ownerBefore,
      initialOperatorNativeWei: manifest.operatorBefore,
      finalOwnerNativeWei: String(finalOwner),
      finalOperatorNativeWei: String(finalOperator),
      finalVaultNativeWei: String(finalVault),
      feesNativeWei: String(fees),
      differenceNativeWei: String(difference),
    };
    if (difference !== 0n) throw new Error('CHAIN_RECONCILIATION_DIFFERENCE');
    evidence.mode = 'LIVE_ARC_TESTNET';
    evidence.status = 'PASS_VAULT_CREATION_ONLY';
    evidence.remainingScenarios = 'G3-G14 not exercised by this proof';
    persist();
    process.stdout.write(
      `LIVE_ARC_TESTNET ${evidencePath}; vault tx ${result.hash}; reconciliation difference 0 wei\n`,
    );
  }
} catch (error) {
  evidence.diagnostics =
    error instanceof Error
      ? {
          name: error.name,
          frames: (error.stack ?? '')
            .split('\n')
            .filter((line) => /^\s+at /.test(line))
            .slice(0, 5)
            .map((line) => line.replaceAll(process.cwd(), '<repo>')),
        }
      : { name: 'UnknownError' };
  const diagnosticCode = (error as { code?: unknown } | null)?.code;
  if (
    typeof diagnosticCode === 'string' &&
    /^[A-Z0-9_]{1,80}$/.test(diagnosticCode)
  )
    evidence.diagnosticCode = diagnosticCode;
  evidence.status = 'BLOCKED';
  evidence.error =
    error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : 'EXECUTION_OR_PROVIDER_UNAVAILABLE';
  persist();
  process.stderr.write(`BLOCKED ${evidencePath}; ${evidence.error}\n`);
  process.exitCode = 1;
} finally {
  await runtime?.stop();
  await pool?.end();
}

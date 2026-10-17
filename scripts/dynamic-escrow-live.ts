import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  type Hex,
  type PrivateKeyAccount,
} from 'viem';
import { contract, token } from '@synq/chain-registry/arc';
import { DealRoomService } from '@synq/dealroom';
import { PostgresDealRoomStore } from '@synq/dealroom/postgres';
import { Ledger, PostgresLedgerStore, migrateFinance } from '@synq/ledger';
import { connectChain } from '@synq/execution-worker/arc';
import { verifyEscrow, readEscrowDeal } from '@synq/execution-worker/escrow';
import { PostgresGrantFence } from '@synq/execution-worker/pg-outbox';
import { migrateExecution } from '@synq/execution-worker/pg-schema';
import { WorkspaceDealEscrow } from '@synq/execution-worker/workspace-escrow';
import { WorkspaceDeals } from '@synq/workspaces/deals';
import { WorkspaceFinance } from '@synq/workspaces/finance';
import { PostgresWorkspaceStore, loginTypedData } from '@synq/workspaces';
import { OfacSdnScreening } from '@synq/plugin-risk';
import { PostgresSdnSnapshotStore } from '@synq/plugin-risk/postgres';

/**
 * LIVE_ARC_TESTNET proof of party-wallet deal escrow between workspace
 * members: the client funds two milestones from its own wallet; milestone 1
 * is delivered, accepted and released to the freelancer; milestone 2 is
 * disputed and the independent arbiter refunds it to the client. Every money
 * movement is a transaction the acting party's wallet signs after a bounded
 * mandate and an approval; the server only proves and records it. Software
 * wallets stand in for people (independent humans: 0). Total escrowed 0.01.
 */
if (process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
  throw new Error('MAINNET_FORBIDDEN');
const runId = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/)
  .parse(process.env.SYNQ_DYNAMIC_RUN_ID);
const REPO = 'Synq-Labs-Org/synq',
  COMMIT = '13cf941a4596bb8d76d8508ccf243f630e47d7ca';
if (process.env.SYNQ_DYNAMIC_ESCROW_LIVE !== '1') {
  process.stdout.write(
    'Read-only mode. Set SYNQ_DYNAMIC_ESCROW_LIVE=1 for the authorized Arc testnet escrow proof.\n',
  );
} else {
  const dir = join(homedir(), '.synq');
  const secret = (path: string) => {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error('KEY_FILE_PERMISSIONS');
    return readFileSync(path, 'utf8').trim();
  };
  const keyFile = (name: string) => {
    const t = secret(join(dir, name));
    return privateKeyToAccount((t.startsWith('0x') ? t : `0x${t}`) as Hex);
  };
  const arbiterPath = join(dir, `e2e-user-${runId}-arbiter.key`);
  if (!existsSync(arbiterPath))
    writeFileSync(arbiterPath, generatePrivateKey(), {
      mode: 0o600,
      flag: 'wx',
    });
  const freelancer = keyFile(`e2e-user-${runId}-owner.key`),
    client = keyFile(`e2e-user-${runId}-coowner.key`),
    arbiter = keyFile(`e2e-user-${runId}-arbiter.key`),
    deployer = keyFile('testnet.key');
  const workspaceId = z
    .uuid()
    .parse(
      JSON.parse(secret(join(dir, `e2e-user-${runId}-run.json`))).workspaceId,
    );
  const path = join(dir, `e2e-user-${runId}-escrow.json`);
  type Manifest = {
    linkKey: string;
    requestKey: string;
    dealId: string | null;
    funding: Record<string, Hex>;
    before: Record<string, string> | null;
  };
  const manifest: Manifest = existsSync(path)
    ? (JSON.parse(secret(path)) as Manifest)
    : {
        linkKey: randomBytes(32).toString('hex'),
        requestKey: randomUUID(),
        dealId: null,
        funding: {},
        before: null,
      };
  const save = () =>
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
  save();
  mkdirSync(join('bounty-evidence', 'arc'), { recursive: true });
  const evidencePath = join(
    'bounty-evidence',
    'arc',
    `dynamic-escrow-${runId}.json`,
  );
  const evidence: Record<string, unknown> = existsSync(evidencePath)
    ? (JSON.parse(readFileSync(evidencePath, 'utf8')) as Record<
        string,
        unknown
      >)
    : {};
  const persist = () =>
    writeFileSync(
      evidencePath,
      JSON.stringify(
        evidence,
        (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v),
        2,
      ) + '\n',
    );
  const url =
    process.env.SYNQ_DYNAMIC_DATABASE_URL ??
    'postgresql://postgres@127.0.0.1:55433/synq_m2_dynamic';
  if (!/^synq_m2_[a-z0-9_]+$/.test(new URL(url).pathname.slice(1)))
    throw new Error('TEST_DATABASE_REQUIRED');
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  const steps: Record<string, unknown>[] = [];
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
    // Test funding of the software wallets (not a Synq payment).
    for (const [label, who, want] of [
      ['client', client, 30000n],
      ['arbiter', arbiter, 6000n],
    ] as const) {
      if (manifest.funding[label]) continue;
      if ((await balance(who.address)) >= want) continue;
      const hash = await walletOf(deployer).writeContract({
        address: usdc.address,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [who.address, want],
      });
      await chain.client.waitForTransactionReceipt({ hash });
      manifest.funding[label] = hash;
      save();
    }
    const store = new PostgresWorkspaceStore(pool, 'https://synq.test');
    await store.migrate();
    await new WorkspaceFinance(store, () => {
      throw new Error('AUTHORITY_NOT_NEEDED');
    }).migrate();
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
    const [pf, pc, pa] = await Promise.all([
      login(freelancer),
      login(client),
      login(arbiter),
    ]);
    const isMember = await store
      .membership(workspaceId, pa!.principalId)
      .then(() => true)
      .catch(() => false);
    if (!isMember) {
      const invite = await store.invite(workspaceId, pf!.principalId, {
        role: 'MEMBER',
        expiresIn: 600,
      });
      await store.accept(pa!.principalId, invite.token);
    }
    await migrateExecution(pool);
    const dealStore = new PostgresDealRoomStore(pool);
    await dealStore.migrate();
    await migrateFinance(pool);
    const escrowInfo = await verifyEscrow(chain);
    const service = new DealRoomService(dealStore, {
      now: () => Math.floor(Date.now() / 1000),
      chainName: 'arc-testnet',
      asset: {
        chainId: usdc.chainId,
        network: usdc.network,
        token: usdc.address,
        symbol: 'USDC',
        decimals: usdc.decimals,
      },
      escrow: contract('arc-testnet', 'SYNQ_MILESTONE_ESCROW').address,
      settings: {
        disputePeriodSeconds: escrowInfo.disputePeriodSeconds,
        refundGraceSeconds: 7 * 86_400,
        offerTtlSeconds: 3 * 86_400,
      },
      books: { ledger: new Ledger(new PostgresLedgerStore(pool)) },
      fence: new PostgresGrantFence(pool),
    });
    const deals = new WorkspaceDeals(
      store,
      service,
      Buffer.from(manifest.linkKey, 'hex'),
    );
    const sdn = new OfacSdnScreening(
      new PostgresSdnSnapshotStore(pool),
      store.now,
    );
    await sdn.load();
    await sdn.refresh();
    const escrow = new WorkspaceDealEscrow(
      deals,
      chain,
      {
        operator: 'dynamic-escrow-proof',
        grantKey: Buffer.from(
          secret(join(dir, `e2e-user-${runId}-grant.key`)),
          'hex',
        ),
        grantTtlSeconds: 900,
        riskRequiredAbove: 0n,
      },
      sdn,
    );
    if (!manifest.dealId) {
      const d = await deals.draft(workspaceId, pc!.principalId, {
        clientId: pc!.principalId,
        freelancerId: pf!.principalId,
        arbiterId: pa!.principalId,
        request:
          'We need a landing page: hero section and pricing table. 0.01 USDC total. 0.005 USDC when the hero section ships, 0.005 USDC when the pricing table ships, within 3 days and within 5 days.',
        idempotencyKey: manifest.requestKey,
      });
      manifest.dealId = d.id;
      save();
    }
    const dealId = manifest.dealId;
    let view = await service.view(dealId);
    if (view.deal.status === 'DRAFT' || view.deal.status === 'NEGOTIATING')
      for (const [who, p] of [
        [client, pc!],
        [freelancer, pf!],
      ] as const) {
        view = await service.view(dealId);
        if (view.deal.status === 'ACCEPTED') break;
        await deals.sign(
          workspaceId,
          p.principalId,
          dealId,
          view.current.version,
          await who.signTypedData(service.typedData(view.current)),
        );
      }
    if (!manifest.before) {
      manifest.before = {
        client: String(await balance(client.address)),
        freelancer: String(await balance(freelancer.address)),
      };
      save();
    }
    const act = async (
      who: PrivateKeyAccount,
      principalId: string,
      op: 'FUND' | 'RELEASE' | 'REFUND' | 'DISPUTE',
      milestone: number | null,
    ) => {
      const prepared = await escrow.prepare(
        workspaceId,
        principalId,
        dealId,
        op,
        milestone,
      );
      let txs = (prepared as { transactions?: unknown }).transactions as
        | { step: string; to: Hex; data: Hex; label: string }[]
        | undefined;
      if (!txs) {
        const mandateSignature = await who.signTypedData(
          revive((prepared as { mandateTypedData: unknown }).mandateTypedData),
        );
        let auth = await escrow.authorize(
          workspaceId,
          principalId,
          prepared.key,
          { mandateSignature },
        );
        if ('approvalTypedData' in auth) {
          const approvalSignature = await who.signTypedData(
            revive(auth.approvalTypedData),
          );
          auth = await escrow.authorize(
            workspaceId,
            principalId,
            prepared.key,
            { mandateSignature, approvalSignature },
          );
        }
        txs = (auth as { transactions?: unknown }).transactions as typeof txs;
      }
      if (!txs?.length) throw new Error('ESCROW_NOT_GRANTED');
      const hashes: Record<string, Hex> = {};
      for (const tx of txs) {
        // The party's own wallet broadcasts the prepared call.
        const hash = await walletOf(who).sendTransaction({
          to: tx.to,
          data: tx.data,
          value: 0n,
        });
        await chain.client.waitForTransactionReceipt({ hash });
        hashes[tx.step] = hash;
      }
      const out = await escrow.submit(
        workspaceId,
        principalId,
        prepared.key,
        hashes,
      );
      steps.push({
        op,
        milestone,
        by: who.address,
        hashes,
        status: out.status,
      });
      return out;
    };
    const attest = async (
      who: PrivateKeyAccount,
      principalId: string,
      milestone: number,
      kind: 'DELIVERED' | 'ACCEPT_RELEASE' | 'DISPUTE' | 'ARBITER_REFUND',
      claim: unknown = null,
    ) => {
      const req = await deals.attestationRequest(
        workspaceId,
        principalId,
        dealId,
        { milestone, kind, evidence: claim },
      );
      await deals.attest(workspaceId, principalId, dealId, {
        milestone,
        kind,
        evidence: claim,
        nonce: req.nonce,
        deadline: req.deadline,
        signature: await who.signTypedData(revive(req.typedData)),
      });
      steps.push({ attest: kind, milestone, by: who.address });
    };
    view = await service.view(dealId);
    if (view.deal.status === 'ACCEPTED')
      await act(client, pc!.principalId, 'FUND', null);
    view = await service.view(dealId);
    const m = () => service.view(dealId).then((v) => v.deal.milestones);
    if ((await m())[0]!.status === 'FUNDED')
      await attest(freelancer, pf!.principalId, 0, 'DELIVERED', {
        type: 'GITHUB_COMMIT',
        url: `https://github.com/${REPO}/commit/${COMMIT}`,
        repo: REPO,
        commitSha: COMMIT,
        prNumber: null,
        sha256: null,
      });
    if ((await m())[0]!.status === 'DELIVERED')
      await attest(client, pc!.principalId, 0, 'ACCEPT_RELEASE');
    if ((await m())[0]!.status === 'ACCEPTED')
      await act(client, pc!.principalId, 'RELEASE', 0);
    if ((await m())[1]!.status === 'FUNDED') {
      await attest(client, pc!.principalId, 1, 'DISPUTE');
      await act(client, pc!.principalId, 'DISPUTE', null);
    }
    if ((await m())[1]!.status === 'DISPUTED')
      await attest(arbiter, pa!.principalId, 1, 'ARBITER_REFUND');
    if ((await m())[1]!.status === 'REFUNDING')
      await act(arbiter, pa!.principalId, 'REFUND', 1);
    view = await service.view(dealId);
    const onChain = await readEscrowDeal(
      chain,
      contract('arc-testnet', 'SYNQ_MILESTONE_ESCROW').address,
      BigInt(view.deal.escrow!.escrowDealId),
    );
    const freelancerGain =
      (await balance(freelancer.address)) -
      BigInt(manifest.before!.freelancer!);
    if (freelancerGain !== 5000n) throw new Error('FREELANCER_RECONCILIATION');
    if (
      onChain.milestones[0]!.status !== 'Withdrawn' ||
      onChain.milestones[1]!.status !== 'Refunded'
    )
      throw new Error('ESCROW_STATE_MISMATCH');
    Object.assign(evidence, {
      runId,
      workspaceId,
      mode: 'LIVE_ARC_TESTNET',
      status: 'PASS_PARTY_WALLET_ESCROW_FUND_RELEASE_DISPUTE_REFUND',
      dealId,
      escrowDealId: view.deal.escrow!.escrowDealId,
      dealStatus: view.deal.status,
      parties: {
        client: client.address,
        freelancer: freelancer.address,
        arbiter: arbiter.address,
      },
      milestones: view.deal.milestones.map((x) => x.status),
      onChain: onChain.milestones.map((x) => ({
        amount: String(x.amount),
        status: x.status,
      })),
      steps: [...((evidence.steps as unknown[]) ?? []), ...steps],
      freelancerReceivedBaseUnits: String(freelancerGain),
      testFunding: manifest.funding,
      screening: 'OFAC_SDN_LIST_ONLY (release and refund recipients)',
      evidenceVerifier:
        'format-only in this run (GitHub API verifier not configured)',
      independentHumanUsers: 0,
    });
    persist();
    process.stdout.write(
      `LIVE_ARC_TESTNET ${evidencePath}; escrow deal ${view.deal.escrow!.escrowDealId}; released 0.005 to the freelancer, refunded 0.005 to the client\n`,
    );
  } catch (error) {
    evidence.lastAttempt = {
      steps,
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

/** Typed data arrives JSON-safe (numbers as strings); viem accepts them as-is. */
function revive(v: unknown) {
  return v as Parameters<PrivateKeyAccount['signTypedData']>[0];
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createClient } from 'redis';
import {
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  ChainHeadObserver,
  EnvioPostgresSource,
  ProjectionReader,
  Projector,
  ReadModelAuthorizationAdapter,
  ReadModelError,
  RedisSnapshotCache,
  RpcDirectVerifier,
  StaleIndexError,
  defaultArtifactHasher,
  registerMandateArtifacts,
  syncToTarget,
  type Hex as RmHex,
  type ProjectionConfig,
  type SnapshotSource,
} from '../../packages/read-model/src/index.js';
import { PostgresProjectionStore } from '../../packages/read-model/src/storage.js';
import { indexerSettings } from '../../scripts/envio-env.js';
import {
  AUSD,
  CHAIN_ID,
  ForkChain,
  MANDATE_ID,
  erc20Abi,
  executeTransfer,
  mandateConfig,
  moduleAbi,
  registryAbi,
  safeAbi,
  type CreatedGroup,
  type ForkDeployment,
} from './harness/fork.js';
import { EnvioProcess } from '../../scripts/envio-process.js';
import { databaseUrl, dropSchemas, redisUrl, uniqueSchema } from './pg.js';

const enabled = process.env.SYNQ_RM_FORK_TESTS === '1';
const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
const created: string[] = [];
const dbUrl = new URL(databaseUrl);
const log = (...args: unknown[]) => console.log('[envio-it]', ...args);

let fork: ForkChain;
let deployment: ForkDeployment;
let cfg: ProjectionConfig;
let maxLag: number;
let envio: EnvioProcess;
let store: PostgresProjectionStore;
let projector: Projector;
let reader: ProjectionReader;
let source: EnvioPostgresSource;
let group: CreatedGroup;
const recipient = getAddress('0x00000000000000000000000000000000000b0b01');
const executor = getAddress('0x00000000000000000000000000000000000e0e01');
const artifact = { kind: 'synq.mandate', id: 'read-model-mandate', recipient };
const mandateHash = defaultArtifactHasher(artifact);

async function settle(): Promise<number> {
  await fork.mine(1);
  const head = await fork.head();
  await envio.waitFor(pool, CHAIN_ID, head);
  await syncToTarget(source, projector);
  return head;
}

describe.skipIf(!enabled)(
  'Envio HyperIndex on a Monad testnet fork (official AUSD, real Safe)',
  () => {
    beforeAll(async () => {
      fork = await ForkChain.start();
      deployment = await fork.deployFactory();
      log('fresh deployment', deployment);
      const { deployment: d, receipts } = fork.receipts(deployment);
      const settings = indexerSettings({
        profileName: 'sandbox/monad-testnet',
        deployment: d,
        receipts,
        rpcUrl: fork.url,
        maxReorgDepth: 50,
      });
      cfg = settings.projection;
      maxLag = settings.maxLagBlocks;
      const envioSchema = uniqueSchema('rm_ws4_envio');
      created.push(envioSchema);
      envio = new EnvioProcess({
        env: settings.env,
        schema: envioSchema,
        database: {
          host: dbUrl.hostname,
          port: Number(dbUrl.port),
          user: decodeURIComponent(dbUrl.username),
          password: decodeURIComponent(dbUrl.password),
          name: dbUrl.pathname.slice(1),
        },
        logFile: `artifacts/local/${envioSchema}.log`,
      });
      const projectionSchema = uniqueSchema('rm_ws4_proj');
      created.push(projectionSchema);
      store = new PostgresProjectionStore({ pool }, CHAIN_ID, projectionSchema);
      await store.migrate();
      projector = new Projector(store, cfg);
      reader = new ProjectionReader(store, cfg);
      source = new EnvioPostgresSource({ pool }, CHAIN_ID, envioSchema);
      await envio.start();
    }, 240_000);

    afterAll(async () => {
      await envio?.stop();
      await fork?.stop();
      await dropSchemas(pool, created);
      await pool.end();
    });

    it('replays from the deployment block: dynamic Safe registration, governance, AUSD funding and grant execution', async () => {
      group = await fork.createGroup(deployment, 'read-model-group');
      log('group', group.groupId, group.account, group.blockNumber);
      await fork.safeExec(
        group,
        deployment.module,
        encodeFunctionData({
          abi: moduleAbi,
          functionName: 'setExecutor',
          args: [executor, true],
        }),
      );
      await fork.safeExec(
        group,
        deployment.registry,
        encodeFunctionData({
          abi: registryAbi,
          functionName: 'configureMandate',
          args: [MANDATE_ID, mandateConfig(recipient, mandateHash)],
        }),
      );
      const fund = await fork.fundFromFaucet(group.account);
      const outsider = getAddress('0x00000000000000000000000000000000000c0c01');
      await fork.fundFromFaucet(outsider);
      await executeTransfer(
        fork,
        deployment,
        group,
        executor,
        recipient,
        1_000_000n,
        1n,
      );
      const newOwner = getAddress('0x00000000000000000000000000000000000d0d01');
      await fork.safeExec(
        group,
        group.account,
        encodeFunctionData({
          abi: safeAbi,
          functionName: 'addOwnerWithThreshold',
          args: [newOwner, 3n],
        }),
      );
      await fork.safeExec(
        group,
        deployment.module,
        encodeFunctionData({ abi: moduleAbi, functionName: 'pause', args: [] }),
        group.owners.slice(0, 3),
      );
      await settle();
      await registerMandateArtifacts(store, [{ mandateHash, artifact }]);

      const snap = (await reader.groupSnapshot(group.groupId as RmHex))!;
      expect(snap).not.toBeNull();
      const chainBalance = await fork.balanceOf(group.account);
      expect(chainBalance).toBe((await fork.faucetDrip()) - 1_000_000n);
      expect(snap.group.treasury).toEqual([
        expect.objectContaining({
          asset: AUSD.toLowerCase(),
          balance: chainBalance.toString(),
        }),
      ]);
      expect(snap.group.owners).toEqual(
        [
          ...group.owners.map((o) => o.address.toLowerCase()),
          newOwner.toLowerCase(),
        ].sort(),
      );
      expect(snap.group.threshold).toBe('3');
      expect(snap.group.paused).toBe(true);
      expect(snap.group.mandates[0]).toMatchObject({
        status: 'ACTIVE',
        spentToken: '1000000',
        currentVersion: '1',
      });
      expect(snap.group.mandates[0]!.versions[0]!.artifact).toBe('VERIFIED');
      expect(snap.group.grantsExecuted).toHaveLength(1);
      expect(snap.group.executors).toEqual([
        { executor: executor.toLowerCase(), allowed: true },
      ]);

      const journal = await store.read((s) =>
        s.journalRange(0, Number.MAX_SAFE_INTEGER),
      );
      const transfers = journal.filter((x) => x.event.eventName === 'Transfer');
      expect(
        transfers.every((x) => x.event.contract === AUSD.toLowerCase()),
      ).toBe(true);
      expect(
        transfers.some(
          (x) => x.event.transactionHash === fund.transactionHash.toLowerCase(),
        ),
      ).toBe(true);
      expect(
        journal.some((x) =>
          JSON.stringify(x.event.payload).includes(outsider.toLowerCase()),
        ),
      ).toBe(false);
      const registered = await pool.query(
        `SELECT encode(address,'hex') AS address, contract_id, registration_block FROM "${envio.options.schema}".envio_addresses WHERE registration_block >= 0`,
      );
      expect(registered.rows.map((r) => `0x${r.address}`)).toEqual([
        group.account.toLowerCase(),
        group.account.toLowerCase(),
      ]);

      const verifier = new RpcDirectVerifier(fork.client, cfg, reader);
      const verified = await verifier.verifyIndexed(group.groupId as RmHex);
      expect(verified.consistent).toBe(true);
      log(
        'verified against chain at',
        verified.checkedAtBlock,
        verified.observations.map((o) => o.target.kind),
      );
    }, 300_000);

    it('handles an Envio process restart with persisted state and indexes events from the downtime once', async () => {
      const before = await pool.query(
        `SELECT count(*)::int AS n FROM "${envio.options.schema}"."ChainEvent"`,
      );
      await envio.stop('SIGTERM');
      await fork.fundFromFaucet(group.account);
      await fork.mine(3);
      await envio.start();
      await settle();
      expect(envio.starts).toBe(2);
      const after = await pool.query(
        `SELECT count(*)::int AS n FROM "${envio.options.schema}"."ChainEvent"`,
      );
      expect(after.rows[0].n).toBe(before.rows[0].n + 1);
      const snap = (await reader.groupSnapshot(group.groupId as RmHex))!;
      expect(snap.group.treasury[0]!.balance).toBe(
        (await fork.balanceOf(group.account)).toString(),
      );
      const again = await syncToTarget(source, projector);
      expect(again.every((o) => o.appended === 0 && o.reorg === null)).toBe(
        true,
      );
    }, 300_000);

    it('artificial lag: a stopped indexer is detected against the independent RPC head and authorization verifies directly or refuses', async () => {
      await envio.stop('SIGKILL');
      await fork.mine(maxLag + 3);
      const verifier = new RpcDirectVerifier(fork.client, cfg, reader);
      const adapter = new ReadModelAuthorizationAdapter({
        source: reader,
        head: new ChainHeadObserver(fork.client, CHAIN_ID, { ttlMs: 0 }),
        verifier,
        maxLagBlocks: maxLag,
      });
      const direct = await adapter.readForAuthorization(group.groupId as RmHex);
      expect(direct.mode).toBe('DIRECT');
      expect(direct.freshness.status).toBe('STALE');
      expect(direct.freshness.lagBlocks).toBeGreaterThan(maxLag);
      await fork.fundFromFaucet(group.account);
      await fork.mine(1);
      const refused = await adapter
        .readForAuthorization(group.groupId as RmHex)
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(StaleIndexError);
      expect(
        (refused as StaleIndexError).direct?.observations.find(
          (o) => o.target.kind === 'TREASURY_BALANCE',
        )?.matches,
      ).toBe(false);
      const progressRow = await pool.query(
        `SELECT source_block FROM "${envio.options.schema}".envio_chains`,
      );
      expect(Number(progressRow.rows[0].source_block)).toBeLessThan(
        await fork.head(),
      );
      await envio.start();
      await settle();
      expect(
        (await adapter.readForAuthorization(group.groupId as RmHex)).mode,
      ).toBe('INDEXED');
    }, 300_000);

    it('AUSD-004 reorg fixture: a Transfer moved to another height is credited once, orphan removed, accounting frozen then reopened', async () => {
      const funder = privateKeyToAccount(generatePrivateKey());
      await fork.test.setBalance({
        address: funder.address,
        value: 10n ** 20n,
      });
      await fork.fundFromFaucet(funder.address);
      await settle();
      const wallet = createWalletClient({
        account: funder,
        chain: fork.client.chain!,
        transport: http(fork.url),
      });
      const request = await wallet.prepareTransactionRequest({
        to: AUSD,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [group.account, 2_500_000n],
        }),
        gas: 200_000n,
      });
      const raw = await wallet.signTransaction(request);
      const balanceBefore = await fork.balanceOf(group.account);
      const snapshotId = await fork.test.snapshot();
      const txHash = await fork.client.sendRawTransaction({
        serializedTransaction: raw,
      });
      const first = await fork.client.waitForTransactionReceipt({
        hash: txHash,
      });
      await envio.waitFor(pool, CHAIN_ID, Number(first.blockNumber));
      await syncToTarget(source, projector);
      const credited = (await reader.groupSnapshot(group.groupId as RmHex))!;
      expect(BigInt(credited.group.treasury[0]!.balance)).toBe(
        balanceBefore + 2_500_000n,
      );

      await fork.test.revert({ id: snapshotId });
      await fork.mine(1);
      await fork.client.sendRawTransaction({ serializedTransaction: raw });
      const second = await fork.client.waitForTransactionReceipt({
        hash: txHash,
      });
      expect(second.blockNumber).toBe(first.blockNumber + 1n);
      expect(second.blockHash).not.toBe(first.blockHash);
      log(
        'moved transfer',
        txHash,
        first.blockNumber,
        '->',
        second.blockNumber,
      );
      const head = await fork.head();
      await envio.waitFor(pool, CHAIN_ID, head);
      const outcomes = await syncToTarget(source, projector);
      const reorg = outcomes.find((o) => o.reorg);
      expect(reorg?.reorg?.forkBlock).toBeLessThanOrEqual(
        Number(first.blockNumber),
      );
      expect(reorg?.reopened.map((r) => r.transactionHash)).toContain(
        txHash.toLowerCase(),
      );
      const journal = await store.read((s) =>
        s.journalByTransactions([txHash.toLowerCase() as RmHex]),
      );
      expect(journal).toHaveLength(1);
      expect(journal[0]!.event.blockNumber).toBe(Number(second.blockNumber));
      const reopened = (await reader.groupSnapshot(group.groupId as RmHex))!;
      expect(BigInt(reopened.group.treasury[0]!.balance)).toBe(
        balanceBefore + 2_500_000n,
      );
      expect(BigInt(reopened.group.treasury[0]!.balance)).toBe(
        await fork.balanceOf(group.account),
      );
      expect(reopened.group.accountingStatus).toBe('FROZEN');
      expect((await reader.progress()).frozenGroups).toEqual([
        group.groupId.toLowerCase(),
      ]);
      await fork.mine(cfg.confirmationDepth + 1);
      await settle();
      const resolved = (await reader.groupSnapshot(group.groupId as RmHex))!;
      expect(resolved.group.accountingStatus).toBe('OPEN');
      const signals = await store.read((s) => s.signals());
      expect(
        signals.find((x) => x.transactionHash === txHash.toLowerCase()),
      ).toMatchObject({ status: 'RESOLVED', resolution: 'REOBSERVED' });
      log(
        'reorg signal',
        JSON.stringify(
          signals.find((x) => x.transactionHash === txHash.toLowerCase()),
        ),
      );
    }, 300_000);

    it('Redis flush rebuild: hits do not query Postgres; a flushed cache repopulates from the read model', async () => {
      const redis = createClient({ url: redisUrl });
      await redis.connect();
      try {
        await redis.flushDb();
        let calls = 0;
        const counting: SnapshotSource = {
          chainId: CHAIN_ID,
          scope: reader.scope,
          stamp: (id) => reader.stamp(id),
          progress: () => (calls++, reader.progress()),
          groupSnapshot: (id) => (calls++, reader.groupSnapshot(id)),
        };
        const cache = new RedisSnapshotCache(redis, counting, {
          namespace: 'synq:rm:ws4-it',
        });
        const miss = await cache.groupSnapshot(group.groupId as RmHex);
        const afterMiss = calls;
        const hit = await cache.groupSnapshot(group.groupId as RmHex);
        expect(calls).toBe(afterMiss);
        expect(hit).toEqual(miss);
        await redis.flushDb();
        const rebuilt = await cache.groupSnapshot(group.groupId as RmHex);
        expect(calls).toBeGreaterThan(afterMiss);
        expect(rebuilt).toEqual(miss);
      } finally {
        await redis.quit();
      }
    }, 60_000);

    it('detects DB-vs-chain inconsistency for treasury balance and owners', async () => {
      const verifier = new RpcDirectVerifier(fork.client, cfg, reader);
      expect(
        (await verifier.verifyIndexed(group.groupId as RmHex)).consistent,
      ).toBe(true);
      await pool.query(
        `UPDATE "${store.schema}".rm_balance SET balance = balance + 1 WHERE account=$1`,
        [group.account.toLowerCase()],
      );
      await pool.query(
        `DELETE FROM "${store.schema}".rm_owner WHERE group_id=$1 AND owner=$2`,
        [group.groupId, group.owners[0]!.address.toLowerCase()],
      );
      const error = await verifier
        .verifyIndexed(group.groupId as RmHex)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReadModelError);
      expect((error as ReadModelError).code).toBe('INCONSISTENT_WITH_CHAIN');
      expect((error as Error).message).toContain('TREASURY_BALANCE');
      expect((error as Error).message).toContain('OWNERS');
    }, 60_000);

    it('PASS gate: delete the read-model database and rebuild deterministically from indexed proof plus mandate artifacts', async () => {
      await store.resetProjection();
      await syncToTarget(source, projector);
      const checkpoint = (await projector.checkpoint()).indexedThroughBlock;
      await registerMandateArtifacts(store, [{ mandateHash, artifact }]);
      const before = await reader.stateHash();
      const snapshotBefore = await reader.groupSnapshot(group.groupId as RmHex);
      await store.dropSchema();
      await store.migrate();
      await syncToTarget(source, projector, { untilBlock: checkpoint });
      await registerMandateArtifacts(store, [{ mandateHash, artifact }]);
      expect((await projector.checkpoint()).indexedThroughBlock).toBe(
        checkpoint,
      );
      expect(await reader.stateHash()).toBe(before);
      const snapshotAfter = await reader.groupSnapshot(group.groupId as RmHex);
      expect(snapshotAfter!.stateHash).toBe(snapshotBefore!.stateHash);
      log('rebuild state hash', before, 'checkpoint', checkpoint);
    }, 120_000);

    it('unknown event versions in the indexed proof fail closed without advancing the projection', async () => {
      const cp = await projector.checkpoint();
      await fork.mine(2);
      const head = await fork.head();
      await envio.waitFor(pool, CHAIN_ID, head);
      const forged = {
        schemaVersion: 2,
        chainId: CHAIN_ID,
        blockNumber: head,
        blockHash: keccak256(stringToHex('forged')),
        transactionHash: keccak256(stringToHex('forged-tx')),
        transactionIndex: 0,
        logIndex: 0,
        contract: AUSD,
        eventName: 'Transfer',
        payload: { from: recipient, to: group.account, value: '1' },
      };
      await pool.query(
        `INSERT INTO "${envio.options.schema}"."ChainEvent" (id,"chainId","blockNumber","blockHash","transactionHash","transactionIndex","logIndex",contract,"eventName","eventJson") VALUES ($1,$2,$3,$4,$5,0,0,$6,'Transfer',$7)`,
        [
          'forged',
          CHAIN_ID,
          head,
          forged.blockHash,
          forged.transactionHash,
          AUSD,
          JSON.stringify(forged),
        ],
      );
      try {
        const error = await syncToTarget(source, projector).catch(
          (e: unknown) => e,
        );
        expect((error as ReadModelError).code).toBe('UNKNOWN_EVENT_VERSION');
        expect((await projector.checkpoint()).indexedThroughBlock).toBe(
          cp.indexedThroughBlock,
        );
      } finally {
        await pool.query(
          `DELETE FROM "${envio.options.schema}"."ChainEvent" WHERE id='forged'`,
        );
      }
      await syncToTarget(source, projector);
      expect(
        (await projector.checkpoint()).indexedThroughBlock,
      ).toBeGreaterThanOrEqual(head);
    }, 120_000);
  },
);

void ({} as Address | Hex);

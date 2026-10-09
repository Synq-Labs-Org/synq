import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import pg from 'pg';
import { createPublicClient, http, parseAbi, getAddress } from 'viem';
import { assetForRole, monadTestnetProfile } from '@synq/chain-registry';
import {
  EnvioPostgresSource,
  ProjectionReader,
  Projector,
  syncToTarget,
} from '@synq/read-model';
import { PostgresProjectionStore } from '@synq/read-model/storage';
import { registryDeploymentSettings } from './envio-env.js';
import { EnvioProcess } from './envio-process.js';

const databaseUrl =
  process.env.SYNQ_RM_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_rm_ws4';
const observedAccount = getAddress(
  z
    .object({ account: z.string() })
    .parse(
      JSON.parse(
        readFileSync(
          process.env.SYNQ_OBSERVED_ACCOUNT_FILE ??
            'reports/evidence/envio-testnet/observed-account.json',
          'utf8',
        ),
      ),
    ).account,
);
const envioSchema = process.env.SYNQ_ENVIO_SCHEMA ?? 'envio_testnet';
const projectionSchema = process.env.SYNQ_RM_SCHEMA ?? 'rm_ws4_testnet';
const out = 'reports/evidence/envio-testnet';
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

const base = registryDeploymentSettings('sandbox/monad-testnet');
const client = createPublicClient({ transport: http(base.rpcUrl) });
const ausd = assetForRole(monadTestnetProfile, 'treasuryAsset').address;
const baselineBlock = base.projection.startBlock - 1;
const baseline = await client.readContract({
  address: ausd,
  abi: erc20,
  functionName: 'balanceOf',
  args: [observedAccount],
  blockNumber: BigInt(baselineBlock),
});
const settings = registryDeploymentSettings('sandbox/monad-testnet', {
  observedAccounts: [
    {
      account: observedAccount,
      baselineBlock,
      baselineBalances: { [ausd]: baseline.toString() },
      label: 'third-party AUSD holder observed read-only for indexing evidence',
    },
  ],
});
const url = new URL(databaseUrl);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const envio = new EnvioProcess({
  env: settings.env,
  schema: envioSchema,
  database: {
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    name: url.pathname.slice(1),
  },
  logFile: `${out}/envio-testnet.log`,
});
mkdirSync(out, { recursive: true });
const headAtStart = Number(await client.getBlockNumber());
console.log(
  `indexing chain ${settings.projection.chainId} from deployment block ${settings.projection.startBlock} to head ${headAtStart}`,
);
const startedAt = Date.now();
await envio.start();
let progress: number;
try {
  progress = await envio.waitFor(
    pool,
    settings.projection.chainId,
    headAtStart,
    1_800_000,
  );
} catch (error) {
  await envio.stop();
  throw error;
}
const store = new PostgresProjectionStore(
  { pool },
  settings.projection.chainId,
  projectionSchema,
);
await store.migrate();
await store.resetProjection();
const projector = new Projector(store, settings.projection);
const source = new EnvioPostgresSource(
  { pool },
  settings.projection.chainId,
  envioSchema,
);
await syncToTarget(source, projector);
const checkpoint = await projector.checkpoint();
const reader = new ProjectionReader(store, settings.projection);
const progressView = await reader.progress();
const balances = (await store.read((s) => s.allTables())).rows('balance');
const observed = balances.find(
  (b) => b.account === observedAccount.toLowerCase(),
);
const chainBalance = await client.readContract({
  address: ausd,
  abi: erc20,
  functionName: 'balanceOf',
  args: [observedAccount],
  blockNumber: BigInt(checkpoint.indexedThroughBlock),
});
const envioChain = (
  await pool.query(`SELECT * FROM "${envioSchema}".envio_chains`)
).rows;
const envioRows = (
  await pool.query(
    `SELECT "blockNumber","blockHash","transactionHash","logIndex",contract,"eventName","eventJson" FROM "${envioSchema}"."ChainEvent" ORDER BY "blockNumber","transactionIndex","logIndex"`,
  )
).rows;
const addresses = (
  await pool.query(
    `SELECT '0x' || encode(a.address,'hex') AS address, c.name AS contract, a.registration_block FROM "${envioSchema}".envio_addresses a JOIN "${envioSchema}".envio_contracts c ON c.id = a.contract_id ORDER BY c.name`,
  )
).rows;
await envio.stop();
const receipts = [];
for (const row of envioRows.filter((r) => r.eventName === 'Transfer')) {
  const receipt = await client.getTransactionReceipt({
    hash: row.transactionHash,
  });
  const log = receipt.logs.find(
    (l) => Number(l.logIndex) === Number(row.logIndex),
  );
  receipts.push({
    transactionHash: row.transactionHash,
    blockNumber: Number(receipt.blockNumber),
    receiptBlockHash: receipt.blockHash,
    indexedBlockHash: row.blockHash,
    logAddress: log?.address,
    matches:
      receipt.blockHash === row.blockHash &&
      log?.address.toLowerCase() === ausd.toLowerCase(),
  });
}
const evidence = {
  generatedAt: new Date().toISOString(),
  profile: settings.projection.profile,
  chainId: settings.projection.chainId,
  rpc: settings.rpcUrl,
  dataSource: 'RPC (rpc.for=sync); no HyperSync token used',
  deployment: {
    factory: settings.projection.factory,
    registry: settings.projection.registry,
    module: settings.projection.module,
    startBlock: settings.projection.startBlock,
  },
  treasuryAsset: {
    symbol: 'AUSD',
    address: ausd,
    source: 'sources/chain_registry.json testnetAUSD (S093)',
  },
  observedAccount: {
    account: observedAccount,
    note: 'third-party address observed read-only; not a Synq group',
    baselineBlock,
    baselineBalance: baseline.toString(),
    projectedBalance: observed?.balance ?? null,
    chainBalanceAtCheckpoint: chainBalance.toString(),
    balanceMatchesChain: observed?.balance === chainBalance.toString(),
  },
  envio: {
    headAtStart,
    progressBlock: progress,
    chains: envioChain,
    registeredAddresses: addresses,
    indexedEvents: envioRows.map((r) => ({
      blockNumber: r.blockNumber,
      transactionHash: r.transactionHash,
      logIndex: r.logIndex,
      contract: r.contract,
      eventName: r.eventName,
    })),
    elapsedMs: Date.now() - startedAt,
  },
  projection: {
    indexedThroughBlock: checkpoint.indexedThroughBlock,
    generation: checkpoint.generation,
    groups: progressView.groups,
    stateHash: await reader.stateHash(),
  },
  transferReceiptCrossCheck: receipts,
};
writeFileSync(
  `${out}/indexing-evidence.json`,
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    { ...evidence, envio: { ...evidence.envio, chains: undefined } },
    null,
    2,
  ),
);
await pool.end();
if (
  !evidence.observedAccount.balanceMatchesChain ||
  receipts.some((r) => !r.matches)
)
  process.exitCode = 1;

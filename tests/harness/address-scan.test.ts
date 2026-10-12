import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { expect, it } from 'vitest';
import {
  assetForRole,
  monadTestnetProfile,
  officialAssets,
} from '@synq/chain-registry';
import {
  indexerSettings,
  registryDeploymentSettings,
} from '../../scripts/envio-env.js';
import { trackedFiles } from '../../scripts/secrets.mjs';

const ALLOWED_PATHS = [
  /^sources\/research\/2026-10-10-(mastra-temporal-models|kuru-chainlink-cre|perpl-intents-ausd)\.md$/,
  /^sources\/chain_registry\.json$/,
  // Sourced testnet-only provider payment assets (Circle testnet USDC).
  /^sources\/provider_testnet_assets\.json$/,
  /^bounty-evidence\//,
  /^contracts\/(abi|deployments|evidence|lib|out)\//,
  /^reports\//,
  // Submission evidence documents cite deployed contracts and explorer-linked transactions.
  /^submission\/(DEPLOYMENTS|DEMO_EVIDENCE)\.md$/,
  /^adrs\//,
  /^docs\//,
  /(^|\/)README\.md$/,
  /(^|\/)pnpm-lock\.yaml$/,
];
const SYNTHETIC = /^0x(?:0{30,}[0-9a-fA-F]*|([0-9a-fA-F])\1{39})$/;
function hardCodedAddresses(
  files: readonly string[],
  read: (file: string) => string,
): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (ALLOWED_PATHS.some((p) => p.test(file))) continue;
    for (const match of read(file).matchAll(
      /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g,
    ))
      if (!SYNTHETIC.test(match[0])) found.push(`${file}: ${match[0]}`);
  }
  return found;
}

it('P00-004 no real address is hard-coded outside the chain registry and evidence allowlist', () => {
  expect(
    hardCodedAddresses(trackedFiles(process.cwd()), (f) =>
      readFileSync(f, 'utf8'),
    ),
  ).toEqual([]);
  const real = getAddress(officialAssets.testnetAUSD.address);
  const planted = hardCodedAddresses(
    [
      'indexer/envio/.env.example',
      'packages/kernel/src/index.ts',
      'sources/research/unreviewed-provider.md',
      'reports/evidence/run.json',
      'tests/kernel/fixtures.ts',
    ],
    (file) =>
      file === 'tests/kernel/fixtures.ts'
        ? `const a = '0x${'0'.repeat(38)}0a'; const b = '0x${'1'.repeat(40)}';`
        : `TOKEN=${real}`,
  );
  expect(planted).toEqual([
    `indexer/envio/.env.example: ${real}`,
    `packages/kernel/src/index.ts: ${real}`,
    `sources/research/unreviewed-provider.md: ${real}`,
  ]);
});

it('Envio environment takes its addresses from the chain registry and the recorded deployment', () => {
  const settings = registryDeploymentSettings('sandbox/monad-testnet');
  const deployment = JSON.parse(
    readFileSync('contracts/deployments/10143.json', 'utf8'),
  );
  const receipts = JSON.parse(
    readFileSync('contracts/deployments/10143.receipts.json', 'utf8'),
  );
  expect(settings.env).toMatchObject({
    SYNQ_CHAIN_ID: '10143',
    SYNQ_START_BLOCK: String(receipts.transactions[0].blockNumber),
    SYNQ_TREASURY_ASSETS: assetForRole(
      monadTestnetProfile,
      'treasuryAsset',
    ).address.toLowerCase(),
    SYNQ_FACTORY_ADDRESS: deployment.SynqGroupFactory.toLowerCase(),
    SYNQ_REGISTRY_ADDRESS: deployment.MandateRegistry.toLowerCase(),
    SYNQ_MODULE_ADDRESS: deployment.ExecutionModule.toLowerCase(),
    SYNQ_OBSERVED_ACCOUNTS: '[]',
  });
  expect(() =>
    indexerSettings({ profileName: 'local/anvil', deployment, receipts }),
  ).toThrow('REGISTRY_INVALID');
  expect(() =>
    indexerSettings({
      profileName: 'sandbox/monad-testnet',
      deployment,
      receipts,
      localTreasuryAsset: deployment.ExecutionModule,
    }),
  ).toThrow('ASSET_REGISTRY_MISMATCH');
  expect(readFileSync('indexer/envio/.env.example', 'utf8')).toMatch(
    /^SYNQ_TREASURY_ASSETS=$/m,
  );
});

import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { expect, it } from 'vitest';
import {
  assetForRole,
  monadTestnetProfile,
  officialAssets,
} from '@synq/chain-registry';
import { envioEnvironment } from '../../scripts/envio-env.js';
import { trackedFiles } from '../../scripts/secrets.mjs';

const ALLOWED_PATHS = [
  /^sources\/chain_registry\.json$/,
  /^contracts\/(abi|deployments|evidence|lib|out)\//,
  /^reports\//,
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
  ]);
});

it('Envio environment takes its addresses from the chain registry or a recorded deployment', () => {
  expect(envioEnvironment('sandbox/monad-testnet')).toMatchObject({
    SYNQ_CHAIN_ID: '10143',
    SYNQ_TREASURY_TOKEN: assetForRole(monadTestnetProfile, 'treasuryAsset')
      .address,
  });
  const recorded = JSON.parse(
    readFileSync('reports/evidence/local-deployment.json', 'utf8'),
  );
  expect(envioEnvironment('local/anvil', recorded)).toMatchObject({
    SYNQ_CHAIN_ID: '31337',
    SYNQ_TREASURY_TOKEN: recorded.localTestToken.toLowerCase(),
    SYNQ_MODULE_ADDRESS: recorded.manifest.executionModule.toLowerCase(),
  });
  expect(() => envioEnvironment('local/anvil')).toThrow(
    'ASSET_ROLE_UNCONFIGURED',
  );
  expect(() => envioEnvironment('sandbox/monad-testnet', recorded)).toThrow(
    'REGISTRY_INVALID',
  );
  expect(readFileSync('indexer/envio/.env.example', 'utf8')).toMatch(
    /^SYNQ_TREASURY_TOKEN=$/m,
  );
});

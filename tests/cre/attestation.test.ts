import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { size, type Hex } from 'viem';
import {
  PEG,
  assessAusdRisk,
  canonicalAssetKey,
  chainlinkCreManifest,
  decodeAttestationReport,
  deviationBps,
  encodeAttestationReport,
  normalizePrice,
  riskAttestationDeployment,
  sourceConfigHash,
  validateWorkflowConfig,
  workflowConfigs,
  type FeedRound,
} from '@synq/plugin-chainlink-cre';
import { PluginManifestSchema } from '@synq/domain';
import { officialAssets } from '@synq/chain-registry';

const NOW = 1_791_645_740n;
const thresholds = {
  maxStalenessSec: 3900,
  degradedDeviationBps: 50,
  maxVenueDeviationBps: 100,
};
const round = (patch: Partial<FeedRound> = {}): FeedRound => ({
  roundId: 18446744073709559474n,
  answer: 99_983_010n,
  startedAt: NOW - 3259n,
  updatedAt: NOW - 3259n,
  answeredInRound: 18446744073709559474n,
  decimals: 8,
  ...patch,
});
const base = {
  assetId: canonicalAssetKey(143, officialAssets.mainnetAUSD.address),
  now: NOW,
  venue: null,
  thresholds,
  sourceConfigHash: sourceConfigHash({ a: 1 }) as Hex,
};

describe('AUSD risk assessment (pure, shared with the CRE workflow)', () => {
  it('reproduces the mainnet simulation: 0.99983010 USD, 3259s old → HEALTHY with 2 bps deviation', () => {
    expect(assessAusdRisk({ ...base, reference: round() })).toMatchObject({
      status: 'HEALTHY',
      referencePrice: 99_983_010n,
      deviationBps: 2,
      stalenessSec: 3259n,
    });
  });
  it('AUSD-015: a reference older than the staleness limit is STALE', () => {
    expect(
      assessAusdRisk({
        ...base,
        reference: round({ updatedAt: NOW - 3901n }),
      }),
    ).toMatchObject({ status: 'STALE', reasons: ['REFERENCE_STALE'] });
    expect(
      assessAusdRisk({
        ...base,
        reference: round({ answeredInRound: 1n }),
      }).status,
    ).toBe('STALE');
  });
  it('AUSD-016: peg deviation above the threshold is DEGRADED; no hard-coded $1', () => {
    expect(
      assessAusdRisk({ ...base, reference: round({ answer: 99_400_000n }) }),
    ).toMatchObject({
      status: 'DEGRADED',
      deviationBps: 60,
      reasons: ['PEG_DEVIATION'],
    });
    expect(
      assessAusdRisk({ ...base, reference: round({ answer: 100_500_001n }) })
        .status,
    ).toBe('DEGRADED');
    expect(
      assessAusdRisk({ ...base, reference: round({ answer: 99_500_000n }) })
        .status,
    ).toBe('HEALTHY');
  });
  it('a Kuru venue quote far from the reference degrades the attestation', () => {
    expect(
      assessAusdRisk({
        ...base,
        reference: round(),
        venue: { priceE8: 98_000_000n, source: 'kuru-flow' },
      }),
    ).toMatchObject({ status: 'DEGRADED', reasons: ['VENUE_DEVIATION'] });
    expect(
      assessAusdRisk({
        ...base,
        reference: round(),
        venue: { priceE8: 99_995_000n, source: 'kuru-flow' },
      }).status,
    ).toBe('HEALTHY');
  });
  it('missing, non-positive or future references are UNKNOWN (testnet has no AUSD feed)', () => {
    expect(
      assessAusdRisk({
        ...base,
        reference: null,
        referenceUnavailableReason: 'UNAVAILABLE_ON_TESTNET',
      }),
    ).toMatchObject({
      status: 'UNKNOWN',
      referencePrice: 0n,
      reasons: ['UNAVAILABLE_ON_TESTNET'],
    });
    for (const patch of [
      { answer: 0n },
      { answer: -1n },
      { updatedAt: NOW + 1n },
      { updatedAt: 0n },
    ])
      expect(assessAusdRisk({ ...base, reference: round(patch) }).status).toBe(
        'UNKNOWN',
      );
  });
  it('normalizes feed decimals and rounds deviation up', () => {
    expect(normalizePrice(999_830_100_000_000_000n, 18)).toBe(99_983_010n);
    expect(normalizePrice(99_983n, 5)).toBe(99_983_000n);
    expect(deviationBps(PEG + 1n, PEG)).toBe(1);
    expect(deviationBps(PEG, PEG)).toBe(0);
    expect(deviationBps(1n, 0n)).toBe(4_294_967_295);
  });
  it('encodes the 224-byte report the registry decodes, and round-trips', () => {
    const attestation = assessAusdRisk({ ...base, reference: round() });
    const encoded = encodeAttestationReport(attestation);
    expect(size(encoded)).toBe(224);
    const { reasons: _reasons, ...rest } = attestation;
    expect(decodeAttestationReport(encoded)).toEqual(rest);
    expect(() =>
      decodeAttestationReport(
        `${encoded.slice(0, 2 + 5 * 64)}${'0'.repeat(62)}09${encoded.slice(2 + 6 * 64)}` as Hex,
      ),
    ).toThrow('INVALID_STATUS');
  });
  it('source config hash is canonical (key order independent)', () => {
    expect(sourceConfigHash({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(
      sourceConfigHash({ b: [2, { d: 4, c: 3 }], a: 1 }),
    );
    expect(sourceConfigHash({ a: 1 })).not.toBe(sourceConfigHash({ a: 2 }));
  });
});

describe('CRE workflow configuration and deployment binding', () => {
  it('both configs reference only chain-registry entries of the right kind and chain', () => {
    const testnet = validateWorkflowConfig(workflowConfigs.testnet);
    expect(testnet).toMatchObject({
      isTestnet: true,
      referenceFeedRegistryKey: null,
      referenceUnavailableReason: 'UNAVAILABLE_ON_TESTNET',
      receiverDeployment: 'monad-testnet',
    });
    const mainnet = validateWorkflowConfig(workflowConfigs.mainnet);
    expect(mainnet).toMatchObject({
      isTestnet: false,
      referenceFeedRegistryKey: 'mainnetChainlinkAusdUsd',
      receiverDeployment: null,
    });
  });
  it('rejects configs that point at the wrong feed, chain or asset', () => {
    const mainnet = workflowConfigs.mainnet as Record<string, unknown>;
    for (const patch of [
      { referenceFeedRegistryKey: 'mainnetChainlinkUsdcUsd' },
      { referenceFeedRegistryKey: 'testnetChainlinkUsdcUsd' },
      { assetRegistryKey: 'mainnetUSDC' },
      { chainSelectorName: 'monad-testnet' },
      { receiverDeployment: 'monad-testnet' },
      { auxiliaryFeedRegistryKeys: ['mainnetKuruRouter'] },
      { referenceFeedRegistryKey: null },
      { extra: true },
    ])
      expect(
        () => validateWorkflowConfig({ ...mainnet, ...patch }),
        JSON.stringify(patch),
      ).toThrow();
  });
  it('the testnet deployment manifest matches the chain registry forwarder', () => {
    const deployment = riskAttestationDeployment('sandbox/monad-testnet');
    expect(deployment.forwarderKind).toBe('CRE_MOCK_FORWARDER');
    const raw = JSON.parse(
      readFileSync('contracts/deployments/10143.risk-attestation.json', 'utf8'),
    );
    expect(() =>
      riskAttestationDeployment('sandbox/monad-testnet', {
        ...raw,
        forwarder: `0x${'1'.repeat(40)}`,
      }),
    ).toThrow('drifts');
    expect(() => riskAttestationDeployment('proof/monad-mainnet')).toThrow();
  });
  it('the plugin manifest is a valid read-only manifest', () => {
    expect(PluginManifestSchema.parse(chainlinkCreManifest)).toMatchObject({
      riskClass: 'READ_ONLY',
      environments: ['sandbox/monad-testnet', 'proof/monad-mainnet'],
    });
  });
  it('the simulate wrapper refuses a mainnet broadcast before invoking cre', () => {
    const result = spawnSync(
      'bash',
      ['plugins/chainlink-cre/scripts/simulate.sh', 'mainnet', '--broadcast'],
      { encoding: 'utf8', env: { ...process.env, CRE: '/bin/false' } },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--broadcast is refused for mainnet');
  });
  it('the workflow source holds no addresses and imports the shared assessment', () => {
    const source = readFileSync(
      'plugins/chainlink-cre/synq-ausd-risk/workflow.ts',
      'utf8',
    );
    expect(source).toContain("from '../src/attestation'");
    expect(source).toContain('chain_registry.json');
    expect(source).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});

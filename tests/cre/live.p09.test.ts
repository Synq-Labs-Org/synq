import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createPublicClient, http } from 'viem';
import { monadTestnetProfile, officialAsset } from '@synq/chain-registry';
import {
  RpcRiskAttestationReader,
  canonicalAssetKey,
  riskAttestationDeployment,
  stableRiskGateConfig,
} from '@synq/plugin-chainlink-cre';
import { RiskAttestationGate } from '@synq/kernel';

const live = process.env.SYNQ_LIVE_P09 === '1';
const cre = process.env.CRE ?? `${process.env.HOME}/.cre/bin/cre`;

function simulate(network: 'testnet' | 'mainnet') {
  return spawnSync(
    'bash',
    ['plugins/chainlink-cre/scripts/simulate.sh', network],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CRE: cre,
        PATH: `${process.env.HOME}/.bun/bin:${process.env.HOME}/.cre/bin:${process.env.PATH}`,
      },
      timeout: 240_000,
    },
  );
}

describe.skipIf(!live)(
  `Chainlink CRE live suite ${live ? '' : '[set SYNQ_LIVE_P09=1]'} (SIMULATION, no broadcast)`,
  () => {
    it('mainnet simulation reads AUSD/USD and produces a HEALTHY/DEGRADED/STALE attestation report', () => {
      const run = simulate('mainnet');
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('reference mainnetChainlinkAusdUsd answer=');
      expect(run.stdout).toMatch(
        /AUSDRiskAttestation \{.*"status":"(HEALTHY|DEGRADED|STALE)"/,
      );
      expect(run.stdout).toContain('no receiver deployed for this network');
    }, 300_000);

    it('testnet simulation reports UNKNOWN (no AUSD feed on testnet) and dry-runs the write to the registry', () => {
      const run = simulate('testnet');
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain(
        'reference unavailable: UNAVAILABLE_ON_TESTNET',
      );
      expect(run.stdout).toMatch(/"status":"UNKNOWN"/);
      expect(run.stdout).toMatch(/"UNKNOWN:(none|0x[0-9a-f]{64})"/);
    }, 300_000);

    it('the Kernel gate reading the real testnet registry fails closed on the UNKNOWN attestation', async () => {
      const client = createPublicClient({
        transport: http(monadTestnetProfile.defaultRpcUrl),
      });
      const reader = new RpcRiskAttestationReader(client, {
        confirmationDepth: monadTestnetProfile.confirmationDepth,
      });
      const deployment = riskAttestationDeployment('sandbox/monad-testnet');
      const ausd = officialAsset('testnetAUSD');
      const observation = await reader.latest({
        chainId: deployment.chainId,
        registry: deployment.RiskAttestationRegistry,
        assetId: canonicalAssetKey(ausd.chainId, ausd.address),
      });
      expect(observation?.status).toBe('UNKNOWN');
      const gate = new RiskAttestationGate(
        stableRiskGateConfig('sandbox/monad-testnet', reader, 86_400),
      );
      await expect(
        gate.assess(
          {
            action: 'SPOT_TRADE',
            chainId: monadTestnetProfile.network.chainId,
            inputToken: ausd.address,
            outputToken: undefined,
          },
          Math.floor(Date.now() / 1000),
        ),
      ).rejects.toThrow('STABLE_RISK_UNAVAILABLE');
    }, 60_000);
  },
);

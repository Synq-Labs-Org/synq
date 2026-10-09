import { describe, expect, it } from 'vitest';
import { runTestnetE2E } from '../../apps/demo/src/testnet.js';

const enabled = Boolean(process.env.SYNQ_TESTNET_KEY_FILE);

describe.skipIf(!enabled)(
  'Monad testnet vertical (Mera software-PRF tier, not real humans)',
  () => {
    it('executes a 2-of-3 Mera-approved AUSD transfer and blocks pause, supersede, revoke and 1-of-3', async () => {
      const evidence = (await runTestnetE2E()) as {
        result: string;
        positive: {
          readModel: {
            balanceMatches: boolean;
            spendMatches: boolean;
            directVerifier: { consistent: boolean };
          };
          observation: { event: { tokenAmount: string } | null };
          approvals: { principalKind: string }[];
        };
        negative: {
          quorum: { oneOfThreeSignatureSimulation: string | null };
          pause: { kernelViaApi: string; onchainSimulation: string | null };
          supersede: {
            kernelVerifyOldGrant: string;
            onchainSimulationOldGrant: string | null;
          };
          revoke: {
            kernelVerifyGrant: string;
            onchainSimulation: string | null;
          };
        };
      };
      expect(evidence.result).toBe('PASS');
      expect(evidence.positive.observation.event?.tokenAmount).toBe('1500000');
      expect(evidence.positive.approvals.map((a) => a.principalKind)).toEqual([
        'MERA_HUMAN',
        'MERA_HUMAN',
      ]);
      expect(evidence.positive.readModel).toMatchObject({
        balanceMatches: true,
        spendMatches: true,
        directVerifier: { consistent: true },
      });
      expect(evidence.negative.quorum.oneOfThreeSignatureSimulation).toBe(
        'InvalidSignatures',
      );
      expect(evidence.negative.pause.kernelViaApi).not.toBe('AUTHORIZED');
      expect(evidence.negative.pause.onchainSimulation).toBe('ExecutionPaused');
      expect(evidence.negative.supersede.kernelVerifyOldGrant).not.toBe(
        'ACCEPTED',
      );
      expect(evidence.negative.supersede.onchainSimulationOldGrant).not.toBe(
        null,
      );
      expect(evidence.negative.revoke.kernelVerifyGrant).not.toBe('ACCEPTED');
      expect(evidence.negative.revoke.onchainSimulation).not.toBe(null);
    });
  },
);

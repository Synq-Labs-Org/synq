import type { Hex } from 'viem';
import { MandateSchema, type Mandate } from '@synq/schemas';
import {
  toMandateConfig,
  type AuthorizationDecision,
  type Kernel,
} from '@synq/kernel';
import { packSafeSignatures } from '@synq/execution-worker';
import type { TestnetChain } from './testnet-chain.js';
import { UNITS, errorCode, grantOf } from './testnet-config.js';
import type { DraftOutcome, transferVertical } from './vertical.js';

export async function runNegativeScenarios(ctx: {
  vertical: ReturnType<typeof transferVertical>;
  gov: ReturnType<TestnetChain['governance']>;
  kernel: Kernel;
  mandate: Mandate;
  current: { mandate: Mandate };
  onchainId: Hex;
  catchUp: (block?: bigint) => Promise<unknown>;
  sync: () => Promise<number>;
  log: (message: string) => void;
}) {
  const {
    vertical,
    gov,
    kernel,
    mandate,
    current,
    onchainId,
    catchUp,
    sync,
    log,
  } = ctx;
  const quorumProbe = await vertical.authorize(UNITS.probe, '2');
  const probeGrant = grantOf(quorumProbe.decision);
  const firstApproval = probeGrant.approvals[0]!;
  const oneOfThree = await vertical.onchainRevert(
    probeGrant,
    quorumProbe.data,
    firstApproval.signature,
  );
  const fullQuorumWhileActive = await vertical.onchainRevert(
    probeGrant,
    quorumProbe.data,
    packSafeSignatures(probeGrant.approvals, probeGrant.draft),
  );
  log(
    `1-of-3 simulation: ${oneOfThree}; 2-of-3 simulation: ${fullQuorumWhileActive ?? 'would succeed'}`,
  );

  const pauseReceipt = await gov.pause();
  await catchUp(pauseReceipt.blockNumber);
  const whilePaused = await vertical.authorize(UNITS.probe, '3');
  const pausedRevert = await vertical.onchainRevert(
    probeGrant,
    quorumProbe.data,
  );
  const unpauseReceipt = await gov.unpause();
  await catchUp(unpauseReceipt.blockNumber);
  log(
    `pause: kernel=${'code' in whilePaused.decision ? whilePaused.decision.code : whilePaused.decision.status} onchain=${pausedRevert}`,
  );

  const beforeSupersede = await vertical.authorize(UNITS.probe, '4');
  const supersededGrant = grantOf(beforeSupersede.decision);
  const v2 = MandateSchema.parse({
    ...mandate,
    version: 2,
    perActionCap: String(UNITS.perActionCap - 1_000_000n),
  });
  const supersedeReceipt = await gov.supersedeMandate(
    onchainId,
    2n,
    toMandateConfig(v2),
    true,
  );
  kernel.supersedeMandate(v2, { securitySensitive: true });
  current.mandate = v2;
  await catchUp(supersedeReceipt.blockNumber);
  await sync();
  let supersededKernel = 'ACCEPTED';
  try {
    kernel.verify(supersededGrant, beforeSupersede.intent);
  } catch (error) {
    supersededKernel = errorCode(error);
  }
  const supersededOnchain = await vertical.onchainRevert(
    supersededGrant,
    beforeSupersede.data,
  );
  const oldVersionDraft = await vertical.authorize(UNITS.probe, '7', 1);
  log(`supersede: kernel=${supersededKernel} onchain=${supersededOnchain}`);

  const beforeRevoke = await vertical.authorize(UNITS.probe, '5', 2);
  const revokedGrant = grantOf(beforeRevoke.decision);
  const revokeReceipt = await gov.revokeMandate(onchainId);
  kernel.revokeMandate(v2.groupId, v2.mandateId);
  await catchUp(revokeReceipt.blockNumber);
  await sync();
  let revokedKernel = 'ACCEPTED';
  try {
    kernel.verify(revokedGrant, beforeRevoke.intent);
  } catch (error) {
    revokedKernel = errorCode(error);
  }
  const revokedOnchain = await vertical.onchainRevert(
    revokedGrant,
    beforeRevoke.data,
  );
  const afterRevoke = await vertical.authorize(UNITS.probe, '6', 2);
  log(`revoke: kernel=${revokedKernel} onchain=${revokedOnchain}`);

  const codeOf = (d: AuthorizationDecision | DraftOutcome) =>
    d.status === 'AUTHORIZED' ? 'AUTHORIZED' : d.code;
  const negative = {
    quorum: {
      oneOfThreeSignatureSimulation: oneOfThree,
      twoOfThreeSimulationWhileActive: fullQuorumWhileActive,
    },
    pause: {
      kernelViaApi: codeOf(whilePaused.decision),
      onchainSimulation: pausedRevert,
      pauseTx: pauseReceipt.transactionHash,
      unpauseTx: unpauseReceipt.transactionHash,
    },
    supersede: {
      kernelVerifyOldGrant: supersededKernel,
      onchainSimulationOldGrant: supersededOnchain,
      newDraftAtOldVersion: codeOf(oldVersionDraft.decision),
      supersedeTx: supersedeReceipt.transactionHash,
    },
    revoke: {
      kernelVerifyGrant: revokedKernel,
      onchainSimulation: revokedOnchain,
      newIntentAfterRevoke: codeOf(afterRevoke.decision),
      revokeTx: revokeReceipt.transactionHash,
    },
  };
  const blocked =
    oneOfThree !== null &&
    fullQuorumWhileActive === null &&
    negative.pause.kernelViaApi !== 'AUTHORIZED' &&
    pausedRevert !== null &&
    supersededKernel !== 'ACCEPTED' &&
    supersededOnchain !== null &&
    negative.supersede.newDraftAtOldVersion !== 'AUTHORIZED' &&
    revokedKernel !== 'ACCEPTED' &&
    revokedOnchain !== null &&
    negative.revoke.newIntentAfterRevoke !== 'AUTHORIZED';
  if (!blocked) throw new Error('NEGATIVE_SCENARIO_NOT_BLOCKED');
  return negative;
}

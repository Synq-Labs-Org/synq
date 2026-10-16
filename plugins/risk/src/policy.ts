import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import {
  DESTINATION_COOLING_FLOOR_SECONDS,
  DESTINATION_COOLING_SECONDS,
} from './rules.js';

/**
 * Owner-signed workspace risk policy and owner-signed case resolutions.
 * A deployment object can never lower a control by itself: the value counts
 * only with an EIP-712 signature by the workspace owner, and the cooling
 * period never drops below `DESTINATION_COOLING_FLOOR_SECONDS`.
 */
export type WorkspaceRiskPolicy = Readonly<{
  workspaceId: string;
  destinationCoolingSeconds: number;
  issuedAt: number;
  signature: Hex;
}>;

export function workspacePolicyTypedData(
  p: Omit<WorkspaceRiskPolicy, 'signature'>,
  chainId: number,
) {
  return {
    domain: { name: 'Synq Workspace Risk Policy', version: '1', chainId },
    types: {
      WorkspaceRiskPolicy: [
        { name: 'workspaceId', type: 'string' },
        { name: 'destinationCoolingSeconds', type: 'uint64' },
        { name: 'issuedAt', type: 'uint64' },
      ],
    },
    primaryType: 'WorkspaceRiskPolicy' as const,
    message: {
      workspaceId: p.workspaceId,
      destinationCoolingSeconds: BigInt(p.destinationCoolingSeconds),
      issuedAt: BigInt(p.issuedAt),
    },
  };
}

/**
 * The cooling period in force: the owner-signed value (clamped to the floor)
 * when the signature recovers to one of `owners` for this workspace,
 * otherwise the 24h default.
 */
export async function coolingSecondsFor(input: {
  workspaceId: string;
  policy: WorkspaceRiskPolicy | null | undefined;
  owners: readonly Address[];
  chainId: number;
}): Promise<{ seconds: number; source: 'DEFAULT' | 'OWNER_SIGNED_POLICY' }> {
  const p = input.policy;
  if (!p || p.workspaceId !== input.workspaceId)
    return { seconds: DESTINATION_COOLING_SECONDS, source: 'DEFAULT' };
  const signer = await recoverTypedDataAddress({
    ...workspacePolicyTypedData(p, input.chainId),
    signature: p.signature,
  }).catch(() => null);
  if (
    !signer ||
    !input.owners.some((o) => o.toLowerCase() === signer.toLowerCase())
  )
    return { seconds: DESTINATION_COOLING_SECONDS, source: 'DEFAULT' };
  return {
    seconds: Math.max(
      DESTINATION_COOLING_FLOOR_SECONDS,
      Math.floor(p.destinationCoolingSeconds),
    ),
    source: 'OWNER_SIGNED_POLICY',
  };
}

/** What an owner signs to release one case hold. */
export type CaseResolution = Readonly<{
  workspaceId: string;
  caseId: string;
  /** keccak/sha of the case's flag codes at signing time (binds what was seen). */
  flagsDigest: string;
  deadline: number;
  signature: Hex;
}>;

export function caseResolutionTypedData(
  r: Omit<CaseResolution, 'signature'>,
  chainId: number,
) {
  return {
    domain: { name: 'Synq Risk Case Resolution', version: '1', chainId },
    types: {
      CaseResolution: [
        { name: 'workspaceId', type: 'string' },
        { name: 'caseId', type: 'string' },
        { name: 'flagsDigest', type: 'string' },
        { name: 'deadline', type: 'uint64' },
      ],
    },
    primaryType: 'CaseResolution' as const,
    message: {
      workspaceId: r.workspaceId,
      caseId: r.caseId,
      flagsDigest: r.flagsDigest,
      deadline: BigInt(r.deadline),
    },
  };
}

export async function recoverCaseResolver(
  r: CaseResolution,
  chainId: number,
): Promise<Address | null> {
  return recoverTypedDataAddress({
    ...caseResolutionTypedData(r, chainId),
    signature: r.signature,
  }).catch(() => null);
}

import { getAddress, type Hex } from 'viem';
import { token } from '@synq/chain-registry/arc';
import { WorkspaceError, type WorkspaceVaultSetups } from '@synq/workspaces';
import type { WorkspaceAuthority } from '@synq/workspaces/finance';
import { ArcExecutionError, verifyCode, type ArcChain } from './arc.js';
import { readCustody } from './council-payout.js';
import { readVault, SAFE_ABI } from './vault.js';

/** Rebind every operation to the factory-proven workspace, then read live custody. */
export async function readWorkspaceAuthority(
  chain: ArcChain,
  setups: WorkspaceVaultSetups,
  id: string,
): Promise<WorkspaceAuthority> {
  if (
    chain.profile.name !== 'arc-testnet' ||
    (await chain.client.getChainId()) !== chain.profile.chainId
  )
    throw new ArcExecutionError('WRONG_CHAIN');
  const setup = await setups.record(id);
  if (setup?.state !== 'ACTIVE' || !setup.evidence)
    throw new WorkspaceError('VAULT_NOT_ACTIVE');
  const { safe, policy, policyCodeHash } = setup.evidence;
  if (
    typeof safe !== 'string' ||
    typeof policy !== 'string' ||
    typeof policyCodeHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(policyCodeHash)
  )
    throw new WorkspaceError('VAULT_PROOF_MISSING');
  const vault = getAddress(safe),
    module = getAddress(policy);
  await verifyCode(chain, module, policyCodeHash as Hex);
  const [health, custody] = await Promise.all([
    readVault(chain, vault),
    readCustody(chain, vault, module),
  ]);
  if (
    !health.healthy ||
    !custody.modulesComplete ||
    custody.modules.length !== 1 ||
    custody.modules[0] !== module ||
    custody.guard !== module ||
    custody.operator?.paused
  )
    throw new WorkspaceError('VAULT_CUSTODY_UNHEALTHY');
  return {
    vault,
    policy: module,
    token: token('arc-testnet', 'USDC').address,
    policyCodeHash: policyCodeHash as Hex,
    owners: custody.owners,
    threshold: custody.threshold,
    blockNumber: custody.blockNumber,
    nonce: await chain.client.readContract({
      address: vault,
      abi: SAFE_ABI,
      functionName: 'nonce',
      blockNumber: custody.blockNumber,
    }),
  };
}

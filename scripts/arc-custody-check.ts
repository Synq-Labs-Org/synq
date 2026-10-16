/**
 * Live, read-only custody check of the registry vault on Arc testnet (ADR-002).
 *
 *   node --import tsx scripts/arc-custody-check.ts [--out <file.json>]
 *
 * Reads the Safe's threshold and owners and the policy's operator caps at one
 * block, then shows what Synq may advertise: the Safe's real M-of-N. A
 * 5-of-7 council money policy is refused unless the Safe enforces exactly it.
 * Nothing is signed or sent.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { keccak256, toHex, getAddress, type Address } from 'viem';
import { contract } from '@synq/chain-registry/arc';
import {
  GovernanceError,
  advertisedMoneyPolicy,
  assertMoneyPolicyEnforced,
  councilCustodyBinding,
  type CouncilTerm,
  type GovernancePolicy,
} from '@synq/governance';
import { connectChain, verifyCode } from '@synq/execution-worker/arc';
import { readRegistryVaultCustody } from '@synq/execution-worker/council-payout';
import { readVault } from '@synq/execution-worker/vault';

const arg = (n: string) =>
  process.argv.includes(`--${n}`)
    ? process.argv[process.argv.indexOf(`--${n}`) + 1]!
    : null;
const out =
  arg('out') ??
  join(process.cwd(), 'bounty-evidence', 'arc', 'm2-custody-check.json');

const chain = await connectChain('arc-testnet');
const safeEntry = contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE');
const policyEntry = contract('arc-testnet', 'SYNQ_ARC_VAULT_POLICY');
await verifyCode(chain, safeEntry.address, safeEntry.codeHash);
await verifyCode(chain, policyEntry.address, policyEntry.codeHash);
const health = await readVault(chain, safeEntry.address);
const custody = await readRegistryVaultCustody(chain);

// The example community council: 7 seats, 5-of-7 (seat holders are labels, not keys).
const seat = (i: number) =>
  getAddress(
    `0x${keccak256(toHex(`m2-council-seat-${i}`)).slice(26)}`,
  ) as Address;
const policy: GovernancePolicy = {
  policyId: 'pol_m2_custody_check',
  version: 1,
  workspaceId: 'wsp_m2_custody_check',
  chainId: chain.profile.chainId,
  quorumBps: 5_000,
  approvalBps: 6_000,
  minYesOfEligibleBps: 3_000,
  votingPeriodSeconds: 7 * 86_400,
  challengeWindowSeconds: 2 * 86_400,
  maxDelegationDepth: 3,
  concentrationFlagBps: 1_000,
  councilSize: 7,
  councilThreshold: 5,
  termSeconds: 365 * 86_400,
  termsHash: keccak256(toHex('m2 custody check')),
};
const now = Math.floor(Date.now() / 1000);
const term: CouncilTerm = {
  councilId: 'cnc_m2_custody_check',
  workspaceId: policy.workspaceId,
  chainId: policy.chainId,
  termId: 1,
  seats: Array.from({ length: 7 }, (_, i) => ({
    seatId: `seat-${i}`,
    holder: seat(i),
  })),
  threshold: 5,
  startsAt: now - 60,
  endsAt: now + 300 * 86_400,
};
const refusal = (() => {
  try {
    assertMoneyPolicyEnforced({ threshold: 5, of: 7 }, custody);
    return null;
  } catch (e) {
    return e instanceof GovernanceError
      ? { code: e.code, message: e.message }
      : String(e);
  }
})();
assertMoneyPolicyEnforced(
  { threshold: custody.threshold, of: custody.owners.length },
  custody,
);
const evidence = {
  label: 'LIVE_ARC_TESTNET',
  kind: 'read-only custody check (no transaction)',
  at: new Date().toISOString(),
  chainId: custody.chainId,
  blockNumber: String(custody.blockNumber),
  safe: custody.safe,
  policy: policyEntry.address,
  vaultHealthy: health.healthy,
  vaultProblems: health.problems,
  onChain: {
    threshold: custody.threshold,
    owners: custody.owners,
    operator: custody.operator && {
      ...custody.operator,
      perPaymentCap: String(custody.operator.perPaymentCap),
      windowCap: String(custody.operator.windowCap),
    },
  },
  councilBinding: councilCustodyBinding(term, policy, custody),
  advertised: advertisedMoneyPolicy(custody, { term, policy }),
  claim5of7: refusal
    ? {
        refused: true,
        ...(typeof refusal === 'object' ? refusal : { message: refusal }),
      }
    : { refused: false },
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
if (!refusal) throw new Error('a 5-of-7 claim was not refused');

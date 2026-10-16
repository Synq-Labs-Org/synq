/**
 * Real Arc testnet proof of the payment authority boundary.
 *
 *   node --import tsx scripts/arc-granted-payout.ts [--amount 0.05] [--fund 1]
 *
 * Principals (all testnet-only keys under ~/.synq):
 *   owner      testnet.key          freelancer wallet; signs the mandate, funds the agent wallet
 *   agent      arc-agent.key        delegated operational wallet; pays only under Kernel grants
 *   contractor arc-contractor.key   allow-listed payee
 * Steps: owner funds agent (if needed) → owner signs mandate → Kernel decides a
 * contractor payout → executor admits the grant and pays → reconcile; then the
 * same payout to an unverified address is denied by the Kernel, and a valid
 * grant replayed against a changed recipient is refused before signing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal, moneyToDecimal } from '@synq/domain';
import { token } from '@synq/chain-registry/arc';
import {
  decide,
  mandateTypedData,
  type PaymentMandate,
} from '@synq/kernel/arc';
import {
  balanceOf,
  connectChain,
  executeGrantedTransfer,
  executeTransfer,
  prepareTransfer,
} from '@synq/execution-worker/arc';
import { scriptFences } from './lib/script-fences.js';

const home = `${process.env.HOME}/.synq`;
const keyOf = (file: string, create = false): Hex => {
  const path = join(home, file);
  if (!existsSync(path) && create)
    writeFileSync(path, generatePrivateKey() + '\n', { mode: 0o600 });
  const k = readFileSync(path, 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1]! : d;
};

const owner = privateKeyToAccount(keyOf('testnet.key'));
const agent = privateKeyToAccount(keyOf('arc-agent.key', true));
const contractor = privateKeyToAccount(keyOf('arc-contractor.key'));
const unverified = privateKeyToAccount(generatePrivateKey()).address; // e.g. an address pasted in chat
const chain = await connectChain('arc-testnet');
const usdc = token('arc-testnet', 'USDC');
const amount = moneyFromDecimal(usdc, arg('amount', '0.05'));
const out: Record<string, unknown> = {
  environment: 'ARC_TESTNET',
  owner: owner.address,
  agent: agent.address,
  contractor: contractor.address,
  unverified,
};

// 1. Owner funds the agent's operational wallet (a capped float, not the treasury).
const float = moneyFromDecimal(usdc, arg('fund', '1'));
if (
  (await balanceOf(chain, usdc, agent.address)).baseUnits <
  amount.baseUnits * 3n
) {
  const funded = await executeTransfer(chain, owner, {
    from: owner.address,
    to: agent.address,
    amount: float,
  });
  out.agentFunding = {
    hash: funded.hash,
    explorer: funded.explorer,
    amount: moneyToDecimal(float),
  };
}

// 2. Owner signs the mandate: agent may pay the contractor only, ≤ 0.10 per payout, ≤ 0.50 / 30 days.
const now = Math.floor(Date.now() / 1000);
const mandate: PaymentMandate = {
  mandateId: `mnd_${randomBytes(6).toString('hex')}`,
  version: 1,
  workspaceId: 'wsp_freelancer_demo',
  owner: owner.address,
  chainId: usdc.chainId,
  token: usdc.address,
  payer: agent.address,
  recipients: [contractor.address],
  purposes: ['CONTRACTOR_PAYOUT'],
  perActionCap: moneyFromDecimal(usdc, '0.10').baseUnits,
  periodBudget: moneyFromDecimal(usdc, '0.50').baseUnits,
  periodSeconds: 30 * 86_400,
  validFrom: now - 60,
  validUntil: now + 7 * 86_400,
};
const mandateSignature = await owner.signTypedData(mandateTypedData(mandate));
const config = {
  grantKey: randomBytes(32),
  operator: 'arc-executor',
  grantTtlSeconds: 120,
  riskRequiredAbove: moneyFromDecimal(usdc, '50').baseUnits,
};
// Durable (Postgres) when SYNQ_EXECUTION_DATABASE_URL is set; otherwise the
// script says so and records `fenceDurable: false` in its evidence.
const fences = await scriptFences('arc-granted-payout', mandate.mandateId);
const fence = fences.grants;
const intentFor = (recipient: `0x${string}`, intentId: string) => ({
  intentId,
  mandateId: mandate.mandateId,
  mandateVersion: 1,
  chainId: usdc.chainId,
  token: usdc.address,
  payer: agent.address,
  recipient,
  amount: amount.baseUnits,
  purpose: 'CONTRACTOR_PAYOUT' as const,
  obligationRef: 'payable:design-milestone-2',
  evidenceHash: `0x${randomBytes(32).toString('hex')}` as Hex,
  proposedBy: 'agent:payments',
});

// 3. Legitimate payout: simulate first (prepare), then decide, then execute under the grant.
await prepareTransfer(chain, {
  from: agent.address,
  to: contractor.address,
  amount,
});
const allowed = await decide({
  config,
  mandate,
  mandateSignature,
  state: { revoked: false, spends: [] },
  intent: intentFor(contractor.address, 'int_payout_ok'),
  risk: { available: true, flags: [] },
  simulationOk: true,
  now,
});
if (allowed.outcome !== 'ALLOW')
  throw new Error(`expected ALLOW: ${allowed.reasons.join('; ')}`);
const before = await balanceOf(chain, usdc, contractor.address);
const paid = await executeGrantedTransfer({
  chain,
  signer: agent,
  grant: allowed.grant,
  grantKey: config.grantKey,
  fence,
  mandateRevoked: false,
  transfer: { from: agent.address, to: contractor.address, amount },
  now: Math.floor(Date.now() / 1000),
});
const after = await balanceOf(chain, usdc, contractor.address);
out.payout = {
  decision: allowed.outcome,
  reasons: allowed.reasons,
  grantId: allowed.grant.grantId,
  hash: paid.hash,
  block: String(paid.blockNumber),
  explorer: paid.explorer,
  amount: moneyToDecimal(amount),
  contractorBefore: moneyToDecimal(before),
  contractorAfter: moneyToDecimal(after),
  creditedExactly: after.baseUnits - before.baseUnits === amount.baseUnits,
  feeUsdc: paid.feeUsdc && moneyToDecimal(paid.feeUsdc),
};

// 4. Fraud: same payout to an address that is not the verified contractor wallet.
const redirected = await decide({
  config,
  mandate,
  mandateSignature,
  state: { revoked: false, spends: [{ amount: amount.baseUnits, at: now }] },
  intent: intentFor(unverified, 'int_payout_redirected'),
  risk: {
    available: true,
    flags: [
      {
        code: 'PAYOUT_ADDRESS_CHANGED',
        severity: 'HARD',
        detail: `requested ${unverified}, verified ${contractor.address}`,
      },
    ],
  },
  simulationOk: true,
  now,
});
out.redirectedDecision = redirected;

// 5. Even with a real grant in hand, signing a changed recipient is refused before broadcast.
const second = await decide({
  config,
  mandate,
  mandateSignature,
  state: { revoked: false, spends: [{ amount: amount.baseUnits, at: now }] },
  intent: intentFor(contractor.address, 'int_payout_2'),
  risk: { available: true, flags: [] },
  simulationOk: true,
  now,
});
if (second.outcome !== 'ALLOW') throw new Error('expected second ALLOW');
const agentBefore = await chain.client.getTransactionCount({
  address: agent.address,
});
try {
  await executeGrantedTransfer({
    chain,
    signer: agent,
    grant: second.grant,
    grantKey: config.grantKey,
    fence,
    mandateRevoked: false,
    transfer: { from: agent.address, to: unverified, amount },
    now: Math.floor(Date.now() / 1000),
  });
  out.mutatedRecipient = 'EXECUTED (unexpected)';
} catch (e) {
  out.mutatedRecipient = {
    refused: (e as { code?: string }).code,
    nonceUnchanged:
      (await chain.client.getTransactionCount({ address: agent.address })) ===
      agentBefore,
  };
}
out.fenceDurable = fences.durable;
out.mandate = {
  ...mandate,
  perActionCap: String(mandate.perActionCap),
  periodBudget: String(mandate.periodBudget),
};
const dir = join(process.cwd(), 'bounty-evidence', 'arc');
mkdirSync(dir, { recursive: true });
const file = join(dir, `granted-payout-${paid.hash.slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
console.log(`evidence -> ${file}`);
await fences.close();

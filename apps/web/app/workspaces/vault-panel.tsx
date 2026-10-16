'use client';

import { useEffect, useState } from 'react';
import { formatUnits, getAddress, parseUnits } from 'viem';
import { z } from 'zod';
import {
  VaultSetupSchema,
  vaultSetupTypedData,
} from '@synq/kernel/arc-vault-setup';
import { api, ApiFailure, describeError } from '../../lib/api';

const ProposalSchema = z.strictObject({
  setup: VaultSetupSchema,
  setupHash: z.string(),
  state: z.enum([
    'AWAITING_SIGNATURES',
    'READY',
    'ACTIVE',
    'REVERTED',
    'NEEDS_REVIEW',
  ]),
  signedOwners: z.array(z.string()),
  typedData: z.record(z.string(), z.unknown()),
  evidence: z.record(z.string(), z.unknown()).nullable(),
  lastError: z.string().nullable(),
});
const ResponseSchema = z.strictObject({ proposal: ProposalSchema.nullable() });
type Proposal = z.output<typeof ProposalSchema>;
type Provider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
};
export function VaultPanel({
  workspaceId,
  onActivated,
}: {
  workspaceId: string;
  onActivated(): void;
}) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [threshold, setThreshold] = useState('');
  const [paymentCap, setPaymentCap] = useState('5');
  const [windowCap, setWindowCap] = useState('20');
  const [reviewed, setReviewed] = useState(false);
  const base = `/v2/workspaces/${encodeURIComponent(workspaceId)}/vault/setup`;
  useEffect(() => {
    let active = true;
    setProposal(null);
    setReviewed(false);
    setBusy(true);
    setError(null);
    setBlocked(false);
    const poll = async () => {
      try {
        const result = await api.get(base, ResponseSchema);
        if (active) {
          setProposal(result.proposal);
          setError(null);
        }
      } catch (e) {
        if (active) {
          if (e instanceof ApiFailure && e.code === 'VAULT_CREATION_BLOCKED')
            setBlocked(true);
          else setError(describeError(e));
        }
      } finally {
        if (active) setBusy(false);
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [base]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  async function propose() {
    await run(async () => {
      const exact = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;
      if (!exact.test(paymentCap) || !exact.test(windowCap))
        throw new Error('Use exact USDC amounts with at most six decimals');
      const r = await api.post(base, ResponseSchema, {
        perPaymentCap: String(parseUnits(paymentCap, 6)),
        windowCap: String(parseUnits(windowCap, 6)),
        ...(threshold ? { threshold: Number(threshold) } : {}),
      });
      setProposal(r.proposal);
      setReviewed(false);
    });
  }
  async function sign() {
    if (!proposal || !reviewed) return;
    await run(async () => {
      const provider = (window as unknown as { ethereum?: Provider }).ethereum;
      if (!provider) throw new Error('Wallet unavailable');
      const wallets = z
        .array(z.string())
        .min(1)
        .parse(await provider.request({ method: 'eth_requestAccounts' }));
      const wallet = getAddress(wallets[0]!);
      if (!proposal.setup.owners.includes(wallet)) {
        setError('Connect the wallet listed as your proposed Safe owner.');
        return;
      }
      if (Date.now() / 1000 >= proposal.setup.expiresAt) {
        setError(
          'This setup proposal has expired. It cannot be signed or executed.',
        );
        return;
      }
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${proposal.setup.chainId.toString(16)}` }],
      });
      const typed = vaultSetupTypedData(proposal.setup);
      const signature = z
        .string()
        .regex(/^0x[0-9a-fA-F]{130}$/)
        .parse(
          await provider.request({
            method: 'eth_signTypedData_v4',
            params: [
              wallet,
              JSON.stringify(typed, (_key, value) =>
                typeof value === 'bigint' ? String(value) : value,
              ),
            ],
          }),
        );
      const r = await api.post(`${base}/approve`, ResponseSchema, {
        signature,
      });
      setProposal(r.proposal);
      setReviewed(false);
    });
  }
  return (
    <section>
      <h2>Vault setup</h2>
      {busy && <p role="status">Loading vault setup…</p>}
      {error && <p role="alert">{error}</p>}
      {blocked ? (
        <p>
          Vault creation is blocked: sponsored execution is not configured. No
          vault or test balance has been created.
        </p>
      ) : !proposal ? (
        <>
          <p>
            Every proposed owner signs the exact setup. The Safe threshold
            controls later owner transactions; the operator can only pay
            allowlisted recipients within the signed caps. The initial allowlist
            is empty.
          </p>
          <label htmlFor="vault-threshold">
            Safe threshold (blank uses group default)
          </label>
          <input
            id="vault-threshold"
            inputMode="numeric"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
          <label htmlFor="vault-payment-cap">
            Operator payment cap · testnet USDC
          </label>
          <input
            id="vault-payment-cap"
            inputMode="decimal"
            value={paymentCap}
            onChange={(e) => setPaymentCap(e.target.value)}
          />
          <label htmlFor="vault-window-cap">
            Operator 24-hour cap · testnet USDC
          </label>
          <input
            id="vault-window-cap"
            inputMode="decimal"
            value={windowCap}
            onChange={(e) => setWindowCap(e.target.value)}
          />
          <button disabled={busy} onClick={() => void propose()}>
            Prepare setup for review
          </button>
        </>
      ) : (
        <>
          <p>{proposal.state} · Arc testnet</p>
          <p>
            {proposal.setup.threshold} of {proposal.setup.owners.length} Safe
            owner signatures for later owner transactions. Setup itself requires
            all {proposal.setup.owners.length} owners.
          </p>
          <ul>
            {proposal.setup.owners.map((o) => (
              <li key={o}>
                {o} ·{' '}
                {proposal.signedOwners.some(
                  (s) => s.toLowerCase() === o.toLowerCase(),
                )
                  ? 'Setup signed'
                  : 'Setup signature pending'}
              </li>
            ))}
          </ul>
          <p>Operator: {proposal.setup.operator}</p>
          <p>
            Per payment: {formatUnits(BigInt(proposal.setup.perPaymentCap), 6)}{' '}
            USDC. Per 24 hours:{' '}
            {formatUnits(BigInt(proposal.setup.windowCap), 6)} USDC. Initial
            payee allowlist: empty.
          </p>
          <p>
            Governance delay: {proposal.setup.delay} seconds. Sponsor gas
            ceiling: {formatUnits(BigInt(proposal.setup.maxGasNativeWei), 18)}{' '}
            native testnet USDC.
          </p>
          <p>Factory: {proposal.setup.factory}</p>
          <p>
            Setup expires:{' '}
            {new Date(proposal.setup.expiresAt * 1000).toLocaleString()}
          </p>
          {proposal.lastError && (
            <p role="status">
              Execution is held: {proposal.lastError}. No replacement
              transaction is signed for an uncertain outcome.
            </p>
          )}
          {proposal.state === 'AWAITING_SIGNATURES' && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />{' '}
                I reviewed the owners, threshold, caps and gas ceiling.
              </label>
              <button disabled={busy || !reviewed} onClick={() => void sign()}>
                Sign vault setup in my wallet
              </button>
            </>
          )}
          {proposal.state === 'READY' && (
            <p>
              All setup signatures are recorded. Waiting for the bounded testnet
              execution worker and receipt reconciliation.
            </p>
          )}
          {proposal.state === 'ACTIVE' && (
            <>
              <p>
                Vault creation confirmed. Funding requires a separate transfer
                from your wallet.
              </p>
              <button disabled={busy} onClick={onActivated}>
                Refresh workspace
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}

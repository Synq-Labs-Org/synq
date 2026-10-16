'use client';
import { useEffect, useState } from 'react';
import { formatUnits, getAddress, parseUnits } from 'viem';
import { z } from 'zod';
import {
  policyTypedData,
  mandateFromPolicy,
} from '@synq/allocations/policy-data';
import { mandateTypedData } from '@synq/kernel/arc-payment-data';
import { FinanceViewSchema } from '@synq/workspaces/finance-contracts';
import {
  RevenuePolicyViewSchema,
  WorkspaceAllocationViewSchema,
  revenueRevocationTypedData,
} from '@synq/workspaces/revenue-contracts';
import { api, describeError } from '../../lib/api';

const Allocations = z.strictObject({
  allocations: z.array(WorkspaceAllocationViewSchema),
});
const List = z.strictObject({ policies: z.array(RevenuePolicyViewSchema) });
type Policy = z.output<typeof RevenuePolicyViewSchema>;
async function sign(typed: object) {
  const provider = (
    window as unknown as {
      ethereum?: {
        request(i: { method: string; params?: unknown[] }): Promise<unknown>;
      };
    }
  ).ethereum;
  if (!provider) throw new Error('Connect a workspace owner wallet.');
  const accounts = z
    .array(z.string())
    .min(1)
    .parse(await provider.request({ method: 'eth_requestAccounts' }));
  await provider.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: '0x4cef52' }],
  });
  return z
    .string()
    .regex(/^0x[0-9a-fA-F]{130}$/)
    .parse(
      await provider.request({
        method: 'eth_signTypedData_v4',
        params: [
          getAddress(accounts[0]!),
          JSON.stringify(typed, (_k, v: unknown) =>
            typeof v === 'bigint' ? String(v) : v,
          ),
        ],
      }),
    );
}
export function RevenuePanel({
  workspaceId,
  vault,
  owner,
}: {
  workspaceId: string;
  vault: string;
  owner: boolean;
}) {
  const base = `/v2/workspaces/${encodeURIComponent(workspaceId)}`;
  const [allocations, setAllocations] = useState<
    z.output<typeof Allocations>['allocations']
  >([]);
  const [policies, setPolicies] = useState<Policy[]>([]),
    [selected, setSelected] = useState<Policy | null>(null);
  const [vendors, setVendors] = useState<
    z.output<typeof FinanceViewSchema>['vendors']
  >([]);
  const [tax, setTax] = useState('0'),
    [floor, setFloor] = useState(''),
    [cap, setCap] = useState(''),
    [daily, setDaily] = useState('');
  const [frequency, setFrequency] = useState(''),
    [days, setDays] = useState(''),
    [horizon, setHorizon] = useState('7');
  const [rows, setRows] = useState([
    {
      id: crypto.randomUUID(),
      vendorId: '',
      kind: 'PERCENT_OF_SURPLUS',
      value: '',
      label: '',
    },
  ]);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [reviewed, setReviewed] = useState(false);
  const refresh = async () => {
    const result = await api.get(`${base}/revenue-policies`, List);
    setPolicies(result.policies);
    setSelected((v) =>
      v ? (result.policies.find((p) => p.id === v.id) ?? null) : null,
    );
  };
  useEffect(() => {
    let active = true;
    Promise.all([
      api.get(`${base}/revenue-policies`, List),
      api.get(`${base}/finance`, FinanceViewSchema),
    ])
      .then(([p, f]) => {
        if (active) {
          setPolicies(p.policies);
          setVendors(f.vendors);
        }
      })
      .catch((e) => {
        if (active) setError(describeError(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [base]);
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const r = await api.get(`${base}/allocations`, Allocations);
        if (active) setAllocations(r.allocations);
      } catch (e) {
        if (active) setError(describeError(e));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 10000);
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
  const units = (s: string) => {
    if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(s))
      throw new Error('Enter USDC with at most six decimal places.');
    return String(parseUnits(s, 6));
  };
  const integer = (s: string) => {
    if (!/^(0|[1-9][0-9]*)$/.test(s)) throw new Error('Enter a whole number.');
    return Number(s);
  };
  const money = (v: bigint) => `${formatUnits(v, 6)} USDC`;
  return (
    <section>
      <h2>Automatic revenue rules</h2>
      <p>
        Arc testnet. The current Safe quorum signs the rules and the exact
        payment mandate. Tax and operating reserves stay in the vault. Transfers
        require current verification, screening, limits and Kernel
        authorization.
      </p>
      {loading && <p role="status">Loading revenue rules…</p>}
      {error && <p role="alert">{error}</p>}
      {owner && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const distributions = rows.map((r) => ({
                kind: r.kind,
                beneficiaryId: r.vendorId,
                label: r.label,
                ...(r.kind === 'FIXED'
                  ? { amount: units(r.value) }
                  : { bps: integer(r.value) }),
              }));
              const result = await api.post(
                `${base}/revenue-policies`,
                RevenuePolicyViewSchema,
                {
                  taxReserveBps: integer(tax),
                  operatingFloor: units(floor),
                  obligationHorizonDays: integer(horizon),
                  vendorIds: [...new Set(rows.map((r) => r.vendorId))],
                  distributions,
                  validForSeconds: integer(days) * 86400,
                  limits: {
                    maxAutonomousPerLeg: units(cap),
                    maxAutonomousPerWindow: units(daily),
                    windowSeconds: 86400,
                    maxSplitsPerWindow: integer(frequency),
                  },
                },
              );
              await refresh();
              setSelected(result);
              setReviewed(false);
            });
          }}
        >
          <fieldset disabled={busy}>
            <label>
              Tax estimate reserve (basis points; 100 = 1%)
              <input
                value={tax}
                onChange={(e) => setTax(e.target.value)}
                required
                inputMode="numeric"
              />
            </label>
            <label>
              Operating floor (USDC)
              <input
                value={floor}
                onChange={(e) => setFloor(e.target.value)}
                required
                inputMode="decimal"
              />
            </label>
            <label>
              Maximum transfer (USDC)
              <input
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                required
                inputMode="decimal"
              />
            </label>
            <label>
              Maximum automatic transfers per 24 hours (USDC)
              <input
                value={daily}
                onChange={(e) => setDaily(e.target.value)}
                required
                inputMode="decimal"
              />
            </label>
            <label>
              Maximum receipts allocated per 24 hours
              <input
                value={frequency}
                onChange={(e) => setFrequency(e.target.value)}
                required
                inputMode="numeric"
              />
            </label>
            <label>
              Rule validity (days, at most 30)
              <input
                value={days}
                onChange={(e) => setDays(e.target.value)}
                required
                inputMode="numeric"
              />
            </label>
            <label>
              Upcoming obligations horizon (days)
              <input
                value={horizon}
                onChange={(e) => setHorizon(e.target.value)}
                required
                inputMode="numeric"
              />
            </label>
            {rows.map((r) => (
              <fieldset key={r.id}>
                <legend>Distribution</legend>
                <label>
                  Verified beneficiary
                  <select
                    value={r.vendorId}
                    required
                    onChange={(e) =>
                      setRows(
                        rows.map((x) =>
                          x.id === r.id
                            ? { ...x, vendorId: e.target.value }
                            : x,
                        ),
                      )
                    }
                  >
                    <option value="">Choose a verified vendor</option>
                    {vendors
                      .filter((v) => v.status === 'VERIFIED')
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} · {v.address}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Label
                  <input
                    value={r.label}
                    required
                    maxLength={80}
                    onChange={(e) =>
                      setRows(
                        rows.map((x) =>
                          x.id === r.id ? { ...x, label: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Rule
                  <select
                    value={r.kind}
                    onChange={(e) =>
                      setRows(
                        rows.map((x) =>
                          x.id === r.id
                            ? { ...x, kind: e.target.value, value: '' }
                            : x,
                        ),
                      )
                    }
                  >
                    <option value="PERCENT_OF_SURPLUS">
                      Share of surplus after reserves
                    </option>
                    <option value="FIXED">
                      Fixed amount from each receipt
                    </option>
                  </select>
                </label>
                <label>
                  {r.kind === 'FIXED'
                    ? 'Amount (USDC)'
                    : 'Share (basis points; 10,000 = 100%)'}
                  <input
                    value={r.value}
                    required
                    onChange={(e) =>
                      setRows(
                        rows.map((x) =>
                          x.id === r.id ? { ...x, value: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </label>
                {rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setRows(rows.filter((x) => x.id !== r.id))}
                  >
                    Remove distribution
                  </button>
                )}
              </fieldset>
            ))}
            <button
              type="button"
              disabled={rows.length >= 10}
              onClick={() =>
                setRows([
                  ...rows,
                  {
                    id: crypto.randomUUID(),
                    vendorId: '',
                    kind: 'PERCENT_OF_SURPLUS',
                    value: '',
                    label: '',
                  },
                ])
              }
            >
              Add distribution
            </button>
            <button type="submit">Propose rules for review</button>
          </fieldset>
        </form>
      )}
      {!loading && !policies.length && (
        <p>
          No signed revenue rules. Incoming funds remain in the vault until
          authorized.
        </p>
      )}
      {policies.map((p) => (
        <button
          type="button"
          key={p.id}
          disabled={busy}
          onClick={() => {
            setSelected(p);
            setReviewed(false);
          }}
        >
          Version {p.policy.version} · {p.state}
        </button>
      ))}
      {selected && (
        <article>
          <h3>
            Review version {selected.policy.version} · {selected.state}
          </h3>
          <p>
            Workspace {selected.policy.workspaceId} · Arc chain{' '}
            {selected.policy.chainId}. Vault {selected.policy.treasury}. Token{' '}
            {selected.policy.token}.
          </p>
          <p>
            Tax estimate {selected.policy.taxReserveBps} basis points. Operating
            floor {money(selected.policy.operatingFloor)}. Maximum transfer{' '}
            {money(selected.policy.limits.maxAutonomousPerLeg)}; maximum per 24
            hours {money(selected.policy.limits.maxAutonomousPerWindow)} across{' '}
            {selected.policy.limits.maxSplitsPerWindow} receipts.
          </p>
          <p>
            Valid {new Date(selected.policy.validFrom * 1000).toLocaleString()}{' '}
            through{' '}
            {new Date(selected.policy.validUntil * 1000).toLocaleString()}.
            Upcoming obligations: {selected.policy.obligationHorizonDays} days.
            Remainder stays in the vault. Unknown payments require
            reconciliation and review.
          </p>
          {selected.policy.allowedBeneficiaries.map((b) => (
            <p key={b.beneficiaryId}>
              {b.label}: {b.address}
            </p>
          ))}
          {selected.policy.distributions.map((d, i) => (
            <p key={i}>
              {d.label}:{' '}
              {d.kind === 'FIXED'
                ? money(d.amount)
                : `${d.bps} basis points of surplus`}{' '}
              → {d.beneficiaryId}
            </p>
          ))}
          <p>
            Signed by {selected.signedBy.length} owners. Revocation signed by{' '}
            {selected.revokedBy.length} owners.
          </p>
          {owner && ['REVIEW', 'ACTIVE'].includes(selected.state) && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I reviewed the exact rules, beneficiaries, validity and limits.
              </label>
              <button
                type="button"
                disabled={
                  busy ||
                  !reviewed ||
                  selected.policy.treasury.toLowerCase() !== vault.toLowerCase()
                }
                onClick={() =>
                  void run(async () => {
                    const body =
                      selected.state === 'REVIEW'
                        ? {
                            policy: await sign(
                              policyTypedData(selected.policy),
                            ),
                            mandate: await sign(
                              mandateTypedData(
                                mandateFromPolicy(selected.policy),
                              ),
                            ),
                          }
                        : {
                            signature: await sign(
                              revenueRevocationTypedData(selected.policy),
                            ),
                          };
                    const result = await api.post(
                      `${base}/revenue-policies/${selected.id}/${selected.state === 'REVIEW' ? 'approve' : 'revoke'}`,
                      RevenuePolicyViewSchema,
                      body,
                    );
                    await refresh();
                    setSelected(result);
                    setReviewed(false);
                  })
                }
              >
                {selected.state === 'REVIEW'
                  ? 'Sign rules and mandate'
                  : 'Sign revocation'}
              </button>
              {selected.state === 'ACTIVE' && (
                <p>
                  Revocation requires the current quorum. Already signed
                  transactions still reconcile.
                </p>
              )}
            </>
          )}
        </article>
      )}
      <h3>Incoming payment allocations</h3>
      {!loading && !allocations.length && (
        <p>No invoice receipts have been allocated.</p>
      )}
      {allocations.map((a) => (
        <article key={a.id}>
          <p>
            {a.invoiceId} ·{' '}
            {a.receiptReview ? 'PAYMENT PROOF NEEDS REVIEW' : a.state} ·{' '}
            {money(BigInt(a.received))} received · rules version{' '}
            {a.policyVersion}
          </p>
          <a
            href={`https://explorer.testnet.arc.io/tx/${a.receiptTx}`}
            target="_blank"
            rel="noreferrer"
          >
            Incoming receipt
          </a>
          {a.legs.map((l, i) => (
            <p key={i}>
              {l.purpose} · {money(BigInt(l.amount))} · {l.state}
              {l.recipient ? ` → ${l.recipient}` : ''}
              {l.txHash && (
                <>
                  {' '}
                  ·{' '}
                  <a
                    href={`https://explorer.testnet.arc.io/tx/${l.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Transfer receipt
                  </a>
                </>
              )}
            </p>
          ))}
        </article>
      ))}
    </section>
  );
}

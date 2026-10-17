'use client';

import { useState } from 'react';
import { isAddress } from 'viem';
import {
  AmaneAccountSchema,
  AmaneJobListSchema,
  AmaneJobSchema,
  AmaneLeaseRegisteredSchema,
  MandatesSchema,
} from '@synq/contracts';
import { formatAmount, shortDate, toBaseUnits } from '../../../../../lib/money';
import { describeV3, seg, v3 } from '../../../../../lib/v3';
import { useLiveRefresh, useV3 } from '../../../../_hub/hooks';
import {
  Async,
  Empty,
  Hash,
  Notice,
  Panel,
  humanize,
} from '../../../../_hub/ui';

const USDC_DECIMALS = 6;
const LEASE_ID = /^0x[0-9a-fA-F]{64}$/;
const UUID = /^[0-9a-fA-F-]{36}$/;

function TextField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  inputMode?: 'decimal';
  maxLength?: number;
  list?: string;
}) {
  return (
    <div className="hub-field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type="text"
        inputMode={props.inputMode}
        maxLength={props.maxLength}
        list={props.list}
        autoComplete="off"
        spellCheck={false}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        aria-describedby={props.hint ? `${props.id}-hint` : undefined}
      />
      {props.hint && <small id={`${props.id}-hint`}>{props.hint}</small>}
    </div>
  );
}

/** Runs one POST with busy, error and success state; the form decides what to send. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return {
    busy,
    error,
    done,
    fail: (message: string) => {
      setError(message);
      setDone(null);
    },
    run: async (work: () => Promise<string>) => {
      setBusy(true);
      setError(null);
      setDone(null);
      try {
        setDone(await work());
      } catch (e) {
        setError(describeV3(e));
      } finally {
        setBusy(false);
      }
    },
  };
}

function Result({ a }: { a: ReturnType<typeof useAction> }) {
  return (
    <>
      {a.error && <Notice tone="danger">{a.error}</Notice>}
      {a.done && (
        <Notice tone="positive" live>
          {a.done}
        </Notice>
      )}
    </>
  );
}

export function AgentPayments({ workspaceId }: { workspaceId: string }) {
  const base = `/v3/workspaces/${seg(workspaceId)}`;
  const mandates = useV3(`${base}/mandates`, MandatesSchema);
  const enabled = mandates.data
    ? mandates.data.capability.status !== 'NOT_CONFIGURED'
    : false;
  const jobs = useV3(enabled ? `${base}/amane/jobs` : null, AmaneJobListSchema);
  const reloadAll = async () => {
    await mandates.reload();
    await jobs.reload();
  };
  useLiveRefresh(reloadAll, { types: ['AGENT_EVENT', 'BALANCE_CHANGED'] });

  const [account, setAccount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [leaseId, setLeaseId] = useState('');
  const [jobLease, setJobLease] = useState('');
  const [trigger, setTrigger] = useState<'INVOICE_PAID' | 'OWNER_REQUEST'>(
    'OWNER_REQUEST',
  );
  const [ref, setRef] = useState('');
  const [amount, setAmount] = useState('');
  const [purpose, setPurpose] = useState('');
  const registerAccount = useAction();
  const registerLease = useAction();
  const createJob = useAction();

  return (
    <Panel
      title="Agent payments"
      id="agent-payments"
      note="The agent pays contractors without asking you to sign each time, but only inside a lease you signed on chain. The lease fixes the recipient, the token, a limit per payment and an expiry. Registering something here only records what the chain already enforces; it grants no new power and moves no money by itself."
    >
      <Async state={mandates}>
        {(m) => (
          <>
            <h3>Status</h3>
            <p>
              <span className="hub-status">
                {humanize(m.capability.status)}
              </span>{' '}
              {m.capability.reason}
            </p>
            {m.capability.status === 'NOT_CONFIGURED' && (
              <Notice tone="warning">
                Not configured means this server has no agent key, so it cannot
                send agent payments at all. Nothing below will work until the
                operator configures one.
              </Notice>
            )}

            <h3>Leases</h3>
            {!m.leases.length ? (
              <Empty>No agent lease is registered for this workspace.</Empty>
            ) : (
              <div className="hub-table-wrap">
                <table className="hub-table">
                  <caption className="hub-sr">
                    Agent leases and their remaining limits
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Lease</th>
                      <th scope="col" className="num">
                        Per payment (USDC)
                      </th>
                      <th scope="col" className="num">
                        Remaining (USDC)
                      </th>
                      <th scope="col">Expires</th>
                      <th scope="col">State</th>
                      <th scope="col">Enforced by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {m.leases.map((l) => (
                      <tr key={l.leaseId}>
                        <th scope="row">
                          <Hash value={l.leaseId} />
                        </th>
                        <td className="num">
                          {formatAmount(l.perActionUnits, USDC_DECIMALS)}
                        </td>
                        <td className="num">
                          {formatAmount(l.availableUnits, USDC_DECIMALS)}
                        </td>
                        <td>{shortDate(l.expiresAt)}</td>
                        <td>
                          {l.revokedAt
                            ? `Revoked ${shortDate(l.revokedAt)}`
                            : 'Active'}
                          <br />
                          <small className="hub-sub">
                            {humanize(l.proofLevel)}
                          </small>
                        </td>
                        <td>
                          <Hash value={l.enforcingContract} />
                          <br />
                          <small className="hub-sub">chain {l.chainId}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Async>

      {enabled && (
        <>
          <h3>Register an Amane account</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!isAddress(account.trim()))
                return registerAccount.fail(
                  'Enter the account as a 0x address of 42 characters.',
                );
              void registerAccount.run(async () => {
                const r = await v3.post(
                  `${base}/amane/accounts`,
                  AmaneAccountSchema,
                  { account: account.trim() },
                );
                setAccountId(r.id);
                await reloadAll();
                return `Account registered. Its id is ${r.id}; it is filled in below.`;
              });
            }}
          >
            <TextField
              id="amane-account"
              label="Amane account address"
              value={account}
              onChange={setAccount}
              hint="You must control this account on chain; the server checks its code and controller."
            />
            <Result a={registerAccount} />
            <p>
              <button
                className="hub-btn hub-btn-primary"
                disabled={registerAccount.busy}
              >
                {registerAccount.busy ? 'Registering…' : 'Register account'}
              </button>
            </p>
          </form>

          <h3>Register a lease</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!UUID.test(accountId.trim()))
                return registerLease.fail(
                  'Enter the account id returned when you registered the account.',
                );
              if (!LEASE_ID.test(leaseId.trim()))
                return registerLease.fail(
                  'Enter the lease id as 0x followed by 64 hex characters.',
                );
              void registerLease.run(async () => {
                const r = await v3.post(
                  `${base}/amane/leases`,
                  AmaneLeaseRegisteredSchema,
                  { accountId: accountId.trim(), leaseId: leaseId.trim() },
                );
                setJobLease(r.leaseId);
                await reloadAll();
                return 'Lease registered. It pays only if the chain confirms the limits you signed.';
              });
            }}
          >
            <div className="hub-form-grid">
              <TextField
                id="lease-account"
                label="Account id"
                value={accountId}
                onChange={setAccountId}
              />
              <TextField
                id="lease-id"
                label="Lease id"
                value={leaseId}
                onChange={setLeaseId}
                hint="0x followed by 64 hex characters."
              />
            </div>
            <Result a={registerLease} />
            <p>
              <button
                className="hub-btn hub-btn-primary"
                disabled={registerLease.busy}
              >
                {registerLease.busy ? 'Registering…' : 'Register lease'}
              </button>
            </p>
          </form>

          <h3>Create a contractor job</h3>
          <Notice tone="info">
            Once a job is ready the agent pays it with no new signature from
            you, but only within the lease. If the lease limit, recipient or
            expiry does not allow it, the job is refused.
          </Notice>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!LEASE_ID.test(jobLease.trim()))
                return createJob.fail(
                  'Choose or enter a lease id (0x and 64 hex characters).',
                );
              const units = toBaseUnits(amount, USDC_DECIMALS);
              if (units === null || BigInt(units) <= 0n)
                return createJob.fail(
                  'Enter an amount in USDC above zero with at most 6 decimals, such as 40 or 12.50.',
                );
              if (!ref.trim() || !purpose.trim())
                return createJob.fail(
                  'Enter a trigger reference and a purpose.',
                );
              void createJob.run(async () => {
                const j = await v3.post(`${base}/amane/jobs`, AmaneJobSchema, {
                  leaseId: jobLease.trim(),
                  triggerKind: trigger,
                  triggerRef: ref.trim(),
                  amount: units,
                  purpose: purpose.trim(),
                });
                await reloadAll();
                return `Job created. State: ${humanize(j.state)}.`;
              });
            }}
          >
            <div className="hub-form-grid">
              <TextField
                id="job-lease"
                label="Lease"
                value={jobLease}
                onChange={setJobLease}
                list="known-leases"
              />
              <datalist id="known-leases">
                {mandates.data?.leases.map((l) => (
                  <option key={l.leaseId} value={l.leaseId} />
                ))}
              </datalist>
              <div className="hub-field">
                <label htmlFor="job-trigger">Trigger</label>
                <select
                  id="job-trigger"
                  value={trigger}
                  onChange={(e) =>
                    setTrigger(
                      e.target.value as 'INVOICE_PAID' | 'OWNER_REQUEST',
                    )
                  }
                >
                  <option value="OWNER_REQUEST">Owner request</option>
                  <option value="INVOICE_PAID">Invoice paid</option>
                </select>
              </div>
              <TextField
                id="job-ref"
                label="Trigger reference"
                value={ref}
                onChange={setRef}
                maxLength={80}
                hint="An invoice id, or a short note for an owner request."
              />
              <TextField
                id="job-amount"
                label="Amount (USDC)"
                value={amount}
                onChange={setAmount}
                inputMode="decimal"
              />
              <TextField
                id="job-purpose"
                label="Purpose"
                value={purpose}
                onChange={setPurpose}
                maxLength={160}
              />
            </div>
            <Result a={createJob} />
            <p>
              <button
                className="hub-btn hub-btn-primary"
                disabled={createJob.busy}
              >
                {createJob.busy ? 'Creating…' : 'Create job'}
              </button>
            </p>
          </form>

          <h3>Jobs</h3>
          <Async state={jobs}>
            {(list) =>
              !list.jobs.length ? (
                <Empty>No contractor jobs yet.</Empty>
              ) : (
                <div className="hub-table-wrap">
                  <table className="hub-table">
                    <caption className="hub-sr">Contractor jobs</caption>
                    <thead>
                      <tr>
                        <th scope="col">Purpose</th>
                        <th scope="col" className="num">
                          Amount (USDC)
                        </th>
                        <th scope="col">State</th>
                        <th scope="col">Transaction</th>
                        <th scope="col">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.jobs.map((j) => (
                        <tr key={j.id}>
                          <th scope="row">
                            {j.purpose}
                            <br />
                            <small className="hub-sub">
                              {humanize(j.triggerKind)}: {j.triggerRef}
                            </small>
                          </th>
                          <td className="num">
                            {formatAmount(j.amount, USDC_DECIMALS)}
                          </td>
                          <td>
                            <span className="hub-status">
                              {j.state === 'SENT'
                                ? 'Sent (not final)'
                                : humanize(j.state)}
                            </span>
                          </td>
                          <td>
                            {j.txHash ? <Hash value={j.txHash} /> : 'None'}
                          </td>
                          <td>{j.reason ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          </Async>
        </>
      )}
    </Panel>
  );
}

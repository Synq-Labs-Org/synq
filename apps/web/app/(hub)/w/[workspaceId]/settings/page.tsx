'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { formatUnits } from 'viem';
import type { z } from 'zod';
import {
  CommercialPolicyListSchema,
  CommercialPolicySchema,
  CommercialPolicyViewSchema,
} from '@synq/contracts';
import { formatAmount, shortDate, toBaseUnits } from '../../../../../lib/money';
import { describeV3, seg, v3 } from '../../../../../lib/v3';
import { ThemePicker } from '../../../../workspaces/theme-picker';
import { useHub } from '../../../../_hub/provider';
import { useLiveRefresh, useV3 } from '../../../../_hub/hooks';
import {
  Async,
  Empty,
  Hash,
  Notice,
  PageHeader,
  Panel,
  humanize,
} from '../../../../_hub/ui';

const USDC_DECIMALS = 6;
type Policy = z.output<typeof CommercialPolicySchema>;

type Row = {
  sku: string;
  description: string;
  price: string;
  floor: string;
  maxQuantity: string;
  leadTimeDays: string;
  rushSurchargePercent: string;
  capacityUnits: string;
  capacityAsOf: string;
};
const blankRow = (): Row => ({
  sku: '',
  description: '',
  price: '',
  floor: '',
  maxQuantity: '10',
  leadTimeDays: '7',
  rushSurchargePercent: '0',
  capacityUnits: '',
  capacityAsOf: '',
});
type Form = {
  rows: Row[];
  maxDiscountPercent: string;
  minDepositPercent: string;
  maxMilestones: string;
  offerTtlHours: string;
  ownerApprovalAbove: string;
  capacityFreshHours: string;
};
const blankForm = (): Form => ({
  rows: [blankRow()],
  maxDiscountPercent: '10',
  minDepositPercent: '30',
  maxMilestones: '3',
  offerTtlHours: '72',
  ownerApprovalAbove: '',
  capacityFreshHours: '168',
});

const pct = (bps: number) => String(bps / 100);
const toBps = (p: string) => Math.round(Number(p) * 100);
const plain = (units: string) => formatUnits(BigInt(units), USDC_DECIMALS);
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const shifted = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
}

function fromPolicy(p: Policy): Form {
  return {
    rows: p.catalog.map((c) => ({
      sku: c.sku,
      description: c.description,
      price: plain(c.unitUnits),
      floor: plain(c.floorUnits),
      maxQuantity: String(c.maxQuantity),
      leadTimeDays: String(c.leadTimeDays),
      rushSurchargePercent: pct(c.rushSurchargeBps),
      capacityUnits: c.capacity ? String(c.capacity.unitsAvailable) : '',
      capacityAsOf: c.capacity ? toLocalInput(c.capacity.asOf) : '',
    })),
    maxDiscountPercent: pct(p.maxDiscountBps),
    minDepositPercent: pct(p.minDepositBps),
    maxMilestones: String(p.maxMilestones),
    offerTtlHours: String(p.offerTtlSeconds / 3600),
    ownerApprovalAbove: plain(p.ownerApprovalAboveUnits),
    capacityFreshHours: String(p.capacityFreshSeconds / 3600),
  };
}

/** Form text to a policy body, or the first thing wrong with it. */
function buildPolicy(f: Form): { policy: Policy } | { problem: string } {
  const catalog = [];
  for (const [i, r] of f.rows.entries()) {
    const label = `Item ${i + 1}`;
    const unitUnits = toBaseUnits(r.price, USDC_DECIMALS);
    const floorUnits = toBaseUnits(r.floor, USDC_DECIMALS);
    if (unitUnits === null || floorUnits === null)
      return {
        problem: `${label}: enter prices as USDC with at most 6 decimals, such as 12.50.`,
      };
    let capacity = null;
    if (r.capacityUnits.trim() !== '') {
      if (!r.capacityAsOf)
        return { problem: `${label}: capacity needs an as-of date and time.` };
      const when = new Date(r.capacityAsOf);
      if (Number.isNaN(when.getTime()))
        return { problem: `${label}: the capacity date is not valid.` };
      capacity = {
        unitsAvailable: Number(r.capacityUnits),
        asOf: when.toISOString(),
      };
    }
    catalog.push({
      sku: r.sku.trim(),
      description: r.description,
      unitUnits,
      floorUnits,
      maxQuantity: Number(r.maxQuantity),
      leadTimeDays: Number(r.leadTimeDays),
      rushSurchargeBps: toBps(r.rushSurchargePercent),
      capacity,
    });
  }
  const above = toBaseUnits(f.ownerApprovalAbove, USDC_DECIMALS);
  if (above === null)
    return {
      problem: 'Enter the owner-approval threshold as USDC, such as 5000.',
    };
  const parsed = CommercialPolicySchema.safeParse({
    catalog,
    maxDiscountBps: toBps(f.maxDiscountPercent),
    minDepositBps: toBps(f.minDepositPercent),
    maxMilestones: Number(f.maxMilestones),
    offerTtlSeconds: Math.round(Number(f.offerTtlHours) * 3600),
    ownerApprovalAboveUnits: above,
    capacityFreshSeconds: Math.round(Number(f.capacityFreshHours) * 3600),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      problem: `Check the policy: ${issue ? `${issue.path.join(' ')} ${issue.message}` : 'invalid'}.`,
    };
  }
  return { policy: parsed.data };
}

function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
  inputMode?: 'decimal' | 'numeric';
}) {
  return (
    <div className="hub-field">
      <label htmlFor={props.id}>{props.label}</label>
      <input
        id={props.id}
        type={props.type ?? 'text'}
        inputMode={props.inputMode}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <small>{props.hint}</small>}
    </div>
  );
}

function ProposeForm(props: {
  workspaceId: string;
  latest: Policy | null;
  onProposed: () => void;
}) {
  const [form, setForm] = useState<Form>(blankForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const setRow = (i: number, patch: Partial<Row>) =>
    setForm((f) => ({
      ...f,
      rows: f.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const built = buildPolicy(form);
        if ('problem' in built) {
          setError(built.problem);
          return;
        }
        setBusy(true);
        setError(null);
        setDone(null);
        v3.post(
          `/v3/workspaces/${seg(props.workspaceId)}/commercial-policies`,
          CommercialPolicyViewSchema,
          built.policy,
        )
          .then((view) => {
            setDone(view.version);
            props.onProposed();
          })
          .catch((err: unknown) => setError(describeV3(err)))
          .finally(() => setBusy(false));
      }}
    >
      {props.latest && (
        <p>
          <button
            type="button"
            className="hub-btn"
            onClick={() => setForm(fromPolicy(props.latest!))}
          >
            Start from the latest version
          </button>
        </p>
      )}
      {form.rows.map((r, i) => (
        <fieldset key={i} className="hub-panel">
          <legend>Catalog item {i + 1}</legend>
          <div className="hub-form-grid">
            <Field
              id={`sku-${i}`}
              label="SKU"
              value={r.sku}
              onChange={(v) => setRow(i, { sku: v })}
              hint="Lowercase letters, digits and dashes."
            />
            <Field
              id={`desc-${i}`}
              label="Description"
              value={r.description}
              onChange={(v) => setRow(i, { description: v })}
            />
            <Field
              id={`price-${i}`}
              label="List price per unit (USDC)"
              inputMode="decimal"
              value={r.price}
              onChange={(v) => setRow(i, { price: v })}
            />
            <Field
              id={`floor-${i}`}
              label="Floor price per unit (USDC)"
              inputMode="decimal"
              value={r.floor}
              onChange={(v) => setRow(i, { floor: v })}
              hint="No offer may go below this."
            />
            <Field
              id={`maxq-${i}`}
              label="Maximum quantity"
              inputMode="numeric"
              value={r.maxQuantity}
              onChange={(v) => setRow(i, { maxQuantity: v })}
            />
            <Field
              id={`lead-${i}`}
              label="Lead time (days)"
              inputMode="numeric"
              value={r.leadTimeDays}
              onChange={(v) => setRow(i, { leadTimeDays: v })}
            />
            <Field
              id={`rush-${i}`}
              label="Rush surcharge (%)"
              inputMode="decimal"
              value={r.rushSurchargePercent}
              onChange={(v) => setRow(i, { rushSurchargePercent: v })}
            />
            <Field
              id={`cap-${i}`}
              label="Capacity available (optional)"
              inputMode="numeric"
              value={r.capacityUnits}
              onChange={(v) => setRow(i, { capacityUnits: v })}
              hint="Leave empty if unknown. Rush work is then refused."
            />
            <Field
              id={`capdate-${i}`}
              label="Capacity as of"
              type="datetime-local"
              value={r.capacityAsOf}
              onChange={(v) => setRow(i, { capacityAsOf: v })}
              hint="Required when capacity is entered."
            />
          </div>
          {form.rows.length > 1 && (
            <div>
              <button
                type="button"
                className="hub-btn"
                onClick={() =>
                  set({ rows: form.rows.filter((_, j) => j !== i) })
                }
              >
                Remove item {i + 1}
              </button>
            </div>
          )}
        </fieldset>
      ))}
      <p>
        <button
          type="button"
          className="hub-btn"
          disabled={form.rows.length >= 50}
          onClick={() => set({ rows: [...form.rows, blankRow()] })}
        >
          Add catalog item
        </button>
      </p>
      <div className="hub-form-grid">
        <Field
          id="p-disc"
          label="Maximum discount (%)"
          inputMode="decimal"
          value={form.maxDiscountPercent}
          onChange={(v) => set({ maxDiscountPercent: v })}
        />
        <Field
          id="p-dep"
          label="Minimum deposit (%)"
          inputMode="decimal"
          value={form.minDepositPercent}
          onChange={(v) => set({ minDepositPercent: v })}
        />
        <Field
          id="p-ms"
          label="Maximum milestones (1 to 6)"
          inputMode="numeric"
          value={form.maxMilestones}
          onChange={(v) => set({ maxMilestones: v })}
        />
        <Field
          id="p-ttl"
          label="Offer valid for (hours)"
          inputMode="decimal"
          value={form.offerTtlHours}
          onChange={(v) => set({ offerTtlHours: v })}
        />
        <Field
          id="p-above"
          label="Owner must approve offers above (USDC)"
          inputMode="decimal"
          value={form.ownerApprovalAbove}
          onChange={(v) => set({ ownerApprovalAbove: v })}
        />
        <Field
          id="p-fresh"
          label="Capacity counts as fresh for (hours)"
          inputMode="decimal"
          value={form.capacityFreshHours}
          onChange={(v) => set({ capacityFreshHours: v })}
        />
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {done !== null && (
        <Notice tone="positive" live>
          Version {done} proposed. It is not active until an owner signs it in{' '}
          <Link href="/approvals">Approvals</Link>.
        </Notice>
      )}
      <p>
        <button className="hub-btn hub-btn-primary" disabled={busy}>
          {busy ? 'Proposing…' : 'Propose new version'}
        </button>
      </p>
    </form>
  );
}

export default function SettingsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const { theme, setTheme } = useHub();
  const state = useV3(
    `/v3/workspaces/${seg(workspaceId)}/commercial-policies`,
    CommercialPolicyListSchema,
  );
  useLiveRefresh(state.reload, { types: ['APPROVAL_CHANGED'] });
  return (
    <>
      <PageHeader title="Settings" />
      <Panel
        title="Sales policy"
        id="policy"
        note="The sales agent may only make offers inside the active policy. A new version takes effect only after an owner signs it."
      >
        <Async state={state}>
          {(list) => (
            <>
              {!list.policies.length && (
                <Empty>No policy yet. Propose the first version below.</Empty>
              )}
              <ul className="hub-list">
                {list.policies.map((p) => (
                  <li key={p.version}>
                    <strong>Version {p.version}</strong>{' '}
                    <span className="hub-status">
                      {p.state === 'REVIEW'
                        ? 'Waiting for owner signature'
                        : humanize(p.state)}
                    </span>
                    <br />
                    <small className="hub-sub">
                      Hash <Hash value={p.policyHash} />
                      {p.approvedBy ? ` · approved by ${p.approvedBy}` : ''}
                    </small>
                    <div className="hub-table-wrap">
                      <table className="hub-table">
                        <caption className="hub-sr">
                          Catalog of version {p.version}
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Item</th>
                            <th scope="col" className="num">
                              List (USDC)
                            </th>
                            <th scope="col" className="num">
                              Floor (USDC)
                            </th>
                            <th scope="col" className="num">
                              Max qty
                            </th>
                            <th scope="col">Capacity</th>
                          </tr>
                        </thead>
                        <tbody>
                          {p.policy.catalog.map((c) => (
                            <tr key={c.sku}>
                              <th scope="row">
                                {c.sku}
                                <br />
                                <small className="hub-sub">
                                  {c.description}
                                </small>
                              </th>
                              <td className="num">
                                {formatAmount(c.unitUnits, USDC_DECIMALS)}
                              </td>
                              <td className="num">
                                {formatAmount(c.floorUnits, USDC_DECIMALS)}
                              </td>
                              <td className="num">{c.maxQuantity}</td>
                              <td>
                                {c.capacity
                                  ? `${c.capacity.unitsAvailable} as of ${shortDate(c.capacity.asOf)}`
                                  : 'Unknown'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <small className="hub-sub">
                      Max discount {pct(p.policy.maxDiscountBps)}% · min deposit{' '}
                      {pct(p.policy.minDepositBps)}% · up to{' '}
                      {p.policy.maxMilestones} milestones · owner approval above{' '}
                      {formatAmount(
                        p.policy.ownerApprovalAboveUnits,
                        USDC_DECIMALS,
                      )}{' '}
                      USDC
                    </small>
                  </li>
                ))}
              </ul>
              <h3>Propose a new version</h3>
              <Notice tone="info">
                An owner must sign the proposal in Approvals before it becomes
                active. Proposing alone changes nothing.
              </Notice>
              <ProposeForm
                workspaceId={workspaceId}
                latest={list.policies[0]?.policy ?? null}
                onProposed={() => void state.reload()}
              />
            </>
          )}
        </Async>
      </Panel>
      <Panel title="Appearance" id="appearance">
        <ThemePicker value={theme} onChange={setTheme} />
      </Panel>
    </>
  );
}

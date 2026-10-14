'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import {
  activateMeraMembership,
  enrollMeraPrincipal,
  recoverMeraPrincipal,
  safeTransactionHash,
  signMeraFundJoin,
  type MeraCredential,
} from '@synq/identity/mera-browser';
import {
  IdentityChallengeSchema,
  PrincipalViewSchema,
  RecoveryResultSchema,
} from '@synq/schemas';
import { api, describeError } from '../../../lib/api';
import {
  loadCredential,
  relyingParty,
  saveCredential,
} from '../../../lib/session';

const Hex = z.string().regex(/^0x[0-9a-fA-F]*$/) as z.ZodType<`0x${string}`>;
const FundViewSchema = z.looseObject({
  fundId: z.string(),
  name: z.string(),
  state: z.enum(['FORMING', 'LAUNCHING', 'SETUP', 'ACTIVE', 'FAILED']),
  error: z.string().nullable(),
  members: z.array(
    z.looseObject({
      name: z.string(),
      principalId: z.string(),
      memberId: z.string().nullable(),
      activated: z.boolean(),
      signedSetup: z.boolean(),
    }),
  ),
  minMembers: z.number(),
  threshold: z.number(),
  setup: z.object({ signed: z.number(), required: z.number() }).nullable(),
  treasury: z.object({ balance: z.string(), symbol: z.string() }).nullable(),
  proposals: z.array(
    z.looseObject({
      intentHash: z.string(),
      state: z.string(),
      amount: z.string(),
      symbol: z.string(),
      recipient: z.string(),
      approvals: z.object({ counted: z.number(), required: z.number() }),
    }),
  ),
});
type FundView = z.output<typeof FundViewSchema>;
const ActivationSchema = z.object({
  challenge: IdentityChallengeSchema.nullable(),
  safeTransactions: z.array(
    z.object({
      safe: Hex,
      chainId: z.number(),
      to: Hex,
      data: Hex,
      nonce: z.string(),
    }),
  ),
});
const Anything = z.unknown();

/** The fund key travels in the URL fragment, which the browser never sends to the server. */
function fundKey(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get('k') ?? '';
}

const STATE_TEXT: Record<FundView['state'], string> = {
  FORMING: 'Gathering members',
  LAUNCHING: 'Creating the group wallet…',
  SETUP: 'Waiting for members to activate',
  ACTIVE: 'Live',
  FAILED: 'Setup failed',
};

export default function FundPage({
  params,
}: {
  params: Promise<{ fundId: string }>;
}) {
  const { fundId } = use(params);
  const [key, setKey] = useState('');
  const [fund, setFund] = useState<FundView | null>(null);
  const [record, setRecord] = useState<MeraCredential | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const refresh = useCallback(
    async (k: string) => {
      try {
        setFund(
          await api.get(
            `/v1/funds/${fundId}?k=${encodeURIComponent(k)}`,
            FundViewSchema,
          ),
        );
      } catch (e) {
        setMessage({ ok: false, text: describeError(e) });
      }
    },
    [fundId],
  );

  useEffect(() => {
    const k = fundKey();
    setKey(k);
    setRecord(loadCredential());
    void refresh(k);
  }, [refresh]);

  // Launch and setup run on the server; follow them until the fund is live.
  useEffect(() => {
    if (!fund || fund.state === 'ACTIVE' || fund.state === 'FAILED') return;
    const timer = setInterval(() => void refresh(key), 4000);
    return () => clearInterval(timer);
  }, [fund, key, refresh]);

  const me = fund?.members.find((m) => m.principalId === record?.principalId);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await action() });
      await refresh(key);
    } catch (e) {
      setMessage({ ok: false, text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function ensurePasskey(displayName: string): Promise<MeraCredential> {
    const existing = loadCredential();
    if (existing) return existing;
    const rp = relyingParty();
    const enrolled = await enrollMeraPrincipal({
      rpId: rp.rpId,
      rpName: rp.rpName,
      user: { name: displayName, displayName },
      requestChallenge: ({ signer, credential }) =>
        api.post(
          '/v1/principals/enrollment-challenges',
          IdentityChallengeSchema,
          {
            kind: 'MERA_HUMAN',
            signer,
            credential: {
              credentialId: credential.credentialId,
              ...(credential.transports
                ? { transports: [...credential.transports] }
                : {}),
            },
            rpId: rp.rpId,
            origin: rp.origin,
          },
        ),
    });
    await api.post('/v1/principals', PrincipalViewSchema, {
      challengeId: enrolled.challenge.challengeId,
      signature: enrolled.signature,
    });
    saveCredential(enrolled.record);
    setRecord(enrolled.record);
    return enrolled.record;
  }

  const join = () =>
    run(async () => {
      const displayName = name.trim();
      const credential = await ensurePasskey(displayName);
      const issuedAt = Math.floor(Date.now() / 1000);
      const signature = await signMeraFundJoin(credential, {
        fundId,
        principalId: credential.principalId,
        name: displayName,
        issuedAt,
      });
      await api.post(`/v1/funds/${fundId}/members`, Anything, {
        key,
        principalId: credential.principalId,
        name: displayName,
        issuedAt,
        signature,
      });
      return 'You joined. Head back to Messages.';
    });

  const usePasskey = () =>
    run(async () => {
      const rp = relyingParty();
      const recovered = await recoverMeraPrincipal({
        rpId: rp.rpId,
        requestChallenge: ({ signer, credentialId }) =>
          api.post(
            '/v1/principals/recovery-challenges',
            IdentityChallengeSchema,
            {
              signer,
              credentialId,
              rpId: rp.rpId,
              origin: rp.origin,
            },
          ),
      });
      const session = await api.post(
        '/v1/principals/recover',
        RecoveryResultSchema,
        {
          challengeId: recovered.challenge.challengeId,
          signature: recovered.signature,
        },
      );
      const restored = {
        ...recovered.record,
        credential: session.principal.credential ?? recovered.record.credential,
      };
      saveCredential(restored);
      setRecord(restored);
      return 'Signed in with your passkey.';
    });

  const activate = () =>
    run(async () => {
      if (!record) throw new Error('No passkey on this device');
      const pending = await api.post(
        `/v1/funds/${fundId}/activation-challenges`,
        ActivationSchema,
        { key, principalId: record.principalId },
      );
      const transactions = pending.safeTransactions.map((t) => ({
        ...t,
        nonce: BigInt(t.nonce),
      }));
      const signed = await activateMeraMembership(record, {
        challenge: pending.challenge,
        safeTransactions: transactions,
      });
      await api.post(`/v1/funds/${fundId}/activations`, Anything, {
        key,
        principalId: record.principalId,
        joinSignature: signed.joinSignature,
        safeSignatures: transactions.map((tx, i) => ({
          safeTxHash: safeTransactionHash(tx),
          signature: signed.safeSignatures[i],
        })),
      });
      return 'Activated. Head back to Messages.';
    });

  if (!fund)
    return (
      <>
        <h1>Synq fund</h1>
        {message ? (
          <div className="status bad">{message.text}</div>
        ) : (
          <p className="lead">Loading…</p>
        )}
      </>
    );

  const needsActivation =
    me &&
    (fund.state === 'SETUP' || fund.state === 'ACTIVE') &&
    (!me.activated || (fund.state === 'SETUP' && !me.signedSetup));

  return (
    <>
      <h1>{fund.name}</h1>
      <p className="lead" data-testid="fund-state">
        {STATE_TEXT[fund.state]}
        {fund.setup && fund.state === 'SETUP'
          ? ` · ${fund.setup.signed}/${fund.setup.required} owners signed`
          : ''}
      </p>
      {fund.treasury && (
        <p>
          <strong>
            {fund.treasury.balance} {fund.treasury.symbol}
          </strong>{' '}
          in the group wallet (Monad testnet)
        </p>
      )}
      <h2>Members</h2>
      <ul data-testid="fund-members">
        {fund.members.map((m) => (
          <li key={m.principalId}>
            {m.name}
            {m.principalId === record?.principalId ? ' (you)' : ''}
            {fund.state !== 'FORMING' && !m.activated ? ' · not activated' : ''}
          </li>
        ))}
        {fund.members.length === 0 && <li>No one yet</li>}
      </ul>

      {fund.state === 'FORMING' && !me && (
        <>
          <label htmlFor="name">Your name in this group</label>
          <input
            id="name"
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
          />
          <button disabled={busy || !name.trim()} onClick={join}>
            {busy
              ? 'Waiting for Face ID…'
              : record
                ? 'Join with Face ID'
                : 'Create passkey and join'}
          </button>
          {!record && (
            <p>
              Already have a Synq passkey?{' '}
              <button className="link" disabled={busy} onClick={usePasskey}>
                Use it
              </button>
            </p>
          )}
        </>
      )}
      {fund.state === 'FORMING' && me && (
        <p>
          You are in. The person who started the fund launches it from Messages
          once at least {fund.minMembers} people have joined.
        </p>
      )}
      {needsActivation && (
        <button disabled={busy} onClick={activate}>
          {busy ? 'Waiting for Face ID…' : 'Activate with Face ID'}
        </button>
      )}
      {(fund.state === 'SETUP' || fund.state === 'ACTIVE') && !me && record && (
        <p>This passkey is not a member of the fund.</p>
      )}
      {(fund.state === 'SETUP' || fund.state === 'ACTIVE') && !record && (
        <button className="link" disabled={busy} onClick={usePasskey}>
          Sign in with your passkey
        </button>
      )}
      {fund.state === 'ACTIVE' && me && !needsActivation && (
        <p>
          The fund is live. Send and approve payments from Synq in Messages.
        </p>
      )}
      {fund.state === 'FAILED' && (
        <div className="status bad">{fund.error ?? 'Setup failed.'}</div>
      )}
      {fund.proposals.length > 0 && (
        <>
          <h2>Payments</h2>
          <ul>
            {fund.proposals.map((p) => (
              <li key={p.intentHash}>
                <a href={`/intents/${p.intentHash}`}>
                  {p.amount} {p.symbol} to {p.recipient}
                </a>{' '}
                · {p.state.toLowerCase()} · {p.approvals.counted}/
                {p.approvals.required}
              </li>
            ))}
          </ul>
        </>
      )}
      {message && (
        <div
          className={`status ${message.ok ? 'ok' : 'bad'}`}
          data-testid="fund-result"
        >
          {message.text}
        </div>
      )}
    </>
  );
}

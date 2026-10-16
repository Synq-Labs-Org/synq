'use client';

import { useEffect, useState } from 'react';
import { getAddress } from 'viem';
import { z } from 'zod';
import { channelLinkTypedData } from '@synq/identity/channel-link-data';
import { WalletSchema } from '@synq/workspaces/contracts';
import { api, ApiFailure, describeError } from '../../lib/api';

const ConfigSchema = z.strictObject({
  telegramBotId: z.string(),
  telegramLinked: z.boolean(),
  groupBindingAllowed: z.boolean(),
  imessage: z.string(),
});
const ChallengeSchema = z.strictObject({
  challengeId: z.string(),
  purpose: z.literal('LINK'),
  authority: z.literal('WALLET'),
  workspaceId: z.string().uuid(),
  channel: z.literal('telegram'),
  channelUserId: z.string(),
  wallet: WalletSchema,
  statement: z.string(),
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  issuedAt: z.number(),
  expiresAt: z.number(),
  displayHandle: z.string().nullable(),
});
type Challenge = z.output<typeof ChallengeSchema>;
type Provider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
};
function telegramProof() {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);
  const mini = params.get('tgWebAppData');
  if (mini) return { kind: 'MINIAPP', data: mini };
  const encoded = /tgAuthResult=([A-Za-z0-9_\-=+/]+)/.exec(hash)?.[1];
  if (!encoded) return null;
  try {
    return {
      kind: 'LOGIN',
      data: JSON.parse(
        atob(encoded.replace(/-/g, '+').replace(/_/g, '/')),
      ) as unknown,
    };
  } catch {
    return null;
  }
}
export function ChannelPanel({ workspaceId }: { workspaceId: string }) {
  const [config, setConfig] = useState<z.output<typeof ConfigSchema> | null>(
    null,
  );
  const [proof, setProof] = useState<ReturnType<typeof telegramProof>>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [chatId, setChatId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [bound, setBound] = useState<string | null>(null);
  const base = `/v2/workspaces/${encodeURIComponent(workspaceId)}/channels`;
  useEffect(() => {
    let active = true;
    const raw = telegramProof();
    setProof(raw);
    if (raw)
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}`,
      );
    api
      .get(`${base}/config`, ConfigSchema)
      .then((v) => {
        if (active) setConfig(v);
      })
      .catch((e: unknown) => {
        if (active) {
          if (e instanceof ApiFailure && e.code === 'CHANNEL_BINDING_BLOCKED')
            setBlocked(true);
          else setError(describeError(e));
        }
      });
    return () => {
      active = false;
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
  function verifyTelegram() {
    if (!config) return;
    const back = `${window.location.origin}/workspaces?workspace=${encodeURIComponent(workspaceId)}`;
    window.location.assign(
      `https://oauth.telegram.org/auth?bot_id=${encodeURIComponent(config.telegramBotId)}&origin=${encodeURIComponent(window.location.origin)}&request_access=write&return_to=${encodeURIComponent(back)}`,
    );
  }
  async function request() {
    await run(async () => {
      const result = await api.post(
        `${base}/challenge`,
        z.strictObject({
          challenge: ChallengeSchema,
          typedData: z.record(z.string(), z.unknown()),
        }),
        { channel: 'telegram', proof },
      );
      if (result.challenge.workspaceId !== workspaceId)
        throw new Error('Channel challenge workspace mismatch');
      setChallenge(result.challenge);
      setProof(null);
    });
  }
  async function complete() {
    if (!challenge) return;
    await run(async () => {
      const provider = (window as unknown as { ethereum?: Provider }).ethereum;
      if (!provider) throw new Error('Wallet unavailable');
      const wallets = z
        .array(WalletSchema)
        .min(1)
        .parse(await provider.request({ method: 'eth_requestAccounts' }));
      if (getAddress(wallets[0]!) !== challenge.wallet) {
        setError('Use the wallet signed in to this workspace.');
        return;
      }
      if (Date.now() / 1000 >= challenge.expiresAt) {
        setError('This identity challenge expired. Verify Telegram again.');
        return;
      }
      const typed = channelLinkTypedData({
        ...challenge,
        nonce: challenge.nonce as `0x${string}`,
      });
      const signature = z
        .string()
        .regex(/^0x[0-9a-fA-F]{130}$/)
        .parse(
          await provider.request({
            method: 'eth_signTypedData_v4',
            params: [
              challenge.wallet,
              JSON.stringify(typed, (_key, value) =>
                typeof value === 'bigint' ? String(value) : value,
              ),
            ],
          }),
        );
      await api.post(
        `${base}/complete`,
        z.strictObject({ linked: z.literal(true) }),
        { challengeId: challenge.challengeId, channelCode: code, signature },
      );
      setCode('');
      setChallenge(null);
      setConfig(await api.get(`${base}/config`, ConfigSchema));
    });
  }
  async function bind(kind: 'DIRECT' | 'GROUP') {
    await run(async () => {
      const result = await api.post(
        `${base}/bind`,
        z.strictObject({
          bound: z.literal(true),
          channel: z.literal('telegram'),
          kind: z.enum(['DIRECT', 'GROUP']),
          chatHint: z.string(),
        }),
        { kind, ...(kind === 'GROUP' ? { chatId } : {}) },
      );
      setBound(
        `${result.kind} chat ${result.chatHint} linked to this workspace.`,
      );
    });
  }
  return (
    <section>
      <h2>Chat identity</h2>
      <p>Linking a chat never approves a payment or changes Safe ownership.</p>
      {error && <p role="alert">{error}</p>}
      {bound && <p role="status">{bound}</p>}
      {blocked ? (
        <p>Verified channel linking is not configured on this server.</p>
      ) : config?.telegramLinked ? (
        <>
          <p>
            Telegram identity verified by provider proof, private code and
            wallet signature.
          </p>
          <button disabled={busy} onClick={() => void bind('DIRECT')}>
            Use this workspace in my Telegram direct chat
          </button>
          {config.groupBindingAllowed && (
            <>
              <label htmlFor="workspace-chat-id">Telegram group chat ID</label>
              <input
                id="workspace-chat-id"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
              />
              <button
                disabled={busy || !/^-[1-9][0-9]*$/.test(chatId)}
                onClick={() => void bind('GROUP')}
              >
                Link group after checking my admin role
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <button disabled={busy || !config} onClick={verifyTelegram}>
            Verify my Telegram identity
          </button>
          {proof && (
            <button disabled={busy} onClick={() => void request()}>
              Send a private link code to my Telegram account
            </button>
          )}
          {challenge && (
            <>
              <p>{challenge.statement}</p>
              <label htmlFor="telegram-private-code">
                Private code received from Synq
              </label>
              <input
                id="telegram-private-code"
                type="password"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button
                disabled={busy || !/^[0-9]{8}$/.test(code)}
                onClick={() => void complete()}
              >
                Sign this identity link in my wallet
              </button>
            </>
          )}
        </>
      )}
      <p>
        iMessage conversation binding requires a verified bridge. Native sign-in
        codes authenticate the extension; they do not prove a conversation
        identity.
      </p>
    </section>
  );
}

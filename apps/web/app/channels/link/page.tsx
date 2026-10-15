'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import {
  signMeraSendAccess,
  SendAccessChallengeSchema,
  type MeraCredential,
} from '@synq/identity/mera-browser';
import { api, describeError } from '../../../lib/api';
import { loadCredential } from '../../../lib/session';

const PreviewSchema = z.looseObject({
  channel: z.string(),
  displayName: z.string().nullable(),
  expiresAt: z.number(),
  groupLinked: z.boolean(),
  telegramLogin: z
    .looseObject({ botId: z.number(), required: z.boolean() })
    .nullable()
    .optional(),
});

function telegramLoginFromFragment(): Record<string, unknown> | null {
  const m = /tgAuthResult=([A-Za-z0-9_\-=+/]+)/.exec(window.location.hash);
  if (!m) return null;
  try {
    const json = atob(m[1]!.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
/**
 * Opened as a Telegram Mini App, the page receives Telegram.WebApp.initData
 * in the launch fragment (#tgWebAppData=...). The API verifies its
 * signature and age and accepts it once; the page only forwards it.
 */
function telegramInitDataFromFragment(): string | null {
  const data = new URLSearchParams(window.location.hash.slice(1)).get(
    'tgWebAppData',
  );
  return data && data.length <= 8192 ? data : null;
}
/**
 * Opened from t.me/<bot>/<app>?startapp=<code>, the link code arrives as the
 * Mini App start parameter (tgWebAppStartParam, or start_param in initData).
 */
function miniAppStartCode(): string {
  const fromQuery = new URLSearchParams(window.location.search).get(
    'tgWebAppStartParam',
  );
  const initData = telegramInitDataFromFragment();
  const fromInitData = initData
    ? new URLSearchParams(initData).get('start_param')
    : null;
  const code = fromQuery ?? fromInitData ?? '';
  return /^[A-Za-z0-9_-]{16,64}$/.test(code) ? code : '';
}
const AccessSessionSchema = z.looseObject({
  token: z.string(),
  memberId: z.string(),
});
const LinkedSchema = z.looseObject({
  status: z.literal('LINKED'),
  channel: z.string(),
  memberId: z.string(),
});

export default function ChannelLinkPage() {
  const [record, setRecord] = useState<MeraCredential | null>(null);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<z.output<typeof PreviewSchema> | null>(
    null,
  );
  const [groupId, setGroupId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [done, setDone] = useState<z.output<typeof LinkedSchema> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [telegramLogin, setTelegramLogin] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [telegramInitData, setTelegramInitData] = useState<string | null>(null);

  useEffect(() => {
    setRecord(loadCredential());
    setTelegramLogin(telegramLoginFromFragment());
    setTelegramInitData(telegramInitDataFromFragment());
    const c =
      new URLSearchParams(window.location.search).get('code') ??
      miniAppStartCode();
    setCode(c);
    if (c)
      api
        .get(`/v1/channels/links/${encodeURIComponent(c)}`, PreviewSchema)
        .then(setPreview)
        .catch(() => setError('This link code is invalid, used or expired.'));
  }, []);

  async function link() {
    setError(null);
    setBusy(true);
    try {
      if (!record) throw new Error('Create or recover your passkey first.');
      const challenge = await api.post(
        '/v1/send/access/challenges',
        SendAccessChallengeSchema,
        { groupId, principalId: record.principalId },
      );
      const signature = await signMeraSendAccess(record, challenge);
      const session = await api.post('/v1/send/access', AccessSessionSchema, {
        challengeId: challenge.challengeId,
        signature,
      });
      setDone(
        await api.post(
          '/v1/channels/links/redeem',
          LinkedSchema,
          {
            code,
            groupId,
            ...(telegramLogin
              ? { telegramLogin }
              : telegramInitData
                ? { telegramInitData }
                : {}),
          },
          session.token,
        ),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function verifyTelegram(botId: number) {
    const back = window.location.href.split('#')[0]!;
    window.location.href = `https://oauth.telegram.org/auth?bot_id=${botId}&origin=${encodeURIComponent(window.location.origin)}&request_access=write&return_to=${encodeURIComponent(back)}`;
  }
  const telegramProven = telegramLogin !== null || telegramInitData !== null;
  const needsTelegram = !!preview?.telegramLogin?.required && !telegramProven;

  return (
    <>
      <h1>Link a chat to Synq</h1>
      <p className="lead">
        Linking lets Synq recognise your chat account in your group chat. It
        never approves anything: every approval still needs your passkey on this
        site.
      </p>
      {!record && (
        <p className="lead">
          <a href="/enroll">Create a passkey account</a> first.
        </p>
      )}
      {preview && !done && (
        <>
          <p data-testid="link-preview">
            {preview.channel} account {preview.displayName ?? '(no name)'} will
            be linked to your Synq identity
            {preview.groupLinked ? '' : ' and this chat to the group below'}.
            Only continue if that chat account is yours.
          </p>
          <label>
            Group id
            <input
              data-testid="link-group"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value.trim())}
              placeholder="0x…"
            />
          </label>
          <label>
            <input
              type="checkbox"
              style={{ width: 'auto', marginRight: 8 }}
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            This is my chat account
          </label>
          {preview.telegramLogin && (
            <p>
              {telegramLogin
                ? 'Telegram account verified for this link.'
                : telegramInitData
                  ? 'Opened from Telegram: your Telegram account will be verified when you link.'
                  : 'Prove this Telegram account is yours: '}
              {!telegramProven && (
                <button
                  data-testid="link-telegram"
                  onClick={() => verifyTelegram(preview.telegramLogin!.botId)}
                >
                  Verify with Telegram
                </button>
              )}
            </p>
          )}
          <button
            data-testid="link-confirm"
            disabled={
              busy || !confirmed || !groupId || !record || needsTelegram
            }
            onClick={link}
          >
            {busy ? 'Waiting for passkey…' : 'Link with passkey'}
          </button>
        </>
      )}
      {done && (
        <div className="status" data-testid="link-done">
          Linked as {done.memberId} on {done.channel}.
        </div>
      )}
      {error && <div className="status bad">{error}</div>}
    </>
  );
}

'use client';

import { use, useEffect, useState } from 'react';
import {
  signMeraIdentityChallenge,
  type MeraCredential,
} from '@synq/identity/mera-browser';
import {
  GroupViewSchema,
  IdentityChallengeSchema,
  MembershipViewSchema,
  type GroupView,
} from '@synq/schemas';
import { api, describeError } from '../../../../lib/api';
import { loadCredential } from '../../../../lib/session';

export default function JoinPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const { groupId } = use(params);
  const [record, setRecord] = useState<MeraCredential | null>(null);
  const [group, setGroup] = useState<GroupView | null>(null);
  const [memberId, setMemberId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  useEffect(() => {
    setRecord(loadCredential());
    api
      .get(`/v1/groups/${groupId}`, GroupViewSchema)
      .then(setGroup)
      .catch((e: unknown) => setResult({ ok: false, text: describeError(e) }));
  }, [groupId]);

  async function join() {
    if (!record) return;
    setBusy(true);
    setResult(null);
    try {
      const challenge = await api.post(
        `/v1/groups/${groupId}/membership-challenges`,
        IdentityChallengeSchema,
        { memberId, principalId: record.principalId },
      );
      const signature = await signMeraIdentityChallenge(record, challenge);
      const membership = await api.post(
        `/v1/groups/${groupId}/memberships`,
        MembershipViewSchema,
        {
          challengeId: challenge.challengeId,
          signature,
        },
      );
      setResult({
        ok: true,
        text: `Joined as ${membership.memberId} (epoch ${membership.joinedEpoch})`,
      });
      setGroup(await api.get(`/v1/groups/${groupId}`, GroupViewSchema));
    } catch (error) {
      setResult({ ok: false, text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Join group</h1>
      {group && (
        <dl className="preview">
          <dt>Group account</dt>
          <dd>{group.account}</dd>
          <dt>Approvals needed</dt>
          <dd>
            {group.threshold} of {group.owners.length}
          </dd>
          <dt>Members</dt>
          <dd data-testid="group-members">
            {group.memberships.filter((m) => m.status === 'ACTIVE').length}
          </dd>
        </dl>
      )}
      {!record ? (
        <p className="lead">
          <a href="/enroll">Create</a> or <a href="/recover">recover</a> a
          passkey first.
        </p>
      ) : (
        <>
          <label htmlFor="member">Member name in this group</label>
          <input
            id="member"
            data-testid="join-member-id"
            value={memberId}
            maxLength={64}
            onChange={(e) => setMemberId(e.target.value)}
          />
          <button
            data-testid="join-submit"
            disabled={busy || !memberId.trim()}
            onClick={join}
          >
            {busy ? 'Waiting for passkey…' : 'Join with passkey'}
          </button>
        </>
      )}
      {result && (
        <div
          className={`status ${result.ok ? 'ok' : 'bad'}`}
          data-testid="join-result"
        >
          {result.text}
        </div>
      )}
    </>
  );
}

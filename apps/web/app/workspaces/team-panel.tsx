'use client';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { WorkspaceTeamReplySchema } from '@synq/workspaces/team-contracts';
import { api, describeError } from '../../lib/api';
export function TeamPanel({ workspaceId }: { workspaceId: string }) {
  const requestKey = useRef<string | null>(null);
  const [question, setQuestion] = useState(''),
    [reply, setReply] = useState<z.output<
      typeof WorkspaceTeamReplySchema
    > | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  return (
    <section>
      <h2>Your workspace finance team</h2>
      <p>
        Answers cite this workspace’s observed facts. Missing or stale sources
        stay unknown. Chat never approves spending, and agents never hold
        signing keys.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            requestKey.current ??= crypto.randomUUID();
            setReply(
              await api.post(
                `/v2/workspaces/${encodeURIComponent(workspaceId)}/team/ask`,
                WorkspaceTeamReplySchema,
                { message: question, idempotencyKey: requestKey.current },
              ),
            );
            requestKey.current = null;
          } catch (e) {
            setError(describeError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Question or explicit payment proposal
          <textarea
            required
            minLength={1}
            maxLength={2000}
            value={question}
            disabled={busy}
            onChange={(e) => {
              requestKey.current = null;
              setQuestion(e.target.value);
            }}
          />
        </label>
        <button type="submit" disabled={busy || !question.trim()}>
          {busy ? 'Reading workspace facts…' : 'Ask the team'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {reply && (
        <article>
          <p>
            {reply.status} · {reply.roles.join(', ')}
          </p>
          <p>{reply.answer}</p>
          {reply.world && (
            <p>
              Snapshot {new Date(reply.world.builtAt * 1000).toLocaleString()} ·{' '}
              {reply.world.decisionGrade
                ? 'Sources fresh for a decision'
                : 'Incomplete or stale sources; spending recommendations withheld'}
              .
            </p>
          )}
          {reply.citations.map((c, i) => (
            <p key={i}>
              {c.path} · {c.freshness} · {c.source}
              {c.observedAt === null
                ? ''
                : ` · ${new Date(c.observedAt * 1000).toLocaleString()}`}
            </p>
          ))}
          {reply.payoutId && (
            <a
              href={`/workspaces?workspace=${encodeURIComponent(workspaceId)}&payout=${encodeURIComponent(reply.payoutId)}`}
            >
              Review payment request and sign in your wallet
            </a>
          )}
        </article>
      )}
    </section>
  );
}

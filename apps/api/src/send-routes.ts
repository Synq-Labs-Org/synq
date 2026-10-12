import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Address, Hex } from 'viem';
import type {
  ExecutionGrant,
  GrantDraft,
  Mandate,
  VerifiedApproval,
} from '@synq/schemas';
import type { createSendMemberAccess } from './send-access.js';
import type { AuthorizationDecision } from '@synq/kernel';
import { parseDecimal } from '@synq/domain';
import {
  FundingError,
  advanceSend,
  buildSendPreview,
  confirmSendPreview,
  newSendRecord,
  sendDirectory,
  type AusdGuardResult,
  type SendRecord,
  type SendStore,
} from '@synq/funding';
import {
  verifySendConfirmation,
  type SendConfirmation,
} from '@synq/identity/server';
import type { TreasuryView } from '@synq/read-model';

export type SendGroupContext = {
  groupId: string;
  mandate: Mandate;
  members: {
    memberId: string;
    principalId: string;
    signer: string;
    label?: string;
  }[];
  contacts: { label: string; address: string }[];
};
export type SendRecovery =
  | { status: 'ABSENT' | 'UNKNOWN' }
  | { status: 'RECOVERED'; decision: AuthorizationDecision };
export type SendProposal = {
  intent: { intentId: string } & Record<string, unknown>;
  risk: unknown;
  simulation: unknown;
  data: Hex;
};

/** Ports the Synq Send routes need; the API never signs or broadcasts. */
export interface SendRouteDeps {
  store: SendStore;
  adminToken: string | null;
  /** Unix seconds (preview expiry). */
  now: () => number;
  /** Same clock in milliseconds for history and latency; defaults to now() * 1000. */
  nowMs?: () => number;
  groups: { context(groupId: string): Promise<SendGroupContext | null> };
  members: {
    activeSigner(groupId: string, memberId: string): Promise<Address | null>;
  };
  treasury: { view(groupId: string): Promise<TreasuryView | null> };
  guard: {
    check(input: {
      mandate: Mandate;
      recipient: Address;
      amount: bigint;
    }): Promise<AusdGuardResult>;
  };
  proposer: {
    propose(input: {
      mandate: Mandate;
      recipient: Address;
      amount: bigint;
      nonce: string;
    }): Promise<SendProposal>;
  };
  kernel: {
    authorize(request: unknown): Promise<AuthorizationDecision>;
    recover?(proposal: SendProposal): Promise<SendRecovery>;
  };
  drafts: {
    register(draft: GrantDraft): Promise<unknown>;
    verifiedApprovals(draftDigest: string): Promise<{
      satisfied: boolean;
      counted: VerifiedApproval[];
    }>;
  };
  index: {
    executed(
      groupId: string,
      intentHash: string,
    ): Promise<{
      indexedThroughBlock: number;
      transactionHash: string | null;
      tokenAmount: string | null;
      recipient: string | null;
    }>;
  };
  memberAccess?: ReturnType<typeof createSendMemberAccess>;
  previewTtlSeconds?: number;
  /** Resolve sends interrupted in CONFIRMING/PENDING_APPROVAL before serving (production). */
  recoverOnReady?: boolean;
}

const STATUS: Partial<Record<string, number>> = {
  SEND_MANDATE_UNAVAILABLE: 409,
  SEND_MANDATE_AMBIGUOUS: 409,
  RECIPIENT_UNKNOWN: 422,
  RECIPIENT_MISMATCH: 409,
  PREVIEW_MISMATCH: 409,
  PREVIEW_EXPIRED: 410,
  AMOUNT_INVALID: 400,
  AMOUNT_EXCEEDS_MANDATE: 422,
  INSUFFICIENT_FREE_BALANCE: 422,
  AUSD_GUARD_BLOCKED: 423,
  INVALID_TRANSITION: 409,
  NETWORK_MISMATCH: 409,
};
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}
const hash = (v: string) => createHash('sha256').update(v).digest();
function assertAdmin(request: FastifyRequest, token: string | null) {
  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !timingSafeEqual(hash(presented), hash(token)))
    throw new HttpError(401, 'UNAUTHORIZED');
}
async function handle(
  reply: FastifyReply,
  run: () => Promise<unknown>,
  status = 200,
) {
  try {
    return reply.code(status).send(await run());
  } catch (error) {
    if (error instanceof HttpError)
      return reply
        .code(error.status)
        .send({ error: error.code, message: error.message });
    if (error instanceof FundingError)
      return reply
        .code(STATUS[error.code] ?? 422)
        .send({ error: error.code, message: error.message });
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: 'INVALID_REQUEST', message: 'Request is invalid' });
    throw error;
  }
}
const json = <T>(v: T): T =>
  JSON.parse(
    JSON.stringify(v, (_, x: unknown) =>
      typeof x === 'bigint' ? x.toString() : x,
    ),
  );

const GroupParams = z.strictObject({
  groupId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});
const SendParams = z.strictObject({
  sendId: z.string().regex(/^0x[0-9a-f]{64}$/),
});
const PreviewBody = z.strictObject({
  groupId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  recipientId: z.string().min(1).max(200),
  amount: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
});
const ConfirmBody = z.strictObject({
  previewId: z.string().regex(/^0x[0-9a-f]{64}$/),
  digest: z.string().regex(/^0x[0-9a-f]{64}$/),
  recipientAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amount: z.string().regex(/^[0-9]+$/),
  chainId: z.number().int().positive(),
  sender: z.strictObject({
    memberId: z.string().min(1).max(200),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  }),
});
const ExecutionBody = z.strictObject({
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  blockNumber: z.string().regex(/^[0-9]+$/),
  submittedAt: z.number().int().positive(),
  confirmedAt: z.number().int().positive(),
  recipientBalanceBefore: z.string().regex(/^[0-9]+$/),
  recipientBalanceAfter: z.string().regex(/^[0-9]+$/),
  explorer: z.string().url().nullable(),
});

export function confirmationOf(
  record: { preview: SendRecord['preview'] },
  memberId: string,
): SendConfirmation {
  const p = record.preview;
  return {
    previewId: p.previewId,
    digest: p.digest,
    groupId: p.groupId,
    memberId,
    recipient: p.recipient.address,
    token: p.asset.address,
    amount: BigInt(p.amount),
    chainId: p.chainId,
    expiresAt: p.expiresAt,
  };
}

/**
 * Synq Send (Bible §97): directory → preview → passkey-confirmed proposal →
 * Kernel → Mera approvals (existing /v1/approvals) → authorize → worker
 * execution report → read-model reconciliation and receipt.
 */
export async function sendRoutes(
  api: FastifyInstance,
  deps: SendRouteDeps,
): Promise<void> {
  const nowMs = () => deps.nowMs?.() ?? deps.now() * 1000;
  const load = async (sendId: string) => {
    const r = await deps.store.get(sendId);
    if (!r) throw new HttpError(404, 'SEND_NOT_FOUND');
    return r;
  };
  /** AusdGuard runs again before every Kernel call: pause/freeze can change after the preview. */
  const requireGuard = async (preview: SendRecord['preview']) => {
    const c = await context(preview.groupId);
    const result = await deps.guard.check({
      mandate: c.mandate,
      recipient: preview.recipient.address,
      amount: BigInt(preview.amount),
    });
    if (
      result.status !== 'PASS' ||
      result.chainId !== preview.chainId ||
      result.token.toLowerCase() !== preview.asset.address ||
      result.account.toLowerCase() !== preview.account ||
      result.recipient.toLowerCase() !== preview.recipient.address ||
      result.amount !== preview.amount
    )
      throw new FundingError('AUSD_GUARD_BLOCKED', result.reasons.join(','));
  };
  const context = async (groupId: string) => {
    const c = await deps.groups.context(groupId.toLowerCase());
    if (!c) throw new HttpError(404, 'GROUP_NOT_FOUND');
    return c;
  };

  const finishConfirmation = async (
    record: SendRecord,
    decision: AuthorizationDecision,
  ) => {
    const base = {
      intentId: decision.intentId,
      intentHash: decision.intentHash,
      kernelTier: decision.tier,
      kernelCode: 'code' in decision ? decision.code : null,
    };
    const now = nowMs();
    const next =
      decision.status === 'PENDING_APPROVAL' && decision.draft
        ? advanceSend(record, 'PENDING_APPROVAL', now, decision.code, {
            ...base,
            draftDigest: decision.draft.digest,
          })
        : decision.status === 'AUTHORIZED'
          ? advanceSend(
              record,
              'AUTHORIZED',
              now,
              'Kernel authorization recorded',
              {
                ...base,
                draftDigest: decision.draft.digest,
                grantId: decision.grant.grantId,
              },
            )
          : advanceSend(
              record,
              'REJECTED',
              now,
              'Kernel refusal recorded',
              base,
            );
    await deps.store.save(next);
    if (decision.status === 'PENDING_APPROVAL' && decision.draft)
      await deps.drafts.register(decision.draft);
    return next;
  };
  const recoverConfirmation = async (record: SendRecord) => {
    if (record.state !== 'CONFIRMING' || !record.proposal || !record.sender)
      return record;
    const recovery = await deps.kernel.recover?.(
      record.proposal as SendProposal,
    );
    if (recovery?.status === 'RECOVERED')
      return finishConfirmation(record, recovery.decision);
    // Missing or ambiguous recovery evidence never creates another authorization.
    if (recovery?.status !== 'ABSENT')
      return { ...record, kernelCode: 'CONFIRMATION_RECONCILIATION_REQUIRED' };
    // ABSENT: the Kernel never saw this intent, so an expired claim ends here.
    if (deps.now() >= record.preview.expiresAt) {
      const expired = advanceSend(
        record,
        'REJECTED',
        nowMs(),
        'preview expired before Kernel authorization',
        { kernelCode: 'PREVIEW_EXPIRED' },
      );
      await deps.store.save(expired);
      return expired;
    }
    const signer = await deps.members.activeSigner(
      record.preview.groupId,
      record.sender.memberId,
    );
    if (
      !signer ||
      signer.toLowerCase() !== record.sender.signer ||
      !(await verifySendConfirmation(
        signer,
        confirmationOf(record, record.sender.memberId),
        record.sender.signature,
      ))
    ) {
      // The confirming member's authority is gone; the Kernel never saw it.
      const revoked = advanceSend(
        record,
        'REJECTED',
        nowMs(),
        'sender no longer an active member before Kernel authorization',
        { kernelCode: 'SENDER_NOT_MEMBER' },
      );
      await deps.store.save(revoked);
      return revoked;
    }
    await requireGuard(record.preview);
    const proposal = record.proposal as SendProposal;
    return finishConfirmation(
      record,
      await deps.kernel.authorize({
        intent: proposal.intent,
        risk: proposal.risk,
        simulation: proposal.simulation,
        approvals: [],
      }),
    );
  };
  /**
   * Deterministic resolution of an interrupted confirmation. Never calls
   * the Kernel when it may already hold this intent:
   * - CONFIRMING without a persisted proposal: no Kernel call was possible,
   *   so the claim is released back to PREVIEWED;
   * - CONFIRMING with a proposal: the Kernel outcome is recovered (RECOVERED),
   *   resumed only when the Kernel reports ABSENT, or left for reconciliation
   *   when it reports UNKNOWN;
   * - PENDING_APPROVAL: the recovered draft is registered again (idempotent).
   */
  const recoverSend = (sendId: string) =>
    deps.store.withConfirmationLock(sendId, async () => {
      const record = await load(sendId);
      if (record.state === 'CONFIRMING' && !record.proposal) {
        if (record.confirmationProtocol !== 2)
          return {
            ...record,
            kernelCode: 'CONFIRMATION_RECONCILIATION_REQUIRED',
          };
        await deps.store.releaseConfirmation(sendId, nowMs());
        return load(sendId);
      }
      if (record.state === 'CONFIRMING') return recoverConfirmation(record);
      if (record.state === 'PENDING_APPROVAL' && record.proposal) {
        const recovery = await deps.kernel.recover?.(
          record.proposal as SendProposal,
        );
        if (
          recovery?.status === 'RECOVERED' &&
          recovery.decision.status === 'PENDING_APPROVAL' &&
          recovery.decision.draft
        )
          await deps.drafts.register(recovery.decision.draft);
      }
      return record;
    });
  if (deps.recoverOnReady)
    api.addHook('onReady', async () => {
      for (const state of ['CONFIRMING', 'PENDING_APPROVAL'] as const)
        for (const r of await deps.store.inState(state))
          try {
            const after = await recoverSend(r.sendId);
            api.log.info(
              { sendId: r.sendId, from: state, to: after.state },
              'send recovery sweep',
            );
          } catch (error) {
            // One unrecoverable record must not stop the API from starting.
            api.log.error(
              { sendId: r.sendId, err: error },
              'send recovery sweep failed',
            );
          }
    });
  const requireRead = async (request: FastifyRequest, groupId: string) => {
    try {
      assertAdmin(request, deps.adminToken);
      return;
    } catch {
      /* Try a scoped member session. */
    }
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || !(await deps.memberAccess?.verify(token, groupId)))
      throw new HttpError(401, 'MEMBER_ACCESS_REQUIRED');
  };
  api.post('/v1/send/access/challenges', (request, reply) =>
    handle(
      reply,
      async () => {
        const body = z
          .strictObject({
            groupId: GroupParams.shape.groupId,
            principalId: z.string().min(1).max(200),
            scope: z
              .enum(['SEND_READ_PREVIEW', 'MEMBER_CONTRIBUTE'])
              .optional(),
          })
          .parse(request.body);
        const challenge = await deps.memberAccess?.challenge(
          body.groupId.toLowerCase(),
          body.principalId,
          body.scope,
        );
        if (!challenge) throw new HttpError(403, 'SENDER_NOT_MEMBER');
        return challenge;
      },
      201,
    ),
  );
  api.post('/v1/send/access', (request, reply) =>
    handle(
      reply,
      async () => {
        const body = z
          .strictObject({
            challengeId: z.string().regex(/^0x[0-9a-f]{64}$/),
            signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
          })
          .parse(request.body);
        const session = await deps.memberAccess?.issue(
          body.challengeId,
          body.signature as Hex,
        );
        if (!session) throw new HttpError(401, 'MEMBER_SIGNATURE_INVALID');
        return session;
      },
      201,
    ),
  );

  api.get('/v1/groups/:groupId/treasury', (request, reply) =>
    handle(reply, async () => {
      const { groupId } = GroupParams.parse(request.params);
      await requireRead(request, groupId.toLowerCase());
      const view = await deps.treasury.view(groupId.toLowerCase());
      if (!view) throw new HttpError(404, 'GROUP_NOT_FOUND');
      return view;
    }),
  );

  api.get('/v1/send/:groupId/recipients', (request, reply) =>
    handle(reply, async () => {
      const { groupId } = GroupParams.parse(request.params);
      await requireRead(request, groupId.toLowerCase());
      const c = await context(groupId);
      return {
        groupId: c.groupId,
        asset: c.mandate.inputAsset,
        recipients: sendDirectory(c),
      };
    }),
  );

  api.post('/v1/send/previews', (request, reply) =>
    handle(
      reply,
      async () => {
        const body = PreviewBody.parse(request.body);
        await requireRead(request, body.groupId.toLowerCase());
        const c = await context(body.groupId);
        const recipient = sendDirectory(c).find(
          (r) => r.recipientId === body.recipientId,
        );
        if (!recipient)
          throw new FundingError('RECIPIENT_UNKNOWN', body.recipientId);
        const view = await deps.treasury.view(c.groupId);
        if (!view) throw new HttpError(503, 'TREASURY_UNAVAILABLE');
        const now = deps.now();
        let amount: bigint;
        try {
          amount = parseDecimal(body.amount, c.mandate.inputAsset.decimals);
        } catch {
          throw new FundingError('AMOUNT_INVALID', body.amount);
        }
        const guard = await deps.guard.check({
          mandate: c.mandate,
          recipient: recipient.address,
          amount,
        });
        const preview = buildSendPreview({
          groupId: c.groupId,
          mandate: c.mandate,
          recipient,
          amountDecimal: body.amount,
          freeBalance: BigInt(view.core.free),
          guard,
          now,
          ttlSeconds: deps.previewTtlSeconds ?? 300,
          nonce: `${now}:${Math.random()}`,
        });
        await deps.store.savePreview(preview);
        return preview;
      },
      201,
    ),
  );

  api.post('/v1/send', (request, reply) =>
    handle(
      reply,
      async () => {
        const body = ConfirmBody.parse(request.body);
        const stored = await deps.store.preview(body.previewId);
        if (!stored) throw new HttpError(404, 'PREVIEW_NOT_FOUND');
        const now = deps.now();
        const preview = confirmSendPreview(stored, body, now);
        const signer = await deps.members.activeSigner(
          preview.groupId,
          body.sender.memberId,
        );
        if (!signer) throw new HttpError(403, 'SENDER_NOT_MEMBER');
        const signature = body.sender.signature as Hex;
        if (
          !(await verifySendConfirmation(
            signer,
            confirmationOf({ preview }, body.sender.memberId),
            signature,
          ))
        )
          throw new HttpError(401, 'SENDER_SIGNATURE_INVALID');
        await requireGuard(preview);
        const created = await deps.store.createOnce(
          newSendRecord(preview, now * 1000),
        );
        return deps.store.withConfirmationLock(
          created.record.sendId,
          async () => {
            let record = await load(created.record.sendId);
            if (record.state === 'CONFIRMING' && record.proposal)
              return recoverConfirmation(record);
            if (record.state !== 'PREVIEWED' && record.state !== 'CONFIRMING')
              return record;
            const c = await context(preview.groupId);
            if (
              c.mandate.mandateId !== preview.mandateId ||
              c.mandate.version !== preview.mandateVersion
            )
              throw new FundingError(
                'PREVIEW_MISMATCH',
                'mandate changed since preview',
              );
            // A null proposal proves no Kernel call was possible under this protocol.
            if (record.state === 'CONFIRMING') {
              if (record.confirmationProtocol !== 2)
                return {
                  ...record,
                  kernelCode: 'CONFIRMATION_RECONCILIATION_REQUIRED',
                };
              await deps.store.releaseConfirmation(record.sendId, nowMs());
              record = await load(record.sendId);
            }
            const claimed = await deps.store.claimConfirmation(
              record.sendId,
              nowMs(),
            );
            if (!claimed) return load(record.sendId);
            const proposal = await deps.proposer
              .propose({
                mandate: c.mandate,
                recipient: preview.recipient.address,
                amount: BigInt(preview.amount),
                nonce: BigInt(`0x${record.sendId.slice(2, 18)}`).toString(),
              })
              .catch(async (error) => {
                await deps.store.releaseConfirmation(record.sendId, nowMs());
                throw error;
              });
            const prepared = {
              ...claimed,
              sender: { memberId: body.sender.memberId, signer, signature },
              proposal: json(proposal),
            };
            await deps.store.save(prepared);
            const decision = await deps.kernel.authorize({
              intent: proposal.intent,
              risk: proposal.risk,
              simulation: proposal.simulation,
              approvals: [],
            });
            return finishConfirmation(prepared, decision);
          },
        );
      },
      201,
    ),
  );

  api.get('/v1/send/:sendId', (request, reply) =>
    handle(reply, async () => {
      if (!request.headers.authorization)
        throw new HttpError(401, 'MEMBER_ACCESS_REQUIRED');
      const record = await load(SendParams.parse(request.params).sendId);
      await requireRead(request, record.preview.groupId);
      return record;
    }),
  );

  api.post('/v1/send/:sendId/recover', (request, reply) =>
    handle(reply, async () => {
      assertAdmin(request, deps.adminToken);
      return recoverSend(SendParams.parse(request.params).sendId);
    }),
  );

  /** Worker-side: re-runs the Kernel with the verified Mera approvals and returns the grant. */
  api.post('/v1/send/:sendId/authorize', (request, reply) =>
    handle(reply, async () => {
      assertAdmin(request, deps.adminToken);
      const sendId = SendParams.parse(request.params).sendId;
      return deps.store.withConfirmationLock(sendId, async () => {
        const record = await load(sendId);
        const recovery = record.proposal
          ? await deps.kernel.recover?.(record.proposal as SendProposal)
          : null;
        if (
          recovery?.status === 'RECOVERED' &&
          recovery.decision.status === 'AUTHORIZED'
        ) {
          await requireGuard(record.preview);
          const decision = recovery.decision;
          if (
            record.state !== 'PENDING_APPROVAL' &&
            record.state !== 'AUTHORIZED'
          )
            throw new FundingError('INVALID_TRANSITION');
          const next =
            record.state === 'AUTHORIZED'
              ? record
              : advanceSend(
                  record,
                  'AUTHORIZED',
                  nowMs(),
                  'existing Kernel grant reconciled',
                  {
                    grantId: decision.grant.grantId,
                    draftDigest: decision.draft.digest,
                    kernelTier: decision.tier,
                    kernelCode: null,
                  },
                );
          await deps.store.save(next);
          return { record: next, grant: json(decision.grant) };
        }
        if (record.state !== 'PENDING_APPROVAL' || !record.draftDigest)
          throw new FundingError(
            'INVALID_TRANSITION',
            `authorize from ${record.state}`,
          );
        await requireGuard(record.preview);
        const quorum = await deps.drafts.verifiedApprovals(record.draftDigest);
        const proposal = record.proposal as SendProposal;
        const decision = await deps.kernel.authorize({
          intent: proposal.intent,
          risk: proposal.risk,
          simulation: proposal.simulation,
          approvals: quorum.counted,
        });
        if (decision.status !== 'AUTHORIZED') {
          const next =
            decision.status === 'PENDING_APPROVAL'
              ? { ...record, kernelCode: decision.code }
              : advanceSend(record, 'REJECTED', nowMs(), decision.code, {
                  kernelCode: decision.code,
                });
          await deps.store.save(next);
          return { record: next, grant: null as ExecutionGrant | null };
        }
        const next = advanceSend(
          record,
          'AUTHORIZED',
          nowMs(),
          `quorum ${quorum.counted.length}`,
          {
            grantId: decision.grant.grantId,
            kernelTier: decision.tier,
            kernelCode: null,
          },
        );
        await deps.store.save(next);
        return { record: next, grant: json(decision.grant) };
      });
    }),
  );

  api.post('/v1/send/:sendId/execution', (request, reply) =>
    handle(reply, async () => {
      assertAdmin(request, deps.adminToken);
      const record = await load(SendParams.parse(request.params).sendId);
      const body = ExecutionBody.parse(request.body);
      // History is in milliseconds; reject seconds or out-of-order reports.
      const startedAt = record.history[0]?.at ?? 0;
      if (
        body.submittedAt < startedAt ||
        body.confirmedAt < body.submittedAt ||
        body.confirmedAt > nowMs() + 60_000
      )
        throw new HttpError(400, 'EXECUTION_TIME_INVALID');
      const delta =
        BigInt(body.recipientBalanceAfter) -
        BigInt(body.recipientBalanceBefore);
      const submitted = advanceSend(
        record,
        'SUBMITTED',
        body.submittedAt,
        `tx ${body.transactionHash}`,
      );
      const next = advanceSend(
        submitted,
        'CONFIRMED',
        body.confirmedAt,
        `block ${body.blockNumber}`,
        {
          receipt: {
            transactionHash: body.transactionHash as Hex,
            blockNumber: body.blockNumber,
            explorer: body.explorer,
            recipientBalanceBefore: body.recipientBalanceBefore,
            recipientBalanceAfter: body.recipientBalanceAfter,
            recipientDelta: String(delta),
            indexedThroughBlock: 0,
            grantExecutedIndexed: false,
            submittedAt: body.submittedAt,
            confirmedAt: body.confirmedAt,
            indexedAt: 0,
            latencyMs: {
              submitToConfirmed: body.confirmedAt - body.submittedAt,
              submitToIndexed: 0,
            },
          },
        },
      );
      await deps.store.save(next);
      return next;
    }),
  );

  /** Moves CONFIRMED → INDEXED only when the read model shows the GrantExecuted for this intent. */
  api.post('/v1/send/:sendId/reconcile', (request, reply) =>
    handle(reply, async () => {
      assertAdmin(request, deps.adminToken);
      const record = await load(SendParams.parse(request.params).sendId);
      if (record.state === 'INDEXED') return record;
      if (record.state !== 'CONFIRMED' || !record.receipt || !record.intentHash)
        throw new FundingError(
          'INVALID_TRANSITION',
          `reconcile from ${record.state}`,
        );
      const seen = await deps.index.executed(
        record.preview.groupId,
        record.intentHash,
      );
      const r = record.receipt;
      if (
        seen.transactionHash === null ||
        seen.indexedThroughBlock < Number(r.blockNumber)
      )
        return record;
      if (
        seen.transactionHash.toLowerCase() !==
          r.transactionHash.toLowerCase() ||
        seen.tokenAmount !== record.preview.amount ||
        seen.recipient?.toLowerCase() !== record.preview.recipient.address
      )
        throw new HttpError(409, 'INDEXED_EXECUTION_MISMATCH');
      const indexedAt = Math.max(nowMs(), r.confirmedAt);
      const next = advanceSend(
        record,
        'INDEXED',
        indexedAt,
        `indexed through ${seen.indexedThroughBlock}`,
        {
          receipt: {
            ...r,
            indexedThroughBlock: seen.indexedThroughBlock,
            grantExecutedIndexed: true,
            indexedAt,
            latencyMs: {
              ...r.latencyMs,
              submitToIndexed: indexedAt - r.submittedAt,
            },
          },
        },
      );
      await deps.store.save(next);
      return next;
    }),
  );
}

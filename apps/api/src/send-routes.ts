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
  now: () => number;
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
  kernel: { authorize(request: unknown): Promise<AuthorizationDecision> };
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
  previewTtlSeconds?: number;
}

const STATUS: Partial<Record<string, number>> = {
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
  const load = async (sendId: string) => {
    const r = await deps.store.get(sendId);
    if (!r) throw new HttpError(404, 'SEND_NOT_FOUND');
    return r;
  };
  const context = async (groupId: string) => {
    const c = await deps.groups.context(groupId.toLowerCase());
    if (!c) throw new HttpError(404, 'GROUP_NOT_FOUND');
    return c;
  };

  api.get('/v1/groups/:groupId/treasury', (request, reply) =>
    handle(reply, async () => {
      const { groupId } = GroupParams.parse(request.params);
      const view = await deps.treasury.view(groupId.toLowerCase());
      if (!view) throw new HttpError(404, 'GROUP_NOT_FOUND');
      return view;
    }),
  );

  api.get('/v1/send/:groupId/recipients', (request, reply) =>
    handle(reply, async () => {
      const { groupId } = GroupParams.parse(request.params);
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
        const created = await deps.store.createOnce(
          newSendRecord(preview, now),
        );
        if (!created.created) return created.record;
        const c = await context(preview.groupId);
        if (
          c.mandate.mandateId !== preview.mandateId ||
          c.mandate.version !== preview.mandateVersion
        )
          throw new FundingError(
            'PREVIEW_MISMATCH',
            'mandate changed since preview',
          );
        const proposal = await deps.proposer.propose({
          mandate: c.mandate,
          recipient: preview.recipient.address,
          amount: BigInt(preview.amount),
          nonce: BigInt(`0x${created.record.sendId.slice(2, 18)}`).toString(),
        });
        const decision = await deps.kernel.authorize({
          intent: proposal.intent,
          risk: proposal.risk,
          simulation: proposal.simulation,
          approvals: [],
        });
        const base = {
          sender: { memberId: body.sender.memberId, signer, signature },
          proposal: json(proposal),
          intentId: decision.intentId,
          intentHash: decision.intentHash,
          kernelTier: decision.tier,
        };
        let record: SendRecord;
        if (decision.status === 'PENDING_APPROVAL' && decision.draft) {
          await deps.drafts.register(decision.draft);
          record = advanceSend(
            created.record,
            'PENDING_APPROVAL',
            now,
            decision.code,
            {
              ...base,
              draftDigest: decision.draft.digest,
              kernelCode: decision.code,
            },
          );
        } else if (decision.status === 'AUTHORIZED') {
          record = advanceSend(
            created.record,
            'AUTHORIZED',
            now,
            'no approvals required',
            {
              ...base,
              draftDigest: decision.draft.digest,
              grantId: decision.grant.grantId,
            },
          );
        } else {
          record = advanceSend(created.record, 'REJECTED', now, decision.code, {
            ...base,
            kernelCode: decision.code,
          });
        }
        await deps.store.save(record);
        return record;
      },
      201,
    ),
  );

  api.get('/v1/send/:sendId', (request, reply) =>
    handle(reply, async () => load(SendParams.parse(request.params).sendId)),
  );

  /** Worker-side: re-runs the Kernel with the verified Mera approvals and returns the grant. */
  api.post('/v1/send/:sendId/authorize', (request, reply) =>
    handle(reply, async () => {
      assertAdmin(request, deps.adminToken);
      const record = await load(SendParams.parse(request.params).sendId);
      if (record.state !== 'PENDING_APPROVAL' || !record.draftDigest)
        throw new FundingError(
          'INVALID_TRANSITION',
          `authorize from ${record.state}`,
        );
      const quorum = await deps.drafts.verifiedApprovals(record.draftDigest);
      const proposal = record.proposal as SendProposal;
      const decision = await deps.kernel.authorize({
        intent: proposal.intent,
        risk: proposal.risk,
        simulation: proposal.simulation,
        approvals: quorum.counted,
      });
      const now = deps.now();
      if (decision.status !== 'AUTHORIZED') {
        const next =
          decision.status === 'PENDING_APPROVAL'
            ? { ...record, kernelCode: decision.code }
            : advanceSend(record, 'REJECTED', now, decision.code, {
                kernelCode: decision.code,
              });
        await deps.store.save(next);
        return { record: next, grant: null as ExecutionGrant | null };
      }
      const next = advanceSend(
        record,
        'AUTHORIZED',
        now,
        `quorum ${quorum.counted.length}`,
        {
          grantId: decision.grant.grantId,
          kernelTier: decision.tier,
          kernelCode: null,
        },
      );
      await deps.store.save(next);
      return { record: next, grant: json(decision.grant) };
    }),
  );

  api.post('/v1/send/:sendId/execution', (request, reply) =>
    handle(reply, async () => {
      assertAdmin(request, deps.adminToken);
      const record = await load(SendParams.parse(request.params).sendId);
      const body = ExecutionBody.parse(request.body);
      const delta =
        BigInt(body.recipientBalanceAfter) -
        BigInt(body.recipientBalanceBefore);
      const submitted = advanceSend(
        record,
        'SUBMITTED',
        body.submittedAt,
        body.transactionHash,
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
      const indexedAt = Date.now();
      const next = advanceSend(
        record,
        'INDEXED',
        deps.now(),
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

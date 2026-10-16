import { createHash } from 'node:crypto';
import { getAddress } from 'viem';
import { z } from 'zod';
import {
  ChannelLinkService,
  PostgresChannelLinkStore,
  channelLinkTypedData,
  type ChannelLinkConfig,
} from '@synq/identity';
import { PostgresWorkspaceStore } from './postgres.js';
import { WorkspaceError } from './contracts.js';

export const WorkspaceChannelProofSchema = z.strictObject({
  channel: z.literal('telegram'),
  proof: z.unknown(),
});
export const CompleteWorkspaceLinkSchema = z.strictObject({
  challengeId: z.string().regex(/^lnk_[0-9a-f]{32}$/),
  channelCode: z.string().regex(/^[0-9]{8}$/),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export const BindWorkspaceChatSchema = z.strictObject({
  kind: z.enum(['DIRECT', 'GROUP']),
  chatId: z
    .string()
    .regex(/^-?[1-9][0-9]{0,19}$/)
    .optional(),
});
export type WorkspaceDestination = {
  channel: 'telegram';
  kind: 'DIRECT' | 'GROUP';
  chatId: string;
};
export class WorkspaceChannelLinks {
  readonly identity: PostgresChannelLinkStore;
  readonly service: ChannelLinkService;
  constructor(
    readonly workspaces: PostgresWorkspaceStore,
    readonly botId: string,
    config: ChannelLinkConfig,
    private readonly chatAdmin: (
      chatId: string,
      userId: string,
    ) => Promise<boolean>,
  ) {
    this.identity = new PostgresChannelLinkStore(workspaces.pool);
    this.service = new ChannelLinkService(this.identity, {
      ...config,
      now: workspaces.now,
    });
  }
  async migrate() {
    await this.identity.migrate();
  }
  private async member(workspaceId: string, principalId: string) {
    const r = await this.workspaces.pool.query(
      'SELECT wallet,role FROM synq_ws_members WHERE workspace_id=$1 AND principal_id=$2',
      [workspaceId, principalId],
    );
    if (!r.rows[0]) throw new WorkspaceError('WORKSPACE_NOT_FOUND', 404);
    return {
      wallet: getAddress(r.rows[0].wallet),
      role: String(r.rows[0].role),
    };
  }
  async config(workspaceId: string, principalId: string) {
    const member = await this.member(workspaceId, principalId);
    const linked = await this.identity.activeByWallet(
      workspaceId,
      'telegram',
      member.wallet,
    );
    return {
      telegramBotId: this.botId,
      telegramLinked: Boolean(linked),
      groupBindingAllowed: member.role === 'OWNER',
      imessage: 'BLOCKED_REQUIRES_VERIFIED_BRIDGE',
    };
  }
  async request(workspaceId: string, principalId: string, raw: unknown) {
    const body = WorkspaceChannelProofSchema.parse(raw);
    const member = await this.member(workspaceId, principalId);
    const challenge = await this.service.requestLink({
      workspaceId,
      channel: body.channel,
      wallet: member.wallet,
      channelProof: body.proof,
    });
    return {
      challenge,
      typedData: JSON.parse(
        JSON.stringify(channelLinkTypedData(challenge), (_key, value) =>
          typeof value === 'bigint' ? String(value) : value,
        ),
      ) as Record<string, unknown>,
    };
  }
  async complete(workspaceId: string, principalId: string, raw: unknown) {
    const body = CompleteWorkspaceLinkSchema.parse(raw);
    const member = await this.member(workspaceId, principalId);
    const stored = await this.identity.getChallenge(body.challengeId);
    if (
      !stored ||
      stored.challenge.workspaceId !== workspaceId ||
      getAddress(stored.challenge.wallet) !== member.wallet
    )
      throw new WorkspaceError('CHANNEL_LINK_MISMATCH', 403);
    await this.service.completeLink(body);
    return { linked: true };
  }
  async bind(workspaceId: string, principalId: string, raw: unknown) {
    const body = BindWorkspaceChatSchema.parse(raw);
    const member = await this.member(workspaceId, principalId);
    const link = await this.identity.activeByWallet(
      workspaceId,
      'telegram',
      member.wallet,
    );
    if (!link) throw new WorkspaceError('VERIFIED_CHANNEL_LINK_REQUIRED', 403);
    let chatId = link.channelUserId;
    if (body.kind === 'GROUP') {
      if (
        member.role !== 'OWNER' ||
        !body.chatId ||
        !body.chatId.startsWith('-')
      )
        throw new WorkspaceError('CHANNEL_ADMIN_REQUIRED', 403);
      if (!(await this.chatAdmin(body.chatId, link.channelUserId)))
        throw new WorkspaceError('CHANNEL_ADMIN_REQUIRED', 403);
      chatId = body.chatId;
    } else if (body.chatId && body.chatId !== link.channelUserId)
      throw new WorkspaceError('CHANNEL_LINK_MISMATCH', 403);
    const destination: WorkspaceDestination = {
      channel: 'telegram',
      kind: body.kind,
      chatId,
    };
    const digest = createHash('sha256')
      .update(`telegram:${body.kind}:${chatId}`)
      .digest('hex');
    await this.workspaces.transaction(async (sql) => {
      const inserted = await sql.query(
        'INSERT INTO synq_ws_channel_bindings(channel,channel_digest,workspace_id,link_id,destination,identity_link_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING workspace_id',
        [
          'telegram',
          digest,
          workspaceId,
          `${link.linkId}#${digest}`,
          destination,
          link.linkId,
        ],
      );
      if (!inserted.rowCount) {
        const existing = await sql.query(
          'SELECT workspace_id FROM synq_ws_channel_bindings WHERE channel=$1 AND channel_digest=$2',
          ['telegram', digest],
        );
        if (existing.rows[0]?.workspace_id !== workspaceId)
          throw new WorkspaceError('CHANNEL_ALREADY_BOUND');
        await sql.query(
          'UPDATE synq_ws_channel_bindings SET link_id=$3,identity_link_id=$4 WHERE channel=$1 AND channel_digest=$2',
          ['telegram', digest, `${link.linkId}#${digest}`, link.linkId],
        );
      }
    });
    return {
      bound: true,
      channel: 'telegram',
      kind: body.kind,
      chatHint: `${chatId.slice(0, 2)}…${chatId.slice(-4)}`,
    };
  }
  async resolve(chatId: string, kind: 'DIRECT' | 'GROUP', userId: string) {
    const digest = createHash('sha256')
      .update(`telegram:${kind}:${chatId}`)
      .digest('hex');
    const r = await this.workspaces.pool.query(
      'SELECT workspace_id,identity_link_id FROM synq_ws_channel_bindings WHERE channel=$1 AND channel_digest=$2',
      ['telegram', digest],
    );
    if (!r.rows[0]) return null;
    const workspaceId = String(r.rows[0].workspace_id);
    const bindingProof = (await this.identity.listLinks(workspaceId)).find(
      (link) =>
        link.linkId === r.rows[0]!.identity_link_id && link.unlinkedAt === null,
    );
    if (
      !bindingProof ||
      (kind === 'GROUP' &&
        !(await this.chatAdmin(chatId, bindingProof.channelUserId)))
    )
      return null;
    if (kind === 'GROUP') {
      const owner = await this.workspaces.pool.query(
        "SELECT 1 FROM synq_ws_members WHERE workspace_id=$1 AND lower(wallet)=$2 AND role='OWNER'",
        [workspaceId, bindingProof.wallet.toLowerCase()],
      );
      if (!owner.rowCount) return null;
    }
    const link = await this.identity.activeByChannel(
      workspaceId,
      'telegram',
      userId,
    );
    if (!link) return null;
    const m = await this.workspaces.pool.query(
      'SELECT principal_id,role FROM synq_ws_members WHERE workspace_id=$1 AND lower(wallet)=$2',
      [workspaceId, link.wallet.toLowerCase()],
    );
    return m.rows[0]
      ? {
          workspaceId,
          principalId: String(m.rows[0].principal_id),
          role: String(m.rows[0].role),
        }
      : null;
  }
}

import { z } from 'zod';
import { TelegramBotApi, TelegramLoginSchema } from '@synq/channels';
import {
  WorkspaceChannelLinks,
  type PostgresWorkspaceStore,
} from '@synq/workspaces';

const ProofSchema = z.strictObject({
  kind: z.enum(['LOGIN', 'MINIAPP']),
  data: z.unknown(),
});
export async function workspaceChannelRuntime(
  store: PostgresWorkspaceStore,
  token: string,
  transport?: { baseUrl?: string; fetch?: typeof fetch },
) {
  const api = new TelegramBotApi({ token, ...transport });
  const links = new WorkspaceChannelLinks(
    store,
    token.split(':')[0]!,
    {
      verifiers: {
        telegram: (raw, now) => {
          const parsed = ProofSchema.safeParse(raw);
          if (!parsed.success) return null;
          if (parsed.data.kind === 'LOGIN') {
            const payload = TelegramLoginSchema.safeParse(parsed.data.data);
            if (!payload.success) return null;
            const id = api.verifyLogin(payload.data, now);
            return id
              ? {
                  channelUserId: id,
                  proofId: `0x${payload.data.hash}` as `0x${string}`,
                }
              : null;
          }
          const mini = api.verifyMiniAppInitData(parsed.data.data, now);
          return mini
            ? {
                channelUserId: mini.telegramUserId,
                proofId: `0x${mini.hash.replace(/^0x/, '')}` as `0x${string}`,
              }
            : null;
        },
      },
      deliverCode: async ({ channelUserId, code }) => {
        const user = Number(channelUserId);
        if (!Number.isSafeInteger(user) || user < 1)
          throw new Error('INVALID_CHANNEL_ID');
        await api.call('sendMessage', {
          chat_id: user,
          text: `Synq private wallet-link code: ${code}. Enter it on the Synq page within five minutes. This links identity only and cannot approve money.`,
        });
      },
    },
    async (chatId, userId) => {
      const chat = Number(chatId);
      const user = Number(userId);
      if (!Number.isSafeInteger(chat) || !Number.isSafeInteger(user))
        return false;
      try {
        const member = z
          .looseObject({ status: z.string() })
          .parse(
            await api.call('getChatMember', { chat_id: chat, user_id: user }),
          );
        return member.status === 'creator' || member.status === 'administrator';
      } catch {
        return false;
      }
    },
  );
  await links.migrate();
  return links;
}

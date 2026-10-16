import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import { channelLinkTypedData } from '@synq/identity';
import {
  signTelegramLoginForTest,
  verifyTelegramLogin,
  TelegramLoginSchema,
} from '@synq/channels';
import {
  PostgresWorkspaceStore,
  WorkspaceChannelLinks,
  loginTypedData,
} from '@synq/workspaces';
import { testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from './pg.js';

let pool: Pool;
let now = 2_000_000_000;
let store: PostgresWorkspaceStore;
const botToken = `1000001:${randomBytes(24).toString('base64url')}`;
const codes = new Map<string, string>();
let admin = true;
let links: WorkspaceChannelLinks;
beforeAll(async () => {
  pool = await workspacePool(
    testDatabaseUrl(
      'SYNQ_WORKSPACE_LINKS_TEST_DATABASE_URL',
      'synq_m2_workspace_links',
    ),
  );
  store = new PostgresWorkspaceStore(pool, 'https://synq.test', () => now);
  await store.migrate();
  links = new WorkspaceChannelLinks(
    store,
    '1000001',
    {
      verifiers: {
        telegram: (proof, at) => {
          const id = verifyTelegramLogin(proof, botToken, at);
          return id
            ? {
                channelUserId: id,
                proofId:
                  `0x${TelegramLoginSchema.parse(proof).hash}` as `0x${string}`,
              }
            : null;
        },
      },
      deliverCode: async (input) => {
        codes.set(input.challengeId, input.code);
      },
    },
    async () => admin,
  );
  await links.migrate();
});
afterAll(async () => {
  await pool?.end();
});
async function user() {
  const account = privateKeyToAccount(generatePrivateKey());
  const c = await store.challenge({ wallet: account.address });
  const session = await store.login(
    c.id,
    await account.signTypedData({
      ...loginTypedData(c),
      message: {
        ...loginTypedData(c).message,
        wallet: getAddress(c.wallet),
        expiresAt: BigInt(c.expiresAt),
      },
    }),
  );
  const { workspace } = await store.create(session.principalId, {
    displayName: 'Linked workspace',
    kind: 'GROUP',
  });
  return { account, session, workspace };
}
async function linked(
  f: Awaited<ReturnType<typeof user>>,
  telegramUserId: number,
) {
  now++;
  const proof = signTelegramLoginForTest(
    { id: telegramUserId, first_name: 'Wallet owner', auth_date: now },
    botToken,
  );
  const c = await links.request(f.workspace.id, f.session.principalId, {
    channel: 'telegram',
    proof,
  });
  const signature = await f.account.signTypedData(
    channelLinkTypedData(c.challenge),
  );
  const body = {
    challengeId: c.challenge.challengeId,
    channelCode: codes.get(c.challenge.challengeId)!,
    signature,
  };
  await links.complete(f.workspace.id, f.session.principalId, body);
  return { proof, c, body };
}
describe('G2 verified workspace channel links — LOCAL_FIXTURE transport', () => {
  it('refuses unsigned identity claims and never links from a username or phone alone', async () => {
    const f = await user();
    await expect(
      links.request(f.workspace.id, f.session.principalId, {
        channel: 'telegram',
        proof: {
          id: 2001,
          username: 'someone',
          auth_date: now,
          hash: '00'.repeat(32),
        },
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      links.bind(f.workspace.id, f.session.principalId, {
        kind: 'DIRECT',
        chatId: '2001',
      }),
    ).rejects.toMatchObject({ code: 'VERIFIED_CHANNEL_LINK_REQUIRED' });
    expect(await links.resolve('2001', 'DIRECT', '2001')).toBeNull();
  });
  it('requires the delivered code and signature, rejects proof/challenge replay, and isolates tenants', async () => {
    const f = await user();
    const outsider = await user();
    now++;
    const proof = signTelegramLoginForTest(
      { id: 2002, first_name: 'Wallet owner', auth_date: now },
      botToken,
    );
    const c = await links.request(f.workspace.id, f.session.principalId, {
      channel: 'telegram',
      proof,
    });
    expect(c).not.toHaveProperty('channelCode');
    await expect(
      links.request(f.workspace.id, f.session.principalId, {
        channel: 'telegram',
        proof,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      links.request(f.workspace.id, f.session.principalId, {
        channel: 'telegram',
        proof: {
          ...proof,
          id: String(proof.id),
          auth_date: String(proof.auth_date),
        },
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const signature = await f.account.signTypedData(
      channelLinkTypedData(c.challenge),
    );
    const wrongCode =
      codes.get(c.challenge.challengeId) === '00000000'
        ? '00000001'
        : '00000000';
    await expect(
      links.complete(f.workspace.id, f.session.principalId, {
        challengeId: c.challenge.challengeId,
        channelCode: wrongCode,
        signature,
      }),
    ).rejects.toThrow();
    const body = {
      challengeId: c.challenge.challengeId,
      channelCode: codes.get(c.challenge.challengeId)!,
      signature,
    };
    await expect(
      links.complete(outsider.workspace.id, outsider.session.principalId, body),
    ).rejects.toMatchObject({ code: 'CHANNEL_LINK_MISMATCH' });
    expect(
      await links.complete(f.workspace.id, f.session.principalId, body),
    ).toEqual({ linked: true });
    await expect(
      links.complete(f.workspace.id, f.session.principalId, body),
    ).rejects.toMatchObject({ code: 'CHALLENGE_CONSUMED' });
    expect(
      (await links.config(f.workspace.id, f.session.principalId))
        .telegramLinked,
    ).toBe(true);
  });
  it('derives a DM destination from the provider identity and refuses another recipient', async () => {
    const f = await user();
    await linked(f, 2003);
    await expect(
      links.bind(f.workspace.id, f.session.principalId, {
        kind: 'DIRECT',
        chatId: '9999',
      }),
    ).rejects.toMatchObject({ code: 'CHANNEL_LINK_MISMATCH' });
    await links.bind(f.workspace.id, f.session.principalId, { kind: 'DIRECT' });
    expect(await links.resolve('2003', 'DIRECT', '2003')).toMatchObject({
      workspaceId: f.workspace.id,
      principalId: f.session.principalId,
      role: 'OWNER',
    });
    expect(await links.resolve('2003', 'DIRECT', '9999')).toBeNull();
    const active = await links.identity.activeByWallet(
      f.workspace.id,
      'telegram',
      f.account.address,
    );
    await links.identity.endLink(active!.linkId, now, 'WALLET', null);
    expect(await links.resolve('2003', 'DIRECT', '2003')).toBeNull();
  });
  it('requires current platform admin status and allows one workspace per group under races', async () => {
    const a = await user();
    const b = await user();
    await linked(a, 2004);
    await linked(b, 2005);
    admin = false;
    await expect(
      links.bind(a.workspace.id, a.session.principalId, {
        kind: 'GROUP',
        chatId: '-10001',
      }),
    ).rejects.toMatchObject({ code: 'CHANNEL_ADMIN_REQUIRED' });
    admin = true;
    const raced = await Promise.allSettled([
      links.bind(a.workspace.id, a.session.principalId, {
        kind: 'GROUP',
        chatId: '-10001',
      }),
      links.bind(b.workspace.id, b.session.principalId, {
        kind: 'GROUP',
        chatId: '-10001',
      }),
    ]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winner = raced[0]!.status === 'fulfilled' ? a : b;
    const id = winner === a ? '2004' : '2005';
    expect((await links.resolve('-10001', 'GROUP', id))?.workspaceId).toBe(
      winner.workspace.id,
    );
    admin = false;
    expect(await links.resolve('-10001', 'GROUP', id)).toBeNull();
    admin = true;
    await pool.query(
      "UPDATE synq_ws_members SET role='VIEWER' WHERE workspace_id=$1 AND principal_id=$2",
      [winner.workspace.id, winner.session.principalId],
    );
    expect(await links.resolve('-10001', 'GROUP', id)).toBeNull();
  });
});

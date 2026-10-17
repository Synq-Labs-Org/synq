import { it, expect } from 'vitest';
import pg from 'pg';
import type { PublicClient, Hex } from 'viem';
import { MandateSchema, type PendingIntentView } from '@synq/schemas';
import { artifactHash, onchainMandateId } from '@synq/kernel';
import {
  PostgresIdentityStore,
  StoreApprovalLedger,
  StoreMembershipDirectory,
} from '@synq/identity/server';
import {
  signMeraSendAccess,
  signMeraSendConfirmation,
} from '@synq/identity/mera-browser';
import {
  PostgresSendStore,
  PostgresFundingSessionStore,
  type SendPreview,
  type SendRecord,
} from '@synq/funding';
import { productionSendPorts } from '../../apps/api/src/send-runtime.js';
import { PostgresSendAccessStore } from '../../apps/api/src/send-access-store.js';
import { createV1Api } from '../../apps/api/src/v1/app.js';
import { sendRoutes, confirmationOf } from '../../apps/api/src/send-routes.js';
import type { ReadModelRuntime } from '../../apps/api/src/server.js';
import {
  sandboxMandate,
  sandboxManifest,
  type SandboxGroup,
} from '../api/kernel-fixture.js';
import {
  ADMIN,
  MODULE,
  rpId,
  origin,
  client,
  enrollViaApi,
  joinViaApi,
  approvalSignature,
} from '../api/v1-harness.js';
import { addr, word } from '../identity/fixtures.js';
import { ensureDatabase } from '../../apps/demo/src/testnet-config.js';
import { testDatabaseUrl } from '../durable/pg.js';

it('I-04 production Send keeps its designated terms, durable access and approvals when a wider independent treasury mandate is indexed', async () => {
  const url = testDatabaseUrl(
    'SYNQ_UNUSED_TEST_DATABASE_URL',
    'synq_p08_critic_e2e_selection',
  );
  await ensureDatabase(url);
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  const identity = new PostgresIdentityStore(pool);
  await identity.migrate();
  const sends = new PostgresSendStore(pool);
  await sends.migrate();
  const funding = new PostgresFundingSessionStore(pool);
  await funding.migrate();
  await new PostgresSendAccessStore(pool).migrate();
  await pool.query(
    'CREATE TABLE IF NOT EXISTS critic_current_mandates (run_id text NOT NULL, data jsonb NOT NULL)',
  );
  const stamp = String(Date.now());
  let api = createV1Api({
    store: identity,
    config: { profile: 'sandbox/monad-testnet', rpId, origin },
    adminToken: ADMIN,
    executionModules: { 10143: MODULE },
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
  });
  try {
    const humans = [
      await enrollViaApi(api, `critic-a-${stamp}`),
      await enrollViaApi(api, `critic-b-${stamp}`),
    ];
    const groupId = word(Date.now());
    const group: SandboxGroup = {
      groupId,
      chainGroupId: groupId,
      account: addr(Number(stamp)),
      executor: addr(Number(stamp) + 1),
      recipient: humans[1]!.record.signer,
      members: humans.map((h, i) => ({
        memberId: `member_${i}`,
        signer: h.record.signer.toLowerCase() as Hex,
      })),
    };
    const c = client(api);
    expect(
      (
        await c.call(
          'POST',
          '/v1/groups',
          {
            groupId,
            chainGroupId: groupId,
            chainId: 10143,
            account: group.account,
            owners: group.members.map((m) => m.signer),
            threshold: 2,
            executors: [group.executor],
          },
          c.admin,
        )
      ).status,
    ).toBe(201);
    for (const [i, h] of humans.entries())
      expect((await joinViaApi(api, groupId, h, `member_${i}`)).status).toBe(
        201,
      );
    const now = () => Math.floor(Date.now() / 1000);
    const base = sandboxMandate({ ...group, recipient: addr(0xcafe) }, now());
    const send = MandateSchema.parse({
      ...base,
      recipients: [{ address: group.recipient, purpose: 'MEMBER_WITHDRAWAL' }],
      perActionCap: '2000000',
      cumulativeBudget: '10000000',
      tierPolicy: {
        ...base.tierPolicy,
        tokenSpend: { autoMax: '0', reviewMax: '0' },
        withdrawal: 'CONSENSUS',
      },
    });
    const wide = MandateSchema.parse({
      ...send,
      mandateId: 'independent_treasury',
      perActionCap: '25000000',
      cumulativeBudget: '100000000',
      recipients: [
        ...send.recipients,
        { address: addr(0xbad), purpose: 'COUNTERPARTY' },
      ],
    });
    const artifacts = [send, wide].map((m) => ({
      groupId: m.groupId,
      account: m.account,
      mandateId: onchainMandateId(m),
      version: m.version,
      mandateHash: artifactHash(m),
      artifact: m,
    }));
    for (const artifact of artifacts)
      await pool.query(
        'INSERT INTO critic_current_mandates(run_id,data) VALUES($1,$2)',
        [stamp, JSON.stringify(artifact)],
      );
    const recordedClient = {
      getChainId: async () => 10143,
      getBlockNumber: async () => 100n,
      readContract: async () => false,
      getBlock: async () => ({
        number: 100n,
        hash: word(100),
        timestamp: BigInt(now()),
      }),
      call: async () => ({ data: word(1) }),
    } as unknown as PublicClient;
    const readModel = {
      client: recordedClient,
      reader: {
        currentMandateArtifacts: async () =>
          (
            await pool.query(
              'SELECT data FROM critic_current_mandates WHERE run_id=$1',
              [stamp],
            )
          ).rows.map((r) => r.data),
      },
    } as unknown as ReadModelRuntime;
    const { Kernel } = await import('@synq/kernel');
    const authoritative = new Kernel({
      network: send.network,
      executionModule: MODULE,
      clock: { now },
      approvalLedger: new StoreApprovalLedger(identity),
      membershipDirectory: new StoreMembershipDirectory(identity),
      freshness: {
        probe: {
          observe: async () => ({
            chainId: 10143,
            headBlock: 100,
            indexedThroughBlock: 100,
            accountPaused: false,
            mandate: { active: true, version: 1, minValidVersion: 1 },
            owners: group.members.map((m) => m.signer),
            threshold: 2,
          }),
        },
        maxLagBlocks: 0,
      },
      plugins: [sandboxManifest],
      mandates: [send, wide],
      auditKey: new Uint8Array(32).fill(5),
    });
    authoritative.observeBalance(
      { account: group.account, asset: send.inputAsset, balance: '300000000' },
      '100',
    );
    const production = () => ({
      ...productionSendPorts({
        identity,
        identityConfig: { profile: 'sandbox/monad-testnet', rpId, origin },
        readModel,
        kernel: authoritative,
        authorizer: authoritative,
        executionModule: MODULE,
        adminToken: ADMIN,
        sends,
        funding,
        sendMandateId: 'mandate_send',
      }),
      treasury: {
        view: async () => ({ core: { free: '300000000' } }) as never,
      },
    });
    const register = async () => {
      await api.register(sendRoutes, { ...production(), store: sends });
      await api.ready();
    };
    await api.close();
    api = createV1Api({
      store: identity,
      config: { profile: 'sandbox/monad-testnet', rpId, origin },
      adminToken: ADMIN,
      executionModules: { 10143: MODULE },
      rateLimit: { capacity: 1000, refillPerSecond: 1000 },
    });
    await register();
    expect(
      (await production().groups.context(groupId))?.mandate.mandateId,
    ).toBe('mandate_send');
    expect(
      (await production().groups.context(groupId))?.mandate.perActionCap,
    ).toBe('2000000');
    expect(await production().groups.context(word(0))).toBeNull();
    const challenge = await production().memberAccess!.challenge(
      groupId,
      humans[0]!.record.principalId,
    );
    expect(challenge).not.toBeNull();
    const session = await production().memberAccess!.issue(
      challenge!.challengeId,
      await signMeraSendAccess(humans[0]!.record, challenge!, {
        webAuthnClient: humans[0]!.auth,
      }),
    );
    expect(session).not.toBeNull();
    await api.close();
    api = createV1Api({
      store: new PostgresIdentityStore(pool),
      config: { profile: 'sandbox/monad-testnet', rpId, origin },
      adminToken: ADMIN,
      executionModules: { 10143: MODULE },
      rateLimit: { capacity: 1000, refillPerSecond: 1000 },
    });
    await register();
    expect(
      await production().memberAccess!.verify(session!.token, groupId),
    ).toBe(true);
    const member = { authorization: `Bearer ${session!.token}` };
    const restarted = client(api);
    const directory = await restarted.call(
      'GET',
      `/v1/send/${groupId}/recipients`,
      undefined,
      member,
    );
    expect(directory.status).toBe(200);
    const recipients = (directory.body.recipients ?? directory.body) as {
      recipientId: string;
      address: string;
      sendable: boolean;
    }[];
    const recipient = recipients.find(
      (r) => r.address.toLowerCase() === group.recipient.toLowerCase(),
    )!;
    expect(recipient.sendable).toBe(true);
    expect(
      recipients.some((r) => r.address === addr(0xbad) && r.sendable),
    ).toBe(false);
    expect(
      (
        await restarted.call(
          'POST',
          '/v1/send/previews',
          { groupId, recipientId: recipient.recipientId, amount: '3' },
          member,
        )
      ).body.error,
    ).toBe('AMOUNT_EXCEEDS_MANDATE');
    const previewResponse = await restarted.call(
      'POST',
      '/v1/send/previews',
      { groupId, recipientId: recipient.recipientId, amount: '1' },
      member,
    );
    expect(previewResponse.status).toBe(201);
    const preview = previewResponse.body as unknown as SendPreview;
    const signature = await signMeraSendConfirmation(
      humans[0]!.record,
      confirmationOf({ preview }, 'member_0'),
      { webAuthnClient: humans[0]!.auth },
    );
    const proposed = await restarted.call('POST', '/v1/send', {
      previewId: preview.previewId,
      digest: preview.digest,
      recipientAddress: preview.recipient.address,
      amount: preview.amount,
      chainId: preview.chainId,
      sender: { memberId: 'member_0', signature },
    });
    expect(proposed.status).toBe(201);
    const record = proposed.body as unknown as SendRecord;
    expect(record.state, record.kernelCode ?? 'no Kernel code').toBe(
      'PENDING_APPROVAL',
    );
    const viewResponse = await restarted.call(
      'GET',
      `/v1/intents/${record.intentHash}`,
    );
    const view = viewResponse.body as unknown as PendingIntentView;
    for (const [i, h] of humans.entries()) {
      const signed = await approvalSignature(
        api,
        h,
        `member_${i}`,
        view.draft,
        view.preview,
        now,
      );
      const approved = await restarted.call('POST', '/v1/approvals', {
        challengeId: signed.challenge.challengeId,
        grantSignature: signed.grantSignature,
        attestationSignature: signed.attestationSignature,
      });
      expect(approved.status).toBe(201);
    }
    const issued = await restarted.call(
      'POST',
      `/v1/send/${record.sendId}/authorize`,
      {},
      restarted.admin,
    );
    expect(issued.status).toBe(200);
    const grant = issued.body.grant as {
      mandateId: string;
      maxInputAmount: string;
      recipient: string;
    };
    expect(grant).not.toBeNull();
    expect(grant.mandateId).toBe(send.mandateId);
    expect(grant.maxInputAmount).toBe('1000000');
    expect(grant.recipient).toBe(group.recipient.toLowerCase());
    expect(
      (
        await productionSendPorts({
          identity,
          identityConfig: { profile: 'sandbox/monad-testnet', rpId, origin },
          readModel,
          kernel: authoritative,
          authorizer: authoritative,
          executionModule: MODULE,
          adminToken: ADMIN,
          sends,
          funding,
          sendMandateId: 'missing',
        })
          .groups.context(groupId)
          .catch((e) => e)
      ).code,
    ).toBe('SEND_MANDATE_UNAVAILABLE');
  } finally {
    await api.close();
    await pool.end();
  }
}, 60000);

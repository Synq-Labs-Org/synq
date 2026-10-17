import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { anvil } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startAnvil } from '../../apps/demo/src/anvil.js';
import { registerAppRoutes } from '../../apps/demo/src/app-routes.js';
import { PostgresWorkspaceStore } from '../../packages/workspaces/src/postgres.js';
import { WorkspaceDeviceSessions } from '../../packages/workspaces/src/device-sessions.js';
import { loginTypedData } from '../../packages/workspaces/src/contracts.js';
import { WorkspaceLeads } from '../../packages/workspaces/src/leads.js';
import {
  WorkspaceOffers,
  commercialPolicyTypedData,
  type OfferTerms,
} from '../../packages/workspaces/src/offers.js';
import { AgentEvents } from '../../packages/workspaces/src/agent-events.js';
import { WorkspaceAgreements } from '../../packages/workspaces/src/agreements.js';
import { AgreementEscrow } from '../../workers/execution/src/agreement-escrow.js';
import { testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from './pg.js';

// Compiled by `forge build` before the integration run (CI typechecks earlier).
const escrowArtifact = JSON.parse(
  readFileSync(
    new URL(
      '../../contracts/out/SynqMilestoneEscrow.sol/SynqMilestoneEscrow.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { abi: Abi; bytecode: { object: string } };
const tokenArtifact = JSON.parse(
  readFileSync(
    new URL(
      '../../contracts/out/LocalSixDecimalApprovalToken.sol/LocalSixDecimalApprovalToken.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { abi: Abi; bytecode: { object: string } };

/*
 * Deal closing with an outside client: the client is the lead's bound web
 * identity and never a workspace member; both wallets sign the exact accepted
 * terms; the client funds a real SynqMilestoneEscrow from their own wallet on
 * a local Anvil chain, and only a mined transaction that matches the
 * agreement marks it FUNDED. LOCAL_FIXTURE proof only.
 */

const origin = 'https://synq.test';
const clock = 2_000_000_000;
let now = clock;
let node: Awaited<ReturnType<typeof startAnvil>>;
let chain: PublicClient;
let pool: Pool;
let store: PostgresWorkspaceStore;
let leads: WorkspaceLeads;
let offers: WorkspaceOffers;
let agreements: WorkspaceAgreements;
let app: FastifyInstance;
let tokenAddress: Address;
let escrowAddress: Address;
const deployer = privateKeyToAccount(generatePrivateKey());
// Responses and artifacts are checked field by field below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
let ip = 0;
const from = () => `10.1.${Math.floor(++ip / 250)}.${ip % 250}`;

const wallet = (account: ReturnType<typeof privateKeyToAccount>) =>
  createWalletClient({
    chain: anvil,
    transport: http(node.url),
    account,
  });

async function login() {
  const a = privateKeyToAccount(generatePrivateKey());
  const c = await store.challenge({ wallet: a.address, audience: 'native' });
  const signature = await a.signTypedData({
    ...loginTypedData(c),
    message: {
      ...loginTypedData(c).message,
      wallet: getAddress(c.wallet),
      expiresAt: BigInt(c.expiresAt),
    },
  });
  const s = await store.login(c.id, signature);
  return { a, principalId: s.principalId, token: s.token };
}
type Person = Awaited<ReturnType<typeof login>>;

const bearer = (p: Person) => ({ authorization: `Bearer ${p.token}` });
const mutate = (p: Person) => ({
  ...bearer(p),
  'idempotency-key': randomUUID(),
});
async function call(
  p: Person,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
) {
  const r = await app.inject({
    method,
    url,
    remoteAddress: from(),
    headers: method === 'POST' ? mutate(p) : bearer(p),
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { status: r.statusCode, body: r.json() as Record<string, Json> };
}

type Wire = {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};
/** The wire JSON has uint256 as decimal strings; wallets take bigints. */
function signable(td: Wire) {
  const conv = (type: string, v: unknown): unknown => {
    if (type.endsWith('[]'))
      return (v as unknown[]).map((x) => conv(type.slice(0, -2), x));
    if (type.startsWith('uint')) return BigInt(v as string);
    const fields = td.types[type];
    if (fields)
      return Object.fromEntries(
        fields.map((f) => [
          f.name,
          conv(f.type, (v as Record<string, unknown>)[f.name]),
        ]),
      );
    return v;
  };
  return {
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: conv(td.primaryType, td.message),
  } as never;
}
const sign = (a: Person['a'], td: Wire) =>
  a.signTypedData(signable(td)) as Promise<Hex>;

const policy = {
  catalog: [
    {
      sku: 'logo',
      description: 'Logo design',
      unitUnits: '100000000',
      floorUnits: '85000000',
      maxQuantity: 3,
      leadTimeDays: 7,
      rushSurchargeBps: 2000,
      capacity: null,
    },
  ],
  maxDiscountBps: 1000,
  minDepositBps: 3000,
  maxMilestones: 3,
  offerTtlSeconds: 86400,
  ownerApprovalAboveUnits: '500000000',
  capacityFreshSeconds: 7 * 86400,
};
const terms = (over: Partial<OfferTerms> = {}): OfferTerms => ({
  lines: [{ sku: 'logo', quantity: 1, unitUnits: '95000000' }],
  rush: false,
  deliveryDays: 10,
  milestones: [
    { label: 'Deposit', units: '30000000', dueInDays: 0 },
    { label: 'Final files', units: '65000000', dueInDays: 10 },
  ],
  depositUnits: '30000000',
  note: '',
  ...over,
});
const TOTAL = 95_000_000n;

async function deploy(artifact: Json, args: unknown[] = []) {
  const w = wallet(deployer);
  const hash = await w.deployContract({
    abi: artifact.abi,
    bytecode: (artifact.bytecode.object ?? artifact.bytecode) as Hex,
    args: args as never,
  });
  const r = await chain.waitForTransactionReceipt({ hash });
  expect(r.status).toBe('success');
  return r.contractAddress!;
}

/** A business with an accepted offer and a client who redeemed a web invite. */
async function deal(opts: { vault?: boolean } = {}) {
  const owner = await login();
  const client = await login();
  const { workspace: w } = await store.create(owner.principalId, {
    displayName: 'Example Studio',
    kind: 'BUSINESS',
  });
  const vault = getAddress(privateKeyToAccount(generatePrivateKey()).address);
  if (opts.vault)
    await pool.query(
      "UPDATE synq_workspaces SET status='ACTIVE', vault=$2, threshold=1 WHERE id=$1",
      [w.id, vault],
    );
  const p = await offers.proposePolicy(w.id, owner.principalId, policy);
  await offers.approvePolicy(
    w.id,
    owner.principalId,
    p.version,
    await owner.a.signTypedData(
      commercialPolicyTypedData(w.id, p.version, p.policyHash),
    ),
  );
  const invite = await leads.invite(w.id, owner.principalId, {
    source: 'WEB',
    expiresInSeconds: 3600,
  });
  const lead = await leads.redeem({
    token: invite.webUrl.split('/').at(-1)!,
    channel: 'web',
    identity: client.principalId,
    deliveryRef: null,
    principalId: client.principalId,
  });
  const sent = await offers.send({
    workspaceId: w.id,
    leadId: lead.leadId,
    terms: terms(),
    actor: { kind: 'AGENT' },
  });
  if (!sent.sent) throw new Error('offer not sent');
  await offers.accept(lead.leadId, sent.offer.offerId, 1);
  return {
    owner,
    client,
    workspaceId: w.id,
    leadId: lead.leadId,
    offerId: sent.offer.offerId,
    clientWallet: privateKeyToAccount(generatePrivateKey()),
    vault,
  };
}
type Deal = Awaited<ReturnType<typeof deal>>;

const clientUrl = (d: Deal, tail: string) =>
  `/v3/client/leads/${d.leadId}/${tail}`;
const staffUrl = (d: Deal, tail: string) =>
  `/v3/workspaces/${d.workspaceId}/leads/${d.leadId}/${tail}`;

async function linkWallet(d: Deal) {
  const t = await call(
    d.client,
    'GET',
    `${clientUrl(d, 'wallet-link')}?wallet=${d.clientWallet.address}`,
  );
  expect(t.status).toBe(200);
  const signature = await sign(d.clientWallet, t.body.typedData);
  return call(d.client, 'POST', clientUrl(d, 'wallet'), {
    wallet: d.clientWallet.address,
    expiresAt: t.body.expiresAt,
    signature,
  });
}
const submitBody = (a: Record<string, Json>, signature: Hex) => ({
  agreementId: a.agreementId,
  offerVersion: a.offerVersion,
  termsHash: a.termsHash,
  signature,
});
async function agreementFor(d: Deal) {
  const r = await call(d.owner, 'GET', staffUrl(d, 'agreement'));
  expect(r.status).toBe(200);
  return r.body.agreement as Record<string, Json>;
}
async function signedDeal(opts: { vault?: boolean } = {}) {
  const d = await deal(opts);
  expect((await linkWallet(d)).status).toBe(200);
  const a = await agreementFor(d);
  const c = await call(
    d.client,
    'POST',
    clientUrl(d, 'agreement/signature'),
    submitBody(a, await sign(d.clientWallet, a.typedData)),
  );
  expect(c.status).toBe(200);
  const o = await call(
    d.owner,
    'POST',
    staffUrl(d, 'agreement/owner-signature'),
    submitBody(a, await sign(d.owner.a, a.typedData)),
  );
  expect(o.status).toBe(200);
  return { d, a, signed: o.body };
}
const mint = async (to: Address, amount: bigint) => {
  const h = await wallet(deployer).writeContract({
    address: tokenAddress,
    abi: tokenArtifact.abi,
    functionName: 'mint',
    args: [to, amount],
  } as never);
  await chain.waitForTransactionReceipt({ hash: h });
};
const balance = (a: Address) =>
  chain.readContract({
    address: tokenAddress,
    abi: tokenArtifact.abi,
    functionName: 'balanceOf',
    args: [a],
  } as never) as Promise<bigint>;
async function fund(d: Deal) {
  await mint(d.clientWallet.address, TOTAL);
  await chain.request({
    method: 'anvil_setBalance' as never,
    params: [d.clientWallet.address, '0x56BC75E2D63100000'] as never,
  });
  const prep = await call(d.client, 'POST', clientUrl(d, 'agreement/escrow'));
  expect(prep.status).toBe(200);
  return prep.body;
}
async function send(d: Deal, to: Address, data: Hex, wait = true) {
  const hash = await wallet(d.clientWallet).sendTransaction({
    to,
    data,
    value: 0n,
  });
  if (wait) await chain.waitForTransactionReceipt({ hash });
  return hash;
}
const submitFunding = (d: Deal, hash: Hex) =>
  call(d.client, 'POST', clientUrl(d, 'agreement/escrow/submit'), {
    openTxHash: hash,
  });
const stage = async (d: Deal) =>
  String(
    (await pool.query('SELECT stage FROM synq_leads WHERE id=$1', [d.leadId]))
      .rows[0].stage,
  );

beforeAll(async () => {
  node = await startAnvil();
  chain = createPublicClient({
    chain: anvil,
    transport: http(node.url),
  }) as PublicClient;
  await chain.request({
    method: 'anvil_setBalance' as never,
    params: [deployer.address, '0x56BC75E2D63100000'] as never,
  });
  tokenAddress = await deploy(tokenArtifact);
  escrowAddress = await deploy(escrowArtifact, [tokenAddress]);
  pool = await workspacePool(
    testDatabaseUrl('SYNQ_WORKSPACES_TEST_DATABASE_URL', 'synq_m2_workspaces'),
  );
  store = new PostgresWorkspaceStore(pool, origin, () => now);
  await store.migrate();
  leads = new WorkspaceLeads(store, {
    webOrigin: origin,
    telegramBot: () => 'asksynqbot',
  });
  await leads.migrate();
  offers = new WorkspaceOffers(store);
  await offers.migrate();
  const events = new AgentEvents(store);
  await events.migrate();
  agreements = new WorkspaceAgreements(store, { events });
  await Promise.all([agreements.migrate(), agreements.migrate()]);
  const escrow = new AgreementEscrow(agreements, chain, async () => ({
    escrow: escrowAddress,
    token: tokenAddress,
    chainId: anvil.id,
    proofLevel: 'LOCAL_FIXTURE',
  }));
  app = Fastify();
  registerAppRoutes(app, {
    store,
    devices: new WorkspaceDeviceSessions(store),
    leads,
    offers,
    agreements,
    agreementEscrow: () => escrow,
    events,
  });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await node?.close();
});

describe('deal agreements with an outside client', () => {
  it('closes a deal end to end without the client ever joining the workspace', async () => {
    const { d, a, signed } = await signedDeal({ vault: true });
    expect(a.status).toBe('PENDING_SIGNATURES');
    expect(a.signatures).toEqual({ client: null, owner: null });
    expect(a.typedData.domain).toMatchObject({
      name: 'Synq Deal Agreement',
      version: '1',
      chainId: 5042002,
    });
    expect(a.clientWallet).toBe(d.clientWallet.address);
    expect(a.ownerWallet).toBe(getAddress(d.owner.a.address));
    expect(a.total.units).toBe(String(TOTAL));
    expect(signed.status).toBe('SIGNED');
    expect(await stage(d)).toBe('SIGNED');

    const prep = await fund(d);
    expect(prep.from).toBe(d.clientWallet.address);
    expect(prep.transactions.map((t: Json) => t.step)).toEqual([
      'APPROVE',
      'OPEN',
    ]);
    expect(await stage(d)).toBe('FUNDING_PENDING');
    // Preparing again returns the same exact call.
    const again = await call(
      d.client,
      'POST',
      clientUrl(d, 'agreement/escrow'),
    );
    expect(again.body.transactions).toEqual(prep.transactions);

    await send(d, prep.transactions[0].to, prep.transactions[0].data);
    const openHash = await send(
      d,
      prep.transactions[1].to,
      prep.transactions[1].data,
    );
    const funded = await submitFunding(d, openHash);
    expect(funded.status).toBe(200);
    expect(funded.body.status).toBe('FUNDED');
    expect(funded.body.escrow).toMatchObject({
      state: 'FUNDED',
      openTxHash: openHash.toLowerCase(),
      proofLevel: 'LOCAL_FIXTURE',
    });
    expect(await stage(d)).toBe('FUNDED');
    expect(await balance(escrowAddress)).toBeGreaterThanOrEqual(TOTAL);

    // The same submission again is idempotent; a different hash is refused.
    const repeat = await submitFunding(d, openHash);
    expect(repeat.status).toBe(200);
    expect(repeat.body.escrow.escrowDealId).toBe(
      funded.body.escrow.escrowDealId,
    );
    expect(
      (await submitFunding(d, ('0x' + '11'.repeat(32)) as Hex)).status,
    ).toBe(409);

    // The client is not and never became a member.
    const members = await pool.query(
      'SELECT principal_id FROM synq_ws_members WHERE workspace_id=$1',
      [d.workspaceId],
    );
    expect(members.rows.map((r) => r.principal_id)).toEqual([
      d.owner.principalId,
    ]);

    // Agent events: signed is not an on-chain fact; funded is proven from chain.
    const ev = await pool.query(
      'SELECT data FROM synq_agent_events WHERE workspace_id=$1 ORDER BY sequence',
      [d.workspaceId],
    );
    const byKey = Object.fromEntries(
      ev.rows.map((r) => [
        String(r.data.semanticKey).split(':').at(-1),
        r.data,
      ]),
    );
    expect(byKey.signed).toMatchObject({ proofLevel: 'NOT_VERIFIED' });
    expect(byKey.funded).toMatchObject({
      status: 'FINALIZED',
      proofLevel: 'LOCAL_FIXTURE',
      txHash: openHash.toLowerCase(),
    });
    const final = await agreementFor(d);
    // Without a vault the owner's payout wallet is the payee.
    const plain = await signedDeal();
    expect(plain.a.payee).toBe(plain.a.ownerWallet);
    expect(final.status).toBe('FUNDED');
    // The payee is the business vault when it has one.
    expect(final.payee).toBe(d.vault);
  });

  it("shows the agreement only to the lead's own client and to staff", async () => {
    const d = await deal();
    await linkWallet(d);
    const stranger = await login();
    const otherBusiness = await deal();
    const memberOfThis = await login();
    await store.accept(
      memberOfThis.principalId,
      (
        await store.invite(d.workspaceId, d.owner.principalId, {
          role: 'VIEWER',
        })
      ).token,
    );
    // Strangers, another tenant's owner and another lead's client get 404.
    for (const p of [stranger, otherBusiness.owner, otherBusiness.client]) {
      for (const [m, tail] of [
        ['GET', 'agreement'],
        ['POST', 'agreement/escrow'],
      ] as const)
        expect((await call(p, m, clientUrl(d, tail))).status).toBe(404);
      expect((await call(p, 'GET', staffUrl(d, 'agreement'))).status).toBe(404);
    }
    // The business owner is not the client either, and the client is not staff.
    expect((await call(d.owner, 'GET', clientUrl(d, 'agreement'))).status).toBe(
      404,
    );
    expect((await call(d.client, 'GET', staffUrl(d, 'agreement'))).status).toBe(
      404,
    );
    expect(
      (await call(memberOfThis, 'GET', staffUrl(d, 'agreement'))).status,
    ).toBe(404);
    // Another workspace id with this lead id is not found either.
    expect(
      (
        await call(
          otherBusiness.owner,
          'GET',
          `/v3/workspaces/${otherBusiness.workspaceId}/leads/${d.leadId}/agreement`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await call(d.client, 'GET', clientUrl(d, 'agreement'))).status,
    ).toBe(200);
  });

  it('refuses a Telegram-only lead, a member wallet and a wallet that did not sign', async () => {
    const owner = await login();
    const { workspace: w } = await store.create(owner.principalId, {
      displayName: 'Telegram Studio',
      kind: 'BUSINESS',
    });
    const invite = await leads.invite(w.id, owner.principalId, {
      source: 'TELEGRAM',
      expiresInSeconds: 3600,
    });
    const tg = await leads.redeem({
      token: new URL(invite.telegramUrl!).searchParams.get('start')!,
      channel: 'telegram',
      identity: '555',
      deliveryRef: '555',
    });
    const person = await login();
    expect(
      (await call(person, 'GET', `/v3/client/leads/${tg.leadId}/agreement`))
        .status,
    ).toBe(404);

    const d = await deal();
    // A wallet that belongs to the business cannot be the client's.
    const t = await call(
      d.client,
      'GET',
      `${clientUrl(d, 'wallet-link')}?wallet=${d.owner.a.address}`,
    );
    const link = await call(d.client, 'POST', clientUrl(d, 'wallet'), {
      wallet: d.owner.a.address,
      expiresAt: t.body.expiresAt,
      signature: await sign(d.owner.a, t.body.typedData),
    });
    expect(link.status).toBe(422);
    // Naming a wallet the signer does not control is refused.
    const t2 = await call(
      d.client,
      'GET',
      `${clientUrl(d, 'wallet-link')}?wallet=${d.clientWallet.address}`,
    );
    const forged = await call(d.client, 'POST', clientUrl(d, 'wallet'), {
      wallet: d.clientWallet.address,
      expiresAt: t2.body.expiresAt,
      signature: await sign(
        privateKeyToAccount(generatePrivateKey()),
        t2.body.typedData,
      ),
    });
    expect(forged.status).toBe(403);
    // Without a linked wallet there is no agreement to sign.
    const none = await call(d.client, 'GET', clientUrl(d, 'agreement'));
    expect(none.body).toMatchObject({
      clientWallet: null,
      agreement: null,
      blocked: 'CLIENT_WALLET_REQUIRED',
    });
  });

  it('needs both signatures, and only the bound wallets can sign', async () => {
    const d = await deal();
    await linkWallet(d);
    const a = await agreementFor(d);
    const stranger = privateKeyToAccount(generatePrivateKey());
    // A signature from any other wallet, or a client signature on the owner route, is refused.
    expect(
      (
        await call(
          d.client,
          'POST',
          clientUrl(d, 'agreement/signature'),
          submitBody(a, await sign(stranger, a.typedData)),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          d.owner,
          'POST',
          staffUrl(d, 'agreement/owner-signature'),
          submitBody(a, await sign(d.clientWallet, a.typedData)),
        )
      ).status,
    ).toBe(403);
    const first = await call(
      d.client,
      'POST',
      clientUrl(d, 'agreement/signature'),
      submitBody(a, await sign(d.clientWallet, a.typedData)),
    );
    expect(first.body.status).toBe('PENDING_SIGNATURES');
    expect(first.body.signatures.owner).toBeNull();
    expect(await stage(d)).toBe('AGREED_PENDING_SIGNATURES');
    // Not funded or even prepared with one signature.
    expect(
      (await call(d.client, 'POST', clientUrl(d, 'agreement/escrow'))).status,
    ).toBe(409);
    // An admin cannot sign for the owner.
    const admin = await login();
    await store.accept(
      admin.principalId,
      (
        await store.invite(d.workspaceId, d.owner.principalId, {
          role: 'ADMIN',
        })
      ).token,
    );
    expect(
      (
        await call(
          admin,
          'POST',
          staffUrl(d, 'agreement/owner-signature'),
          submitBody(a, await sign(d.owner.a, a.typedData)),
        )
      ).status,
    ).toBe(403);
    expect((await call(admin, 'GET', staffUrl(d, 'agreement'))).status).toBe(
      200,
    );
    const second = await call(
      d.owner,
      'POST',
      staffUrl(d, 'agreement/owner-signature'),
      submitBody(a, await sign(d.owner.a, a.typedData)),
    );
    expect(second.body.status).toBe('SIGNED');
    expect(await stage(d)).toBe('SIGNED');
  });

  it('refuses a signature over a stale or different version', async () => {
    const d = await deal();
    await linkWallet(d);
    const a = await agreementFor(d);
    const sig = await sign(d.clientWallet, a.typedData);
    // A signature that quotes a different version or terms hash.
    expect(
      (
        await call(d.client, 'POST', clientUrl(d, 'agreement/signature'), {
          ...submitBody(a, sig),
          offerVersion: a.offerVersion + 1,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(d.client, 'POST', clientUrl(d, 'agreement/signature'), {
          ...submitBody(a, sig),
          termsHash: '0x' + '22'.repeat(32),
        })
      ).status,
    ).toBe(409);
    // A signature over altered terms recovers another signer.
    const altered = structuredClone(a.typedData);
    altered.message.milestones[0].units = '1';
    expect(
      (
        await call(
          d.client,
          'POST',
          clientUrl(d, 'agreement/signature'),
          submitBody(a, await sign(d.clientWallet, altered)),
        )
      ).status,
    ).toBe(403);
    // A newer offer after acceptance supersedes the agreement: signing the old one is refused.
    const counter = await offers.send({
      workspaceId: d.workspaceId,
      leadId: d.leadId,
      terms: terms({ deliveryDays: 12 }),
      actor: { kind: 'AGENT' },
    });
    expect(counter.sent).toBe(true);
    const stale = await call(
      d.client,
      'POST',
      clientUrl(d, 'agreement/signature'),
      submitBody(a, sig),
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('AGREEMENT_STALE');
    const row = await pool.query(
      'SELECT status FROM synq_agreements WHERE id=$1',
      [a.agreementId],
    );
    expect(row.rows[0].status).toBe('VOID');
  });

  it('invalidates an agreement whose stored terms were altered', async () => {
    const d = await deal();
    await linkWallet(d);
    const a = await agreementFor(d);
    const sig = await sign(d.clientWallet, a.typedData);
    // The database refuses the edit; a privileged edit that bypasses it is still detected.
    await expect(
      pool.query(
        "UPDATE synq_agreements SET fields = jsonb_set(fields,'{totalUnits}','\"1\"') WHERE id=$1",
        [a.agreementId],
      ),
    ).rejects.toThrow(/immutable/);
    const client = await pool.connect();
    try {
      await client.query(
        'ALTER TABLE synq_agreements DISABLE TRIGGER synq_agreement_immutable',
      );
      await client.query(
        `UPDATE synq_agreements SET fields = jsonb_set(fields,'{payee}','"${getAddress(privateKeyToAccount(generatePrivateKey()).address)}"') WHERE id=$1`,
        [a.agreementId],
      );
      await client.query(
        'ALTER TABLE synq_agreements ENABLE TRIGGER synq_agreement_immutable',
      );
    } finally {
      client.release();
    }
    const r = await call(
      d.client,
      'POST',
      clientUrl(d, 'agreement/signature'),
      submitBody(a, sig),
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('AGREEMENT_TERMS_TAMPERED');
    expect(
      (
        await pool.query('SELECT status FROM synq_agreements WHERE id=$1', [
          a.agreementId,
        ])
      ).rows[0].status,
    ).toBe('VOID');
    // The altered agreement is never reused: a fresh one is rebuilt from the
    // immutable offer, with no signatures carried over.
    const view = await call(d.client, 'GET', clientUrl(d, 'agreement'));
    expect(view.body.agreement.agreementId).not.toBe(a.agreementId);
    expect(view.body.agreement.payee).toBe(a.payee);
    expect(view.body.agreement.signatures).toEqual({
      client: null,
      owner: null,
    });
  });

  it('expires an unsigned agreement', async () => {
    const d = await deal();
    await linkWallet(d);
    const a = await agreementFor(d);
    const sig = await sign(d.clientWallet, a.typedData);
    now += 8 * 86400;
    await pool.query(
      'UPDATE synq_ws_sessions SET expires_at = expires_at + $1',
      [10 * 86400],
    );
    try {
      const r = await call(
        d.client,
        'POST',
        clientUrl(d, 'agreement/signature'),
        submitBody(a, sig),
      );
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('AGREEMENT_EXPIRED');
    } finally {
      now -= 8 * 86400;
    }
  });

  it('does not accept escrow funded with the wrong amount, payee or contract, and keeps a pending transaction unfunded', async () => {
    const { d } = await signedDeal();
    const prep = await fund(d);
    // Spare balance so the mismatched opens below can really run on chain.
    await mint(d.clientWallet.address, 4n * TOTAL);
    const [approve, open] = prep.transactions;
    await send(d, approve.to, approve.data);
    // Funding must be prepared and sent first: nothing to submit before that.
    const wrongPayee = (await import('viem')).encodeFunctionData({
      abi: escrowArtifact.abi,
      functionName: 'open',
      args: [
        privateKeyToAccount(generatePrivateKey()).address,
        '0x0000000000000000000000000000000000000000',
        BigInt(now + 90 * 86400),
        ('0x' + 'ab'.repeat(32)) as Hex,
        [30000000n, 65000000n],
      ],
    } as never);
    const wrongAmount = (await import('viem')).encodeFunctionData({
      abi: escrowArtifact.abi,
      functionName: 'open',
      args: [
        getAddress(d.owner.a.address),
        '0x0000000000000000000000000000000000000000',
        BigInt(now + 90 * 86400),
        ('0x' + 'ab'.repeat(32)) as Hex,
        [10000000n, 65000000n],
      ],
    } as never);
    // A transfer of the same token (the shape of a plain payment or a burn) is not an escrow open.
    const plainTransfer = (await import('viem')).encodeFunctionData({
      abi: tokenArtifact.abi,
      functionName: 'transfer',
      args: [getAddress(d.owner.a.address), 1000n],
    } as never);
    const hashes = [
      await send(d, escrowAddress, wrongAmount),
      await send(d, tokenAddress, plainTransfer),
    ];
    for (const h of hashes) {
      const r = await submitFunding(d, h);
      expect(r.status).toBe(422);
      expect(r.body.error).toBe('ESCROW_TX_MISMATCH');
    }
    // The wrong-payee open needs its own allowance; it still never matches.
    await send(d, approve.to, approve.data);
    const payeeHash = await send(d, escrowAddress, wrongPayee);
    expect((await submitFunding(d, payeeHash)).body.error).toBe(
      'ESCROW_TX_MISMATCH',
    );
    expect(await stage(d)).toBe('FUNDING_PENDING');
    expect((await agreementFor(d)).status).toBe('FUNDING_PENDING');
    // An unknown hash is not a funding.
    expect(
      (await submitFunding(d, ('0x' + '33'.repeat(32)) as Hex)).status,
    ).toBe(409);

    // A broadcast but unmined open is only pending.
    await chain.request({
      method: 'evm_setAutomine' as never,
      params: [false] as never,
    });
    let pending: Hex;
    try {
      await send(d, approve.to, approve.data, false);
      pending = await send(d, open.to, open.data, false);
      const early = await submitFunding(d, pending);
      expect(early.status).toBe(200);
      expect(early.body.status).toBe('FUNDING_PENDING');
      expect(early.body.escrow.state).toBe('PENDING_CONFIRMATION');
      expect(await stage(d)).toBe('FUNDING_PENDING');
    } finally {
      await chain.request({
        method: 'evm_setAutomine' as never,
        params: [true] as never,
      });
    }
    await chain.request({ method: 'evm_mine' as never, params: [] as never });
    await chain.waitForTransactionReceipt({ hash: pending! });
    const done = await submitFunding(d, pending!);
    expect(done.body.status).toBe('FUNDED');
    expect(await stage(d)).toBe('FUNDED');
  });

  it('refuses to prepare funding before both signatures, or when the client cannot cover the total', async () => {
    const { d } = await signedDeal();
    // No tokens minted for the client yet.
    const r = await call(d.client, 'POST', clientUrl(d, 'agreement/escrow'));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('INSUFFICIENT_FUNDS');
    expect((await agreementFor(d)).status).toBe('SIGNED');
  });

  it('reports the escrow routes as served only when an escrow is connected', async () => {
    const bare = Fastify();
    const reg = registerAppRoutes(bare, {
      store,
      devices: new WorkspaceDeviceSessions(store),
      leads,
      offers,
      agreements,
    });
    expect(reg.implemented.has('client.leadAgreement')).toBe(true);
    expect(reg.implemented.has('client.leadEscrowCall')).toBe(false);
    expect(reg.implemented.has('client.leadEscrowSubmit')).toBe(false);
    await bare.close();
    expect(app.printRoutes()).toContain('agreement');
  });
});

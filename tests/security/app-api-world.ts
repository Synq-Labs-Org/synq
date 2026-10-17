import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { StructuredReasoner, ReasonerRequest } from '@synq/agent-runtime';
import { PostgresWorkspaceStore } from '../../packages/workspaces/src/postgres.js';
import { loginTypedData } from '../../packages/workspaces/src/contracts.js';
import { WorkspaceDeviceSessions } from '../../packages/workspaces/src/device-sessions.js';
import { WorkspaceLeads } from '../../packages/workspaces/src/leads.js';
import {
  WorkspaceOffers,
  commercialPolicyTypedData,
  type CommercialPolicy,
  type OfferTerms,
} from '../../packages/workspaces/src/offers.js';
import { AgentEvents } from '../../packages/workspaces/src/agent-events.js';
import { WorkspaceNotifications } from '../../packages/workspaces/src/notifications.js';
import { WorkspaceAmane } from '../../packages/workspaces/src/amane.js';
import { AppApprovals } from '../../apps/demo/src/app-approvals.js';
import { registerAppRoutes } from '../../apps/demo/src/app-routes.js';
import { registerWorkspaceRoutes } from '../../apps/demo/src/workspace-routes.js';

/*
 * Shared fixtures for the adversarial app-API suites: a fully wired v3 app on
 * a throwaway schema, wallets that sign in, workspaces with every role, and
 * leads, offers and policies to attack.
 */

export const origin = 'https://synq.test';
export const BASE_CLOCK = 2_000_000_000;

export type Services = {
  store: PostgresWorkspaceStore;
  devices: WorkspaceDeviceSessions;
  leads: WorkspaceLeads;
  offers: WorkspaceOffers;
  events: AgentEvents;
  notifications: WorkspaceNotifications;
  amane: WorkspaceAmane;
  approvals: AppApprovals;
  delivered: { deliveryRef: string; text: string }[];
};

export async function services(
  store: PostgresWorkspaceStore,
  chain: Partial<ConstructorParameters<typeof WorkspaceAmane>[1]> = {},
): Promise<Services> {
  const delivered: Services['delivered'] = [];
  const leads = new WorkspaceLeads(store, {
    webOrigin: origin,
    telegramBot: () => 'asksynqbot',
    deliver: async (t) => {
      delivered.push({ deliveryRef: t.deliveryRef, text: t.text });
    },
  });
  const offers = new WorkspaceOffers(store);
  const events = new AgentEvents(store);
  const notifications = new WorkspaceNotifications(store);
  const unreachable = async () => {
    throw new Error('no chain in this suite');
  };
  const amane = new WorkspaceAmane(store, {
    agent: null,
    accountCodeHash: null,
    readAccount: unreachable,
    readLease: unreachable,
    isController: async () => false,
    ...chain,
  });
  await store.migrate();
  await Promise.all([
    leads.migrate(),
    offers.migrate(),
    events.migrate(),
    notifications.migrate(),
    amane.migrate(),
  ]);
  return {
    store,
    devices: new WorkspaceDeviceSessions(store),
    leads,
    offers,
    events,
    notifications,
    amane,
    approvals: new AppApprovals(store, { offers }),
    delivered,
  };
}

export function buildApp(
  s: Services,
  over: { streamWindowMs?: number; streamPollMs?: number } = {},
): FastifyInstance {
  const app = Fastify();
  registerWorkspaceRoutes(app, s.store);
  registerAppRoutes(app, {
    store: s.store,
    devices: s.devices,
    leads: s.leads,
    offers: s.offers,
    events: s.events,
    notifications: s.notifications,
    amane: s.amane,
    approvals: s.approvals,
    streamWindowMs: over.streamWindowMs ?? 50,
    streamPollMs: over.streamPollMs ?? 10,
  });
  return app;
}

export type Person = {
  a: ReturnType<typeof privateKeyToAccount>;
  principalId: string;
  /** A native bearer token (login challenge audience native). */
  token: string;
};

export async function login(
  store: PostgresWorkspaceStore,
  audience: 'native' | 'web' = 'native',
  a = privateKeyToAccount(generatePrivateKey()),
): Promise<Person> {
  const c = await store.challenge({ wallet: a.address, audience });
  const signature = await a.signTypedData({
    ...loginTypedData(c),
    message: {
      ...loginTypedData(c).message,
      wallet: getAddress(c.wallet),
      expiresAt: BigInt(c.expiresAt),
    },
  });
  const r = await store.login(c.id, signature);
  return { a, principalId: r.principalId, token: r.token };
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
export const cookie = (t: string) => ({ cookie: `__Host-synq_workspace=${t}` });
export const idem = () => ({ 'idempotency-key': randomUUID() });

export const iso = (s: number) => new Date(s * 1000).toISOString();
export const policy = (
  clock: number,
  over: Partial<CommercialPolicy> = {},
): CommercialPolicy => ({
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
  ...over,
});
export const terms = (over: Partial<OfferTerms> = {}): OfferTerms => ({
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

export type Business = {
  owner: Person;
  workspaceId: string;
};

export async function business(
  s: Services,
  owner?: Person,
  name = 'Example Studio',
): Promise<Business> {
  const o = owner ?? (await login(s.store));
  const { workspace } = await s.store.create(o.principalId, {
    displayName: name,
    kind: 'BUSINESS',
  });
  return { owner: o, workspaceId: workspace.id };
}

/** A person who joined the workspace with the given non-owner role. */
export async function joined(
  s: Services,
  b: Business,
  role: 'ADMIN' | 'MEMBER' | 'VIEWER',
): Promise<Person> {
  const p = await login(s.store);
  const invite = await s.store.invite(b.workspaceId, b.owner.principalId, {
    role,
  });
  await s.store.accept(p.principalId, invite.token);
  return p;
}

export async function activePolicy(
  s: Services,
  b: Business,
  clock: number,
  over: Partial<CommercialPolicy> = {},
) {
  const view = await s.offers.proposePolicy(
    b.workspaceId,
    b.owner.principalId,
    policy(clock, over),
  );
  await s.offers.approvePolicy(
    b.workspaceId,
    b.owner.principalId,
    view.version,
    await b.owner.a.signTypedData(
      commercialPolicyTypedData(b.workspaceId, view.version, view.policyHash),
    ),
  );
  return view;
}

export async function telegramLead(
  s: Services,
  b: Business,
  user = String(Math.floor(Math.random() * 1e9)),
) {
  const invite = await s.leads.invite(b.workspaceId, b.owner.principalId, {
    source: 'TELEGRAM',
    expiresInSeconds: 3600,
  });
  const token = new URL(invite.telegramUrl!).searchParams.get('start')!;
  const r = await s.leads.redeem({
    token,
    channel: 'telegram',
    identity: user,
    deliveryRef: user,
  });
  return { token, user, ...r };
}

/** A scripted model: returns the queued decisions in order. */
export function reasoner(
  decisions: unknown[],
): StructuredReasoner & { requests: ReasonerRequest[] } {
  const requests: ReasonerRequest[] = [];
  return {
    provider: 'openai',
    model: 'fixture',
    requests,
    availability: () => ({
      providerId: 'OPENAI',
      installed: true,
      credentialsPresent: true,
      mode: 'REPLAY',
    }),
    complete: async (r) => {
      requests.push(r);
      const d = decisions.shift();
      return {
        text: JSON.stringify(d),
        toolCalls: [],
        inputTokens: 0,
        outputTokens: 0,
        provider: 'openai',
        model: 'fixture',
        mode: 'REPLAY',
        fixtureLabel: 'HAND_AUTHORED_FIXTURE',
        requestHash: `0x${'0'.repeat(64)}`,
        responseHash: `0x${'0'.repeat(64)}`,
        structuredMode: 'JSON_SCHEMA',
      };
    },
  };
}

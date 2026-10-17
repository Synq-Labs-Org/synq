import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { z } from 'zod';
import { NAMED_SCHEMAS, ROUTES, type Route } from '@synq/contracts';
import { componentSchemas } from '../packages/contracts/src/codegen.js';
import { FIXTURES } from '../packages/contracts/src/fixtures.js';

/*
 * Writes the API reference (apps/web/content/docs/api/*.md) from the zod
 * contract: ROUTES, the named schemas and the synthetic fixtures. Pure
 * generation lives in generateApiDocs(); tests/contracts/docs-api.test.ts
 * fails when the committed Markdown differs from it.
 *   corepack pnpm docs:api
 */

type Json = {
  type?: string | string[];
  properties?: Record<string, Json>;
  required?: string[];
  items?: Json;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Json[];
  $ref?: string;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  description?: string;
  additionalProperties?: Json | boolean;
  propertyNames?: Json;
};

const SCHEMAS = componentSchemas() as unknown as Record<string, Json>;
const NAME_OF = new Map<unknown, string>(
  Object.entries(NAMED_SCHEMAS).map(([n, s]) => [s, n]),
);
const slug = (s: string) => s.toLowerCase();
const link = (name: string) => `[${name}](/docs/api/schemas#${slug(name)})`;
const esc = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');

function typeOf(s: Json): string {
  if (s.$ref) return link(s.$ref.split('/').pop()!);
  if (s.anyOf) {
    const parts = s.anyOf.map(typeOf);
    return parts.join(' or ');
  }
  if (s.const !== undefined) return `\`${JSON.stringify(s.const)}\``;
  if (s.enum) return s.enum.map((v) => `\`${String(v)}\``).join(', ');
  if (s.type === 'array')
    return `${s.items ? typeOf(s.items) : 'any'}[]${s.minItems ? ` (min ${s.minItems})` : ''}${s.maxItems ? ` (max ${s.maxItems})` : ''}`;
  if (s.type === 'object') {
    if (s.properties) return 'object';
    if (typeof s.additionalProperties === 'object')
      return `map of ${typeOf(s.additionalProperties)}`;
    return 'object';
  }
  if (s.type === 'string') {
    const bits: string[] = [];
    if (s.format === 'uuid') bits.push('uuid');
    else if (s.format === 'date-time') bits.push('ISO-8601 time');
    else bits.push('string');
    if (s.maxLength !== undefined) bits.push(`max ${s.maxLength}`);
    if (s.minLength) bits.push(`min ${s.minLength}`);
    if (s.format !== 'uuid' && s.format !== 'date-time' && s.pattern) {
      bits.push(s.pattern.length <= 44 ? `\`${s.pattern}\`` : 'pattern');
    }
    return bits.length > 1
      ? `${bits[0]} (${bits.slice(1).join(', ')})`
      : bits[0]!;
  }
  if (s.type === 'integer' || s.type === 'number') {
    const range: string[] = [];
    if (s.minimum !== undefined && Math.abs(s.minimum) < 1e12)
      range.push(`min ${s.minimum}`);
    if (s.maximum !== undefined && Math.abs(s.maximum) < 1e12)
      range.push(`max ${s.maximum}`);
    return range.length ? `${s.type} (${range.join(', ')})` : s.type;
  }
  if (s.type === 'null') return 'null';
  if (Array.isArray(s.type)) return s.type.join(' or ');
  return s.type ?? 'any';
}

function rows(s: Json, prefix: string, out: string[][]): void {
  const props = s.properties ?? {};
  const req = new Set(s.required ?? []);
  for (const [name, p] of Object.entries(props)) {
    const path = `${prefix}${name}`;
    out.push([
      `\`${path}\``,
      esc(typeOf(p)),
      req.has(name) ? 'yes' : 'no',
      esc(p.description ?? ''),
    ]);
    if (p.type === 'object' && p.properties) rows(p, `${path}.`, out);
    if (p.type === 'array' && p.items?.type === 'object' && p.items.properties)
      rows(p.items, `${path}[].`, out);
  }
}

function table(s: Json): string {
  const out: string[][] = [];
  rows(s, '', out);
  if (out.length === 0) {
    if (s.enum) return `Enumeration: ${typeOf(s)}\n`;
    return `${esc(typeOf(s))}\n`;
  }
  return [
    '| Field | Type | Required | Notes |',
    '| --- | --- | --- | --- |',
    ...out.map((r) => `| ${r.join(' | ')} |`),
    '',
  ].join('\n');
}

function resolve(schema: unknown): { name: string | undefined; json: Json } {
  const name = NAME_OF.get(schema);
  if (name) return { name, json: SCHEMAS[name]! };
  return { name: undefined, json: { type: 'object' } };
}

function inlineJson(schema: z.ZodType): Json {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema, {
    unrepresentable: 'any',
  }) as Json & { $schema?: string };
  return rest;
}

const AUTH: Record<string, string> = {
  none: 'None',
  session: 'Session (bearer or cookie)',
  mutation: 'Session + `Idempotency-Key` (+ same origin for cookies)',
};

function exampleOf(name: string | undefined): string {
  if (!name) return '';
  const fx = (FIXTURES as Record<string, unknown>)[name];
  if (fx === undefined) return '';
  return `\n\`\`\`json\n${JSON.stringify(fx, null, 2)}\n\`\`\`\n`;
}

function routeDoc(r: Route): string {
  const L: string[] = [];
  L.push(`### ${r.method} ${r.path}`, '');
  L.push(r.summary, '');
  L.push(
    '| | |',
    '| --- | --- |',
    `| Route id | \`${r.id}\` |`,
    `| Auth | ${AUTH[r.auth]} |`,
    `| Who may call | ${esc(r.roles)} |`,
    `| Status | ${r.status} |`,
    '',
  );
  const params = [...r.path.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]!);
  if (params.length)
    L.push(
      `Path parameters: ${params.map((p) => `\`${p}\``).join(', ')} (UUIDs unless stated).`,
      '',
    );
  if (r.query) {
    L.push('**Query parameters**', '', table(inlineJson(r.query)));
  }
  if (r.request) {
    const q = resolve(r.request);
    L.push(
      `**Request body** ${q.name ? `(${link(q.name)})` : ''}`,
      '',
      table(q.json),
    );
    const ex = exampleOf(q.name);
    if (ex) L.push('Example request body (synthetic):', ex);
  }
  if (r.response === 'text/event-stream') {
    L.push(
      '**Response**: `text/event-stream`. Each event carries a ' +
        `${link('StreamEvent')} as its data line. See [Events](/docs/api/events).`,
      '',
    );
  } else {
    const p = resolve(r.response);
    L.push(
      `**Response** ${p.name ? `(${link(p.name)})` : ''}`,
      '',
      table(p.json),
    );
    const ex = exampleOf(p.name);
    if (ex) L.push('Example response (synthetic fixture):', ex);
  }
  return L.join('\n');
}

type Group = {
  file: string;
  title: string;
  description: string;
  intro: string;
  ids: (r: Route) => boolean;
};

const startsWith =
  (...p: string[]) =>
  (r: Route) =>
    p.some((x) => r.id.startsWith(x));
const oneOf =
  (...ids: string[]) =>
  (r: Route) =>
    ids.includes(r.id);

const GROUPS: Group[] = [
  {
    file: '01-auth',
    title: 'Authentication routes',
    description: 'Device sessions, refresh rotation, session list and logout.',
    intro: `Sign-in itself starts with the \`/v2/auth/challenge\` login challenge (audience \`native\` for the iOS app). The wallet signs the challenge and the client exchanges it here for a device session. Login proves wallet ownership and never approves money.

Each device holds one live session: signing in again from the same \`deviceId\` revokes the previous one. The access token is valid for 15 minutes. The refresh token is valid for 30 days and rotates on every use; presenting a refresh token that was already rotated away revokes the whole device session and answers \`SESSION_REVOKED\`, because someone else may hold a copy.

The unauthenticated routes in this group are throttled per client address (20 requests a minute).

> **Security**
> Tokens are 32 random bytes shown once as 64 hex characters. The server stores only a SHA-256 digest of each token, so a database read cannot replay a session.`,
    ids: startsWith('auth.'),
  },
  {
    file: '02-contexts-personal',
    title: 'Contexts and personal routes',
    description: 'The context switcher, the personal overview and circles.',
    intro: `A principal has one personal context and one business context for every business workspace it belongs to. These routes feed the app's context switcher and the personal home screen. Everything here is read-only.`,
    ids: startsWith('me.', 'personal.'),
  },
  {
    file: '03-workspaces',
    title: 'Workspace routes',
    description:
      'Business overview, agent runs, mandates and commercial policies.',
    intro: `Routes under \`/v3/workspaces/{workspaceId}\` require workspace membership. Someone who is not a member, or who asks for another tenant's id, receives \`404 NOT_FOUND\` rather than \`403\`, so ids do not leak. Workspace routes are throttled to 240 requests a minute per workspace in addition to the per-principal limit.`,
    ids: oneOf(
      'workspace.overview',
      'workspace.agentRuns',
      'workspace.agentRun',
      'workspace.mandates',
      'workspace.mandateRevoke',
      'workspace.commercialPolicies',
      'workspace.commercialPolicyPropose',
    ),
  },
  {
    file: '04-leads-offers',
    title: 'Leads and offers',
    description:
      'Staff inbox, takeover, invitations, offers and policy validation.',
    intro: `A lead is an outside prospect talking to a business through a private link. The sales agent answers while handling is \`AGENT\`; staff can take over (\`HUMAN\`), hand back, freeze offers or escalate. Takeover uses optimistic concurrency: send \`expectedVersion\` and a stale value answers \`409 VERSION_CONFLICT\`. Staff messages and offers are accepted only while handling is \`HUMAN\` (otherwise \`409 TAKEOVER_REQUIRED\`).

Offers are checked by deterministic commercial policy code, never by the model. A send that fails a check returns \`sent: false\` with the failed checks. A send above the owner threshold needs an owner signature from the approvals inbox. Invitation creation is throttled to 30 a minute per workspace; redeeming to 10 a minute per principal.`,
    ids: oneOf(
      'workspace.inbox',
      'workspace.lead',
      'workspace.leadMessage',
      'workspace.leadTakeover',
      'workspace.leadInvite',
      'leadInvite.redeem',
      'workspace.leadOffer',
      'workspace.offerValidate',
    ),
  },
  {
    file: '05-lead-sessions',
    title: 'Lead sessions (client view)',
    description: 'The outside client own view of their conversations.',
    intro: `The outside client is not a workspace member and never gets a workspace route. These routes show a client only the conversations bound to their own verified web identity; anyone else gets \`404\`. Staff-only fields (internal notes, handling version, other leads) are never present. A client message moves no money: the agent replies only while handling is \`AGENT\`. The \`Idempotency-Key\` doubles as the message delivery key, so a retried send is stored once and answered once. Client messages are throttled to 30 a minute per principal.`,
    ids: startsWith('leadSessions.'),
  },
  {
    file: '06-agreements-escrow',
    title: 'Client agreements and escrow',
    description:
      'Wallet linking, agreement signing and funding the milestone escrow.',
    intro: `After a client accepts an offer, both parties sign the exact agreement with their wallets (typed data), then the client funds the escrow by sending the approve and open transactions from their own wallet. The server never holds the client's key. A deal counts as funded only when the open transaction is proven on chain. See [SynqMilestoneEscrow](/docs/contracts) for the contract.

The client wallet is linked by a signature over a statement the server provides. A wallet that already belongs to a workspace member is refused (\`CLIENT_WALLET_IS_MEMBER\`). The two escrow routes are registered only when the escrow is connected and answer \`AGREEMENT_ESCROW_UNAVAILABLE\` (503) otherwise; they are throttled to 30 a minute per principal.`,
    ids: (r) =>
      r.id.startsWith('client.') || r.id.startsWith('workspace.leadAgreement'),
  },
  {
    file: '07-approvals',
    title: 'Approvals',
    description: 'The signing inbox: exact typed data a wallet signs.',
    intro: `Approvals are requests waiting for a wallet signature. The server returns the exact typed data (EIP-712) to sign, the signer address and which contract enforces the result. The signature is verified against the required signer; the app never approves on a login alone. The list is paged with an opaque cursor.`,
    ids: startsWith('approvals.'),
  },
  {
    file: '08-notifications-devices',
    title: 'Notifications and devices',
    description: 'The redacted notification inbox and push device registry.',
    intro: `Notifications are redacted summaries with a deep link; they never carry amounts, counterparties or message text. Only a native device session can register a push token (\`NATIVE_SESSION_REQUIRED\` otherwise). Signing out or revoking a session stops pushes to its devices and skips their queued deliveries.`,
    ids: startsWith('notifications.', 'devices.'),
  },
  {
    file: '09-events',
    title: 'Events',
    description: 'The server-sent event stream and its polling twin.',
    intro: `\`GET /v3/events\` is a server-sent event stream; \`GET /v3/events/since\` returns the same records as a JSON page for clients that cannot hold a connection.

**Stream behaviour** (from the server code):

- The first line is \`retry: 2000\` (the poll interval in milliseconds).
- Each event is written as \`id: <cursor>\`, \`event: <type>\`, \`data: <StreamEvent JSON>\`.
- Start position: the \`cursor\` query parameter, else the \`Last-Event-ID\` header, else the current head (no replay of old events).
- The session is re-checked on every poll. If it ends or the principal loses access, the server sends \`event: CONTEXT_REVOKED\` and closes.
- A \`: keep-alive\` comment is written about every 15 seconds.
- A connection stays open for at most 10 minutes; reconnect with the last cursor.
- Events are filtered to contexts the principal belongs to, and membership is re-checked by each query.

Event types: \`LEAD_UPDATED\`, \`LEAD_MESSAGE\`, \`OFFER_UPDATED\`, \`AGENT_EVENT\`, \`APPROVAL_CHANGED\`, \`BALANCE_CHANGED\`, \`NOTIFICATION\`, \`CONTEXT_REVOKED\`. Cursors are decimal strings and increase monotonically.

\`\`\`text
GET /v3/events?cursor=1042
retry: 2000

id: 1043
event: LEAD_MESSAGE
data: {"cursor":"1043","type":"LEAD_MESSAGE", ...}

: keep-alive
\`\`\``,
    ids: startsWith('events.'),
  },
  {
    file: '10-amane',
    title: 'Amane routes',
    description: 'Registering Amane accounts and leases, and paying jobs.',
    intro: `These routes connect a workspace to an Amane account so that Synq's agent can pay contractors inside an on-chain lease. The server checks the account code and controller on chain before it accepts a registration, and reads each lease back from chain. The routes exist only when the server has an agent key and a pinned account release; otherwise \`GET /v3/workspaces/{workspaceId}/mandates\` reports \`NOT_CONFIGURED\` and the write routes are absent. See [Amane](/docs/amane).`,
    ids: startsWith('workspace.amane'),
  },
];

function indexPage(): string {
  const impl = ROUTES.filter((r) => r.status === 'IMPLEMENTED').length;
  const planned = ROUTES.length - impl;
  const pages = GROUPS.map(
    (g) =>
      `| [${g.title}](/docs/api/${g.file.slice(3)}) | ${ROUTES.filter(g.ids).length} |`,
  );
  return `# API reference

The Synq app API (contract version 3.0.0) is the one backend used by the iOS app, the web hub and the channel bots. This reference is generated from the Zod schemas in \`packages/contracts\`, so it cannot drift from the code. There are ${ROUTES.length} routes: ${impl} marked IMPLEMENTED and ${planned} PLANNED in the contract.

> **Testnet**
> Everything runs on Arc testnet. Mainnet broadcasts are locked off (\`SYNQ_ALLOW_MAINNET_BROADCAST=false\`). No route in this API signs or sends money on its own: money moves only after a wallet signature or an on-chain proof.

## Base URL

Production clients call \`https://synqlabs.world/api/v3/...\`. The web app rewrites \`/api/v3/*\` to the API service's \`/v3/*\`, so the paths in this reference (which start with \`/v3\`) are appended to \`https://synqlabs.world/api\`. The older \`/api/v1\` and \`/api/v2\` paths are rewritten the same way; \`/v2\` still hosts the sign-in challenge.

## Authentication

| Mode | How | Used by |
| --- | --- | --- |
| Native bearer | \`Authorization: Bearer <64 hex chars>\` | iOS app and any client that wants refresh |
| Web cookie | \`__Host-synq_workspace\` cookie, \`Secure\`, host-only | The web hub |

- A native **device session** is created by exchanging a signed login challenge (\`POST /v3/auth/device-session\`) or a one-time code made by a signed-in web session (\`POST /v3/auth/device-session/code\`).
- The access token lives **15 minutes**. The refresh token lives **30 days** and **rotates on every use**.
- Reusing a refresh token that was already rotated **revokes the session** (\`SESSION_REVOKED\`).
- A malformed bearer header is \`401 UNAUTHENTICATED\`. If both a bearer header and a cookie are sent, the bearer header wins. Duplicate cookies are refused.
- Cookie sessions that mutate state must also send an \`Origin\` header equal to the configured web origin, otherwise \`403 ORIGIN_MISMATCH\`. Bearer sessions are not subject to the Origin check, since they are not sent automatically by a browser.
- Auth column in the route tables: **None** (open), **Session** (any valid session), **Session + Idempotency-Key** (a mutation).
- Workspace routes also require membership with the listed role. A non-member, or a request for another tenant's id, gets \`404\`.

## Idempotency

Every mutation under \`/v3\` that requires a session must carry an \`Idempotency-Key\` header containing a UUID. A missing or malformed key is \`400 IDEMPOTENCY_KEY_REQUIRED\`. Lead messages use the key as the delivery key, so a retry with the same key is stored and answered once. Use a fresh key per user action and reuse it only when retrying that same action.

## Rate limits

Limits are fixed one-minute windows stored in Postgres. Exceeding one returns \`429 RATE_LIMITED\`.

| Bucket | Limit per minute |
| --- | --- |
| Unauthenticated auth routes, per client address (hashed) | 20 |
| Each authenticated principal | 120 |
| Each workspace (workspace routes and circles) | 240 |
| Lead invitations, per workspace | 30 |
| Redeeming a lead invite, per principal | 10 |
| Client lead messages, per principal | 30 |
| Escrow prepare and submit, per principal | 30 |

## Errors

Every non-2xx response has the same body, ${link('ApiError')}:

\`\`\`json
{ "error": "VERSION_CONFLICT", "message": "version conflict" }
\`\`\`

\`error\` is a stable machine code; \`message\` is human readable and never contains request data. Responses carry \`cache-control: no-store\`.

| Status | Codes | Meaning |
| --- | --- | --- |
| 400 | \`INVALID_REQUEST\`, \`IDEMPOTENCY_KEY_REQUIRED\`, \`INVALID_CURSOR\`, \`PRIVATE_DATA_REFUSED\` | Body, query or header failed validation |
| 401 | \`UNAUTHENTICATED\`, \`SESSION_REVOKED\`, \`INVALID_NATIVE_CODE\`, \`NATIVE_CHALLENGE_REQUIRED\` | No valid session; refresh, then sign in |
| 403 | \`FORBIDDEN\`, \`ORIGIN_MISMATCH\`, \`OWNER_REQUIRED\`, \`NATIVE_SESSION_REQUIRED\`, signature errors | Authenticated but not allowed, or a signature was not accepted |
| 404 | \`NOT_FOUND\` and entity-specific codes | Missing, or not yours |
| 409 | \`VERSION_CONFLICT\`, \`OFFER_STALE\`, \`TAKEOVER_REQUIRED\`, \`AGREEMENT_ALREADY_FUNDED\` | State changed; reload and retry |
| 422 | \`POLICY_BLOCKED\` family, \`LEASE_NOT_LIVE\`, \`CLIENT_WALLET_IS_MEMBER\` | Understood but refused by policy |
| 429 | \`RATE_LIMITED\` | Slow down |
| 503 | \`NOT_CONFIGURED\`, \`UNSUPPORTED\`, \`AGREEMENT_ESCROW_UNAVAILABLE\`, \`AMANE_NOT_CONFIGURED\` | Feature not available on this server |
| 500 | \`WORKSPACE_UNAVAILABLE\` | Unexpected failure; details are never returned |

A channel-identity or wallet-signature failure surfaces as 403 with the identity error code. The optional \`retryable\` flag tells a client whether retrying can help.

## Status values

Each route in the contract carries a \`status\`. \`IMPLEMENTED\` routes are served. \`PLANNED\` routes are in the contract so clients can build against them but the server does not register them. \`GET /v3/meta\` reports the live status of every route, so a client should hide anything not IMPLEMENTED there. Optional modules (approvals, leads, offers, events, notifications, Amane, agreements) register their routes only when configured, so a route marked IMPLEMENTED in the contract can still report PLANNED from a server without that module.

Responses also use shared vocabularies: ${link('ProofLevel')} (how strongly a fact is proven) and ${link('CapabilityStatus')} (whether a feature can be used). Money is an integer count of token base units in a decimal string, never a float; times are UTC ISO-8601.

## Pagination

List routes take \`cursor\` and \`limit\` (1 to 100) and return \`items\` and \`nextCursor\` (null on the last page). Cursors are opaque; pass them back unchanged.

## Real-time

\`GET /v3/events\` streams server-sent events and \`GET /v3/events/since\` polls the same feed. See [Events](/docs/api/events).

## Pages

| Group | Routes |
| --- | --- |
${pages.join('\n')}
| [Schemas](/docs/api/schemas) | ${Object.keys(NAMED_SCHEMAS).length} |

The machine-readable contract is \`packages/contracts/generated/openapi.json\`.
`;
}

function schemasPage(): string {
  const L = [
    '# Schemas',
    '',
    'Every named wire schema, in contract order. Fields marked required must be present; every object rejects unknown fields.',
    '',
  ];
  for (const name of Object.keys(NAMED_SCHEMAS)) {
    const j = SCHEMAS[name]!;
    L.push(`## ${name}`, '');
    if (j.description) L.push(esc(j.description), '');
    L.push(table(j));
    const ex = exampleOf(name);
    if (ex) L.push('Example (synthetic fixture):', ex);
  }
  return L.join('\n');
}

function frontmatter(title: string, description: string): string {
  return `---\ntitle: ${title}\ndescription: ${description}\n---\n\n`;
}

export async function generateApiDocs(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  files['_section.json'] =
    `${JSON.stringify({ title: 'API reference', order: 60 }, null, 2)}\n`;
  files['00-index.md'] =
    frontmatter(
      'API reference',
      'The Synq v3 app API: authentication, idempotency, errors and every route.',
    ) + indexPage().replace(/^# API reference\n\n/, '');
  const used = new Set<string>();
  for (const g of GROUPS) {
    const rs = ROUTES.filter(g.ids);
    for (const r of rs) used.add(r.id);
    files[`${g.file}.md`] =
      frontmatter(g.title, g.description) +
      `${g.intro}\n\n## Routes\n\n${rs.map(routeDoc).join('\n')}`;
  }
  files['11-schemas.md'] =
    frontmatter('Schemas', 'Every named request and response schema.') +
    schemasPage().replace(/^# Schemas\n\n/, '');
  // Routes not claimed by a group go on the index page, so none is silently dropped.
  const metaRoutes = ROUTES.filter((r) => !used.has(r.id));
  if (metaRoutes.length)
    files['00-index.md'] +=
      `\n## Service routes\n\n${metaRoutes.map(routeDoc).join('\n')}`;
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(files)) {
    if (!name.endsWith('.md')) {
      out[name] = text;
      continue;
    }
    const config = (await resolveConfig(join(root, 'x.md'))) ?? {};
    out[name] = await format(text, { ...config, parser: 'markdown' });
  }
  return out;
}

export const root = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps',
  'web',
  'content',
  'docs',
  'api',
);

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const files = await generateApiDocs();
  mkdirSync(root, { recursive: true });
  for (const f of readdirSync(root)) rmSync(join(root, f));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, name), text);
  console.log(`wrote ${Object.keys(files).length} files to ${root}`);
}

import { randomBytes, randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import pg from 'pg';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { officialAsset } from '@synq/chain-registry';
import type { GrantDraft } from '@synq/schemas';
import {
  PostgresIdentityStore,
  PrincipalService,
  challengeRequestTypedData,
  grantDigest,
  grantTypedData,
  identityChallengeTypedData,
} from '@synq/identity/server';
import { readFileSync } from 'node:fs';
import { API, E2E_ADMIN_TOKEN, E2E_DATABASE_URL, WEB } from './env.js';

const EXECUTION_MODULE = (
  JSON.parse(
    readFileSync(
      new URL('../../contracts/deployments/10143.json', import.meta.url),
      'utf8',
    ),
  ) as { ExecutionModule: string }
).ExecutionModule.toLowerCase() as `0x${string}`;

type Principal = {
  label: string;
  context: BrowserContext;
  page: Page;
  authenticatorId: string;
  principalId: string;
  signer: string;
};
const AUSD = officialAsset('testnetAUSD');
const hex32 = () => `0x${randomBytes(32).toString('hex')}` as const;
const address = () => `0x${randomBytes(20).toString('hex')}` as const;

async function withAuthenticator(browser: Browser) {
  const context = await browser.newContext({ baseURL: WEB });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        hasPrf: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  return { context, page, cdp, authenticatorId };
}

async function api(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  admin = false,
) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(method === 'POST'
        ? {
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
          }
        : {}),
      ...(admin ? { authorization: `Bearer ${E2E_ADMIN_TOKEN}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

test.describe.configure({ mode: 'serial' });
test.describe('three Mera principals on Chromium virtual authenticators (virtual-authenticator tier, not real humans)', () => {
  const principals: Principal[] = [];
  const groupId = hex32();
  const account = address();
  let draft: GrantDraft;

  test.afterAll(async () => {
    for (const p of principals) await p.context.close();
  });

  test('probe: the virtual authenticator exposes WebAuthn PRF', async ({
    browser,
  }, info) => {
    const probe = await withAuthenticator(browser);
    try {
      await probe.page.goto('/');
      const result = await probe.page.evaluate(async () => {
        const salt = new Uint8Array(32).fill(7);
        const created = (await navigator.credentials.create({
          publicKey: {
            rp: { id: location.hostname, name: 'probe' },
            user: {
              id: new Uint8Array(16).fill(1),
              name: 'p',
              displayName: 'p',
            },
            challenge: new Uint8Array(32).fill(2),
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: {
              residentKey: 'required',
              userVerification: 'required',
            },
            extensions: { prf: { eval: { first: salt } } },
          },
        })) as PublicKeyCredential;
        const createPrf = (
          created.getClientExtensionResults() as {
            prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
          }
        ).prf;
        const asserted = (await navigator.credentials.get({
          publicKey: {
            challenge: new Uint8Array(32).fill(3),
            rpId: location.hostname,
            userVerification: 'required',
            allowCredentials: [{ type: 'public-key', id: created.rawId }],
            extensions: { prf: { eval: { first: salt } } },
          },
        })) as PublicKeyCredential;
        const getPrf = (
          asserted.getClientExtensionResults() as {
            prf?: { results?: { first?: ArrayBuffer } };
          }
        ).prf;
        return {
          userAgent: navigator.userAgent,
          createEnabled: createPrf?.enabled ?? null,
          createFirstBytes: createPrf?.results?.first
            ? createPrf.results.first.byteLength
            : 0,
          getFirstBytes: getPrf?.results?.first
            ? getPrf.results.first.byteLength
            : 0,
        };
      });
      info.annotations.push({
        type: 'prf-probe',
        description: JSON.stringify(result),
      });
      console.log(`PRF probe: ${JSON.stringify(result)}`);
      expect(result.createEnabled).toBe(true);
      expect(result.getFirstBytes).toBe(32);
    } finally {
      await probe.context.close();
    }
  });

  test('three separate authenticators enroll through the web app with proof of possession', async ({
    browser,
  }) => {
    for (const label of ['alice', 'bob', 'carol']) {
      const { context, page, authenticatorId, cdp } =
        await withAuthenticator(browser);
      await page.goto('/enroll');
      await page.getByTestId('enroll-name').fill(label);
      await page.getByTestId('enroll-submit').click();
      const result = page.getByTestId('enroll-result');
      await expect(result).toContainText('Enrolled mera:0x', {
        timeout: 30_000,
      });
      const principalId = ((await result.textContent()) ?? '')
        .replace('Enrolled ', '')
        .trim();
      const { credentials } = await cdp.send('WebAuthn.getCredentials', {
        authenticatorId,
      });
      expect(credentials).toHaveLength(1);
      expect(credentials[0]!.isResidentCredential).toBe(true);
      principals.push({
        label,
        context,
        page,
        authenticatorId,
        principalId,
        signer: principalId.slice(5),
      });
    }
    expect(new Set(principals.map((p) => p.signer)).size).toBe(3);
    for (const p of principals) {
      const view = await api(
        'GET',
        `/v1/principals/${encodeURIComponent(p.principalId)}`,
      );
      expect(view.body).toMatchObject({
        kind: 'MERA_HUMAN',
        signer: p.signer,
        rpId: 'localhost',
      });
    }
  });

  test('members join a 2-of-3 group whose owners are the enrolled signers', async () => {
    const created = await api(
      'POST',
      '/v1/groups',
      {
        groupId,
        chainId: 10143,
        account,
        owners: principals.map((p) => p.signer),
        threshold: 2,
      },
      true,
    );
    expect(created.status).toBe(201);
    for (const [i, p] of principals.entries()) {
      await p.page.goto(`/groups/${groupId}/join`);
      await p.page.getByTestId('join-member-id').fill(`member_${i}`);
      await p.page.getByTestId('join-submit').click();
      await expect(p.page.getByTestId('join-result')).toContainText(
        `Joined as member_${i}`,
        { timeout: 30_000 },
      );
    }
    const group = await api('GET', `/v1/groups/${groupId}`);
    expect(group.body.membershipEpoch).toBe(3);
    expect(
      (group.body.memberships as { signer: string }[]).map((m) => m.signer),
    ).toEqual(principals.map((p) => p.signer));
  });

  test('two distinct principals approve the previewed EIP-712 grant; duplicates and operators cannot add quorum', async () => {
    const base: Omit<GrantDraft, 'digest'> = {
      schemaVersion: 1,
      groupId: groupId as GrantDraft['groupId'],
      domain: {
        name: 'SynqExecutionModule',
        version: '1',
        chainId: 10143,
        verifyingContract: EXECUTION_MODULE,
      },
      grant: {
        groupId,
        account,
        mandateId: hex32(),
        mandateVersion: '1',
        executor: address(),
        pluginId: hex32(),
        chainId: '10143',
        target: AUSD.address,
        selector: '0xa9059cbb',
        calldataHash: hex32(),
        token: AUSD.address,
        maxInputAmount: '25000000',
        nativeValue: '0',
        minOutputAmount: '25000000',
        recipient: address(),
        validAfter: '0',
        validUntil: String(Math.floor(Date.now() / 1000) + 3600),
        nonce: '1',
        intentHash: hex32(),
      },
      requiredApprovals: 2,
      createdAt: Math.floor(Date.now() / 1000),
    };
    draft = { ...base, digest: grantDigest({ ...base, digest: hex32() }) };
    expect(
      (await api('POST', '/v1/intents', { draft, asset: AUSD }, true)).status,
    ).toBe(201);

    const approve = async (p: Principal) => {
      await p.page.goto(`/intents/${draft.grant.intentHash}`);
      await expect(p.page.getByTestId('preview-amount')).toHaveText('25 AUSD');
      await expect(p.page.getByTestId('preview-recipient')).toHaveText(
        draft.grant.recipient,
      );
      await expect(p.page.getByTestId('preview-token')).toHaveText(
        AUSD.address,
      );
      await p.page.getByTestId('confirm-preview').check();
      await p.page.getByTestId('approve-submit').click();
    };
    const [alice, bob, carol] = principals as [Principal, Principal, Principal];
    await approve(alice);
    await expect(alice.page.getByTestId('approve-result')).toContainText(
      `Approved by ${alice.signer}`,
      { timeout: 30_000 },
    );
    await expect(alice.page.getByTestId('quorum')).toHaveText(
      '1 of 2 approvals',
    );
    expect(
      (await api('GET', `/v1/intents/${draft.grant.intentHash}`)).body.status,
    ).toBe('PENDING_APPROVAL');

    await approve(alice);
    await expect(alice.page.getByTestId('approve-result')).toContainText(
      'ALREADY_APPROVED',
      { timeout: 30_000 },
    );

    const operatorKey = privateKeyToAccount(generatePrivateKey());
    const pool = new pg.Pool({ connectionString: E2E_DATABASE_URL });
    let operatorPrincipalId = '';
    try {
      const trusted = new PrincipalService(new PostgresIdentityStore(pool), {
        profile: 'sandbox/monad-testnet',
        rpId: 'localhost',
        origin: WEB,
      });
      const challenge = await trusted.issueEnrollmentChallenge({
        kind: 'DYNAMIC_OPERATOR',
        signer: operatorKey.address,
        rpId: 'localhost',
        origin: WEB,
        providerRef: 'e2e-operator-standin',
      });
      const operator = await trusted.enroll({
        challengeId: challenge.challengeId,
        signature: await operatorKey.signTypedData(
          identityChallengeTypedData(challenge),
        ),
      });
      operatorPrincipalId = operator.principalId;
      const bound = await api(
        'POST',
        `/v1/groups/${groupId}/operators`,
        { memberId: 'operator', principalId: operator.principalId },
        true,
      );
      expect(bound.body).toMatchObject({
        role: 'OPERATOR',
        principalKind: 'DYNAMIC_OPERATOR',
      });
    } finally {
      await pool.end();
    }
    const operatorRequest = {
      principalId: operatorPrincipalId,
      memberId: 'operator',
      requestedAt: Math.floor(Date.now() / 1000),
    };
    const operatorChallenge = await api('POST', '/v1/approvals/challenges', {
      ...operatorRequest,
      draftDigest: draft.digest,
      requestSignature: await operatorKey.signTypedData(
        challengeRequestTypedData(draft, operatorRequest),
      ),
    });
    expect(operatorChallenge).toMatchObject({
      status: 403,
      body: { error: 'PRINCIPAL_NOT_ELIGIBLE' },
    });

    await approve(carol);
    await expect(carol.page.getByTestId('approve-result')).toContainText(
      `Approved by ${carol.signer}`,
      { timeout: 30_000 },
    );
    await expect(carol.page.getByTestId('quorum')).toHaveText(
      '2 of 2 approvals — quorum reached',
    );

    const publicQuorum = await api(
      'GET',
      `/v1/approvals/${draft.digest}/quorum`,
    );
    expect(publicQuorum.body.satisfied).toBe(true);
    for (const c of publicQuorum.body.counted as object[])
      expect(c).not.toHaveProperty('signature');
    const quorum = await api(
      'GET',
      `/v1/approvals/${draft.digest}/verified`,
      undefined,
      true,
    );
    expect(quorum.body.satisfied).toBe(true);
    const counted = quorum.body.counted as {
      signer: string;
      signature: Hex;
      principalKind: string;
      memberId: string;
    }[];
    expect(counted.map((c) => c.principalKind)).toEqual([
      'MERA_HUMAN',
      'MERA_HUMAN',
    ]);
    const recovered = await Promise.all(
      counted.map(async (c) =>
        (
          await recoverTypedDataAddress({
            ...grantTypedData(draft),
            signature: c.signature,
          })
        ).toLowerCase(),
      ),
    );
    expect(recovered).toEqual(counted.map((c) => c.signer));
    expect(new Set(recovered)).toEqual(new Set([alice.signer, carol.signer]));
    expect(recovered).not.toContain(bob.signer);
    expect(
      (await api('GET', `/v1/intents/${draft.grant.intentHash}`)).body.status,
    ).toBe('APPROVED');
  });

  test('recovery re-derives the same principal from the same passkey; an unregistered passkey is rejected', async ({
    browser,
  }) => {
    const bob = principals[1]!;
    await bob.page.goto('/');
    await bob.page
      .getByRole('button', { name: 'Forget on this device' })
      .click();
    await bob.page.goto('/recover');
    await bob.page.getByTestId('recover-submit').click();
    await expect(bob.page.getByTestId('recover-result')).toHaveText(
      `Recovered ${bob.principalId} with 1 active membership(s)`,
      { timeout: 30_000 },
    );
    await bob.page.goto('/');
    await expect(bob.page.getByTestId('principal-signer')).toHaveText(
      bob.signer,
    );

    const stranger = await withAuthenticator(browser);
    try {
      await stranger.page.route(
        '**/api/v1/principals/enrollment-challenges',
        (route) => route.abort(),
      );
      await stranger.page.goto('/enroll');
      await stranger.page.getByTestId('enroll-name').fill('stranger');
      await stranger.page.getByTestId('enroll-submit').click();
      await expect(stranger.page.getByTestId('enroll-result')).toBeVisible({
        timeout: 30_000,
      });
      await stranger.page.unroute('**/api/v1/principals/enrollment-challenges');
      const { credentials } = await stranger.cdp.send(
        'WebAuthn.getCredentials',
        { authenticatorId: stranger.authenticatorId },
      );
      expect(credentials).toHaveLength(1);
      await stranger.page.goto('/recover');
      await stranger.page.getByTestId('recover-submit').click();
      await expect(stranger.page.getByTestId('recover-result')).toHaveText(
        /PRINCIPAL_NOT_FOUND/,
        { timeout: 30_000 },
      );
    } finally {
      await stranger.context.close();
    }
  });
});

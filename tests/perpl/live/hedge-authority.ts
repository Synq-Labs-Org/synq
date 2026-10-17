import pg from 'pg';
import type { Mandate } from '@synq/schemas';
import { hedgeIntentHash, type HedgeIntent } from '@synq/kernel';
import { PostgresHedgeStore } from '@synq/perpl-executor';
import {
  GrantApprovalGateway,
  MembershipService,
  PostgresIdentityStore,
  PrincipalService,
  grantPreview,
} from '../../../packages/identity/src/server.js';
import {
  approveGrantWithMera,
  enrollMeraPrincipal,
  signMeraIdentityChallenge,
} from '../../../packages/identity/src/mera-browser.js';
import { DeterministicAuthenticator } from '../../identity/fixtures.js';
import { testnetPerpl } from '../../risk/hedge-fixtures.js';
import { testDatabaseUrl } from '../../durable/pg.js';

// P05 software passkey mechanics for the labelled operator harness. This does
// not assert real human presence or deployed Safe ownership.
export async function liveHedgeAuthority(input: { mandate: Mandate }) {
  const url = testDatabaseUrl(
    'SYNQ_HEDGE_LIVE_DATABASE_URL',
    'synq_resume_p10_live',
  );
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*$/.test(name))
    throw new Error('unsafe live-test DB name');
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  try {
    const r = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [
      name,
    ]);
    if (!r.rows.length) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: url, max: 6 }),
    store = new PostgresHedgeStore(pool),
    identity = new PostgresIdentityStore(pool);
  await store.initialize();
  await identity.migrate();
  const config = {
    profile: 'sandbox/monad-testnet' as const,
    rpId: 'localhost',
    origin: 'http://localhost',
  };
  const principals = new PrincipalService(identity, config),
    membership = new MembershipService(identity, config);
  const humans: {
    auth: DeterministicAuthenticator;
    record: Awaited<ReturnType<typeof enrollMeraPrincipal>>['record'];
  }[] = [];
  for (let i = 0; i < 2; i++) {
    const auth = new DeterministicAuthenticator(
      `perpl-harness-${input.mandate.groupId}-${i}`,
    );
    const result = await enrollMeraPrincipal(
      {
        rpId: config.rpId,
        rpName: 'Synq test harness',
        user: { name: `fixture_${i}`, displayName: `Software fixture ${i}` },
        requestChallenge: ({ signer, credential }) =>
          principals.issueEnrollmentChallenge({
            kind: 'MERA_HUMAN',
            signer,
            credential: {
              ...credential,
              transports: [...(credential.transports ?? [])],
            },
            rpId: config.rpId,
            origin: config.origin,
          }),
      },
      { webAuthnClient: auth },
    );
    await principals.enroll({
      challengeId: result.challenge.challengeId,
      signature: result.signature,
    });
    humans.push({ auth, record: result.record });
  }
  const mandate = {
    ...input.mandate,
    members: humans.map((h, i) => ({
      memberId: `member_${i}` as never,
      signer: h.record.signer,
      active: true,
    })),
  };
  await membership.createGroup({
    groupId: mandate.groupId,
    chainGroupId: mandate.chainGroupId,
    chainId: mandate.network.chainId,
    account: mandate.account,
    owners: humans.map((h) => h.record.signer),
    threshold: 2,
    executors: mandate.operators,
  });
  for (let i = 0; i < humans.length; i++) {
    const h = humans[i]!,
      challenge = await membership.issueJoinChallenge({
        groupId: mandate.groupId,
        memberId: `member_${i}`,
        principalId: h.record.principalId,
      });
    await membership.join({
      groupId: mandate.groupId,
      challengeId: challenge.challengeId,
      signature: await signMeraIdentityChallenge(h.record, challenge, {
        webAuthnClient: h.auth,
      }),
    });
  }
  const approvals = new GrantApprovalGateway(identity, config, {
    executionModules: { [testnetPerpl.chainId]: mandate.account },
  });
  // Each software Mera principal approves the draft the authority registered
  // for this exact hedge, through the P05 challenge flow.
  async function approvePending(intent: HedgeIntent): Promise<string> {
    const hash = hedgeIntentHash(intent);
    for (let attempt = 0; attempt < 600; attempt++) {
      const view = await approvals.pendingIntent(hash).catch(() => null);
      if (view) {
        const draft = view.draft;
        for (let i = 0; i < humans.length; i++) {
          const h = humans[i]!,
            signed = await approveGrantWithMera(
              {
                record: h.record,
                memberId: `member_${i}`,
                draft,
                asset: view.asset,
                confirmedPreview: grantPreview(draft, view.asset),
                requestChallenge: (r) => approvals.issueChallenge(r),
              },
              { webAuthnClient: h.auth },
            );
          await approvals.submit({
            challengeId: signed.challenge.challengeId,
            grantSignature: signed.grantSignature,
            attestationSignature: signed.attestationSignature,
          });
        }
        return draft.digest;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('no approval draft registered for the hedge');
  }
  return {
    pool,
    store,
    approvals,
    mandate,
    approvePending,
    close: () => pool.end(),
    proofMode: 'SOFTWARE_PASSKEY_TEST_HARNESS',
    registeredPrincipals: humans.map((h) => ({
      principalId: h.record.principalId,
      signer: h.record.signer,
    })),
  };
}
